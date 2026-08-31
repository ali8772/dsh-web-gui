/**
 * DSH 会话日志聚合：枚举 `$DSH_HOME/sessions` 下所有持久化会话日志，
 * 回放 `assistant/message` 的 token 用量并按 DeepSeek 官方价格计价，
 * 以北京时间日历日分桶，供「今日消费 / 近 7 天消费」使用。
 *
 * 说明：这是本地估算（estimate），只统计经过 DSH 的调用，与官方账户扣费
 * 记录可能存在出入；配置 `DEEPSEEK_PLATFORM_TOKEN` 后可切换到官方数据。
 *
 * 日志格式：`$DSH_HOME/sessions/<workspace>/<session-id>/session.jsonl(.zstd)`。
 * `.zstd` 为多个可独立解码的 Zstandard frame 拼接（含 torn 尾帧），与
 * `dsh-session-persistence-jsonl` 的容器语义一致。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { createPriceCache, costOf, type PriceAtResult } from './pricing.ts'

const ZSTD_MAGIC = 0xFD2FB528
const DAY_TIMEZONE = 'Asia/Shanghai'

export interface DaySpend {
  /** 该日人民币费用。 */
  readonly cost: number
  /** 该日美元费用。 */
  readonly costUsd: number
  /** 计价的 assistant/message 条数。 */
  readonly calls: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly outputTokens: number
}

export interface SessionAggregates {
  /** 扫描到的会话日志文件数。 */
  readonly sessionsScanned: number
  /** 含可用用量数据的会话数。 */
  readonly sessionsWithUsage: number
  /** 计价请求总数。 */
  readonly calls: number
  /** 北京时间日历日 → 消费汇总。 */
  readonly byDay: Readonly<Record<string, DaySpend>>
}

export interface SpendWindow {
  /** 窗口内人民币费用。 */
  readonly cost: number
  /** 窗口内美元费用。 */
  readonly costUsd: number
  readonly calls: number
  /** 窗口起点（含，北京时间日历日）。 */
  readonly startDay: string
  /** 窗口终点（含，北京时间日历日）。 */
  readonly endDay: string
}

export interface SessionLogMeta {
  readonly id: string
  readonly path: string
}

export interface SessionReader {
  listLogs(): SessionLogMeta[]
  revision(meta: SessionLogMeta): string
  readContent(meta: SessionLogMeta): string | undefined
}

/** 运行时 DSH 主目录：服务 > 环境变量 > 默认。 */
export function dshHome(homeFn?: (sub: string) => string): string {
  if (typeof homeFn === 'function') {
    try {
      return homeFn('')
    } catch {
      // fall through
    }
  }
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function isSessionArtifact(filename: string): boolean {
  return filename === 'session.jsonl' || filename === 'session.jsonl.zstd'
}

/** 递归枚举 `$DSH_HOME/sessions` 下的会话日志文件。 */
export function listSessionLogs(home: string): SessionLogMeta[] {
  const root = join(home, 'sessions')
  const out: SessionLogMeta[] = []
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && isSessionArtifact(entry.name)) {
        out.push({ id: basename(dirname(full)), path: full })
      }
    }
  }
  walk(root)
  // 稳定顺序，避免扫描抖动。
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

/** 文件修订号：mtime+size，用于跳过未变化的日志。 */
export function fileRevision(meta: SessionLogMeta): string {
  try {
    const st = statSync(meta.path)
    return `${st.mtimeMs}\u0000${st.size}`
  } catch {
    return ''
  }
}

interface ZstdFrameRange {
  start: number
  end: number
}

/**
 * 结构扫描：定位可完整解码的 zstd frame（与 dsh-session-persistence-jsonl
 * 的 scanZstdFrames 语义一致；torn 尾帧被跳过，等价于 committed-prefix）。
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) break
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** 读取日志原文（JSONL 文本）：`.zstd` 逐 frame 解压，plaintext 直读。 */
export function readLogContent(meta: SessionLogMeta): string | undefined {
  try {
    const buffer = readFileSync(meta.path)
    if (meta.path.endsWith('.zstd')) {
      const frames = scanZstdFrames(buffer)
      if (frames.length === 0) return undefined
      const parts: Buffer[] = []
      for (const frame of frames) {
        try {
          parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
        } catch {
          // 单个 frame 损坏不阻塞其余内容
        }
      }
      if (parts.length === 0) return undefined
      return Buffer.concat(parts).toString('utf8')
    }
    return buffer.toString('utf8')
  } catch {
    return undefined
  }
}

/** 北京时间日历日 `YYYY-MM-DD`。 */
export function shanghaiDay(timeMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timeMs))
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00'
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** 当日与最近 N 个日历日的窗口边界（含当日，北京时间）。 */
export function spendWindowDays(nowMs: number, days: number): { startDay: string; endDay: string } {
  const endDay = shanghaiDay(nowMs)
  const startDay = shanghaiDay(nowMs - (days - 1) * 86_400_000)
  return { startDay, endDay }
}

interface MutableDaySpend {
  cost: number
  costUsd: number
  calls: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

function emptyDay(): MutableDaySpend {
  return { cost: 0, costUsd: 0, calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
}

interface PricedEvent {
  time: number
  cost: number
  costUsd: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

/**
 * 回放一份会话日志原文：`request/header` 记录当前模型，`assistant/message`
 * 携带的 usage 按官方价格计价。单个坏行/坏事件跳过，不中断整个回放。
 */
export function replayLogContent(content: string, price: (model: string, timeMs: number) => PriceAtResult): PricedEvent[] {
  const out: PricedEvent[] = []
  let currentModel = 'unknown'
  for (const line of content.split('\n')) {
    if (line === '') continue
    let event: Record<string, unknown> | null
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'request/header') {
      try {
        const data = event.data as { header?: { config?: { model?: unknown } } }
        const model = data?.header?.config?.model
        if (typeof model === 'string' && model !== '') currentModel = model
      } catch {
        // 结构异常时沿用上一模型
      }
      continue
    }
    if (event.type !== 'assistant/message') continue
    const data = event.data as { usage?: { inputTokens?: unknown; cacheReadTokens?: unknown; outputTokens?: unknown } } | undefined
    const usage = data?.usage
    if (usage === null || typeof usage !== 'object') continue
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
    const breakdown = costOf(
      {
        inputTokens: toFinite(usage.inputTokens),
        cacheReadTokens: toFinite(usage.cacheReadTokens),
        outputTokens: toFinite(usage.outputTokens),
      },
      price(currentModel, time),
    )
    out.push({
      time,
      cost: breakdown.cost,
      costUsd: breakdown.costUsd,
      inputTokens: breakdown.inputTokens,
      cacheReadTokens: breakdown.cacheReadTokens,
      outputTokens: breakdown.outputTokens,
    })
  }
  return out
}

function toFinite(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

/** 逐会话修订缓存：只有修订变化才重新回放。 */
const logCache = new Map<string, { rev: string; priced: PricedEvent[] }>()

export interface AggregateOptions {
  /** 会话日志枚举器（默认文件系统实现）。 */
  reader?: SessionReader
  /** 聚合窗口内的事件上限，防御异常大日志。 */
  maxEvents?: number
}

/**
 * 聚合全部会话日志为日历日消费（含每会话修订缓存）。
 * 失败会话静默跳过并计数，绝不中断整体结果。
 */
export function aggregateSessionSpend(home: string, options: AggregateOptions = {}): SessionAggregates {
  const reader = options.reader ?? {
    listLogs: () => listSessionLogs(home),
    revision: fileRevision,
    readContent: readLogContent,
  }
  const price = createPriceCache()
  const byDay = new Map<string, MutableDaySpend>()
  const maxEvents = options.maxEvents ?? 200_000
  let sessionsWithUsage = 0
  let calls = 0
  let events = 0
  const logs = reader.listLogs()
  for (const meta of logs) {
    const rev = reader.revision(meta)
    if (rev === '') continue
    let cached = logCache.get(meta.id)
    if (cached === undefined || cached.rev !== rev) {
      const content = reader.readContent(meta)
      if (content === undefined) continue
      const priced = replayLogContent(content, price)
      if (priced.length === 0) continue
      cached = { rev, priced }
      logCache.set(meta.id, cached)
      if (logCache.size > 400) {
        // 防缓存无限增长：清掉最旧的 200 条。
        const keys = [...logCache.keys()]
        for (const key of keys.slice(0, 200)) logCache.delete(key)
      }
    }
    if (cached.priced.length === 0) continue
    sessionsWithUsage += 1
    for (const item of cached.priced) {
      if (events >= maxEvents) break
      events += 1
      calls += 1
      const day = shanghaiDay(item.time)
      let bucket = byDay.get(day)
      if (bucket === undefined) {
        bucket = emptyDay()
        byDay.set(day, bucket)
      }
      bucket.cost += item.cost
      bucket.costUsd += item.costUsd
      bucket.calls += 1
      bucket.inputTokens += item.inputTokens
      bucket.cacheReadTokens += item.cacheReadTokens
      bucket.outputTokens += item.outputTokens
    }
  }
  const sortedDays = [...byDay.keys()].sort()
  const byDayRecord: Record<string, DaySpend> = {}
  for (const day of sortedDays) {
    const b = byDay.get(day)!
    byDayRecord[day] = {
      cost: round2(b.cost),
      costUsd: round2(b.costUsd),
      calls: b.calls,
      inputTokens: b.inputTokens,
      cacheReadTokens: b.cacheReadTokens,
      outputTokens: b.outputTokens,
    }
  }
  return { sessionsScanned: logs.length, sessionsWithUsage, calls, byDay: byDayRecord }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 从日历日汇总里取一个窗口的合计。 */
export function sumWindow(byDay: Readonly<Record<string, DaySpend>>, startDay: string, endDay: string): SpendWindow {
  let cost = 0
  let costUsd = 0
  let calls = 0
  for (const [day, spend] of Object.entries(byDay)) {
    if (day < startDay || day > endDay) continue
    cost += spend.cost
    costUsd += spend.costUsd
    calls += spend.calls
  }
  return { cost: round2(cost), costUsd: round2(costUsd), calls, startDay, endDay }
}
