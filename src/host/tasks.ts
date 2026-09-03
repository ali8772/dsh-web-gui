/**
 * DSH 会话任务进度：按会话日志回放真实进度信号 ——
 *  - `todo/write`：agent 自维护的任务清单（pending/in_progress/completed），
 *    取最新一次快照得到 完成数/总数/当前正在做 ；
 *  - `tool/call` / `step/start` / `turn/start`：当前轮次、步骤与正在执行的工具。
 *  - `approval/asked` / `approval/decided`：进入或离开用户权限审批等待。
 *
 * 性能：会话日志按 zstd frame 追加写入，这里以「帧游标」增量解析 —— 首次
 * 全量回放一次，之后只解压新增帧，轮询开销极小。未变化（mtime+size 相同）
 * 时只做 stat，完全不读文件。
 */

import { readFileSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { createPriceCache } from './pricing.ts'
import {
  fileRevision,
  readLogContent,
  replayLogContent,
  scanZstdFrames,
  type SessionLogMeta,
} from './sessions.ts'

/** 客户端可见的单会话进度快照。 */
export interface TaskProgress {
  readonly id: string
  readonly found: boolean
  /** 最新 todo/write 中的任务总数（0 = 该会话未使用 todo 清单）。 */
  readonly totalTodos: number
  readonly doneTodos: number
  /** 当前 in_progress 的 todo 内容（agent 正在做的事）。 */
  readonly currentTodo: string | null
  /** 完成百分比 0-100；无 todo 清单时为 null。 */
  readonly pct: number | null
  readonly stage: 'tool' | 'thinking' | 'idle'
  /** stage='tool' 时最近一次工具名。 */
  readonly tool: string | null
  readonly turn: number | null
  readonly step: number | null
  /** 日志最后修改时间（ms）。 */
  readonly updatedAt: number | null
  /** 最近一次事件是否需要用户操作（ask_user_question / approval）。 */
  readonly awaitingUser: boolean
}

interface Cursor {
  kind: 'zstd' | 'plain'
  rev: string
  /** 已处理到的完整 frame 数 / 已处理文本字节数。 */
  processedFrames: number
  processedBytes: number
  todoTotal: number
  todoDone: number
  todoCurrent: string | null
  lastTool: { turn: number; step: number; name: string } | null
  lastStep: { turn: number; step: number } | null
  lastTurn: number | null
  lastEventType: string | null
  /** 最近一次事件是否需要用户操作（ask_user_question / approval）。 */
  awaitingUser: boolean
}

/** 我们关心的低流量事件类型；其余（chunk/reasoning 等）只更新 lastEventType。 */
const PARSE_TYPES = new Set([
  'todo/write',
  'tool/call',
  'step/start',
  'turn/start',
  'approval/asked',
  'approval/decided',
])

/** 需要用户交互的工具名：调用这些工具后 agent 会等待用户响应。 */
const USER_AWAITING_TOOLS = new Set([
  'ask_user_question',
])

function freshCursor(kind: 'zstd' | 'plain'): Cursor {
  return {
    kind,
    rev: '',
    processedFrames: 0,
    processedBytes: 0,
    todoTotal: 0,
    todoDone: 0,
    todoCurrent: null,
    lastTool: null,
    lastStep: null,
    lastTurn: null,
    lastEventType: null,
    awaitingUser: false,
  }
}

/** 回放一段日志文本，更新游标信号（行顺序即时间顺序）。 */
function processLogText(text: string, cursor: Cursor): void {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const type = line[0] === '{' ? line.slice(0, 60).match(/^\{?"type":"([^"]+)"/)?.[1] : null
    if (type === undefined || type === null) continue
    cursor.lastEventType = type
    if (!PARSE_TYPES.has(type)) continue
    let event: { type?: string; data?: unknown; time?: unknown }
    try {
      event = JSON.parse(line) as { type?: string; data?: unknown; time?: unknown }
    } catch {
      continue
    }
    if (event.type !== type) continue
    const data = event.data as Record<string, unknown> | null | undefined
    if (type === 'todo/write') {
      const todos = Array.isArray(data?.todos) ? data.todos as Array<Record<string, unknown>> : []
      const done = todos.filter((t) => t.status === 'completed').length
      const current = todos.find((t) => t.status === 'in_progress')
      cursor.todoTotal = todos.length
      cursor.todoDone = done
      cursor.todoCurrent = typeof current?.content === 'string' ? current.content : null
      cursor.awaitingUser = false
    } else if (type === 'tool/call') {
      const turn = toInt(data?.turn)
      const step = toInt(data?.step)
      const name = typeof data?.name === 'string' ? data.name : null
      if (turn !== null && step !== null && name !== null) cursor.lastTool = { turn, step, name }
      cursor.awaitingUser = name !== null && USER_AWAITING_TOOLS.has(name)
    } else if (type === 'step/start') {
      const turn = toInt(data?.turn)
      const step = toInt(data?.step)
      if (turn !== null && step !== null) cursor.lastStep = { turn, step }
      if (turn !== null) cursor.lastTurn = turn
      cursor.awaitingUser = false
    } else if (type === 'turn/start') {
      const turn = toInt(data?.turn)
      if (turn !== null) cursor.lastTurn = turn
      cursor.awaitingUser = false
    } else if (type === 'approval/asked') {
      cursor.awaitingUser = true
    } else if (type === 'approval/decided') {
      // DSH 在用户作出选择后立即追加该事件；不要等后续 step/tool 事件才恢复绿点。
      cursor.awaitingUser = false
    }
  }
}

function toInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/** 增量刷新一个会话的游标；返回是否发生变化。 */
function refreshCursor(meta: SessionLogMeta, cursor: Cursor): boolean {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(meta.path)
  } catch {
    return false
  }
  const rev = `${stat.mtimeMs}\u0000${stat.size}`
  if (cursor.rev !== '' && cursor.rev === rev) return false
  let buffer: Buffer
  try {
    buffer = readFileSync(meta.path)
  } catch {
    return false
  }
  if (meta.path.endsWith('.zstd') && cursor.kind === 'zstd') {
    const frames = scanZstdFrames(buffer)
    if (frames.length < cursor.processedFrames) {
      // 日志被重写（罕见）：整段重放
      cursor.processedFrames = 0
      cursor.todoTotal = 0
      cursor.todoDone = 0
      cursor.todoCurrent = null
      cursor.lastTool = null
      cursor.lastStep = null
      cursor.lastTurn = null
      cursor.lastEventType = null
      cursor.awaitingUser = false
    }
    for (const frame of frames.slice(cursor.processedFrames)) {
      try {
        processLogText(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'), cursor)
      } catch {
        // 单个 frame 损坏不阻塞
      }
    }
    cursor.processedFrames = frames.length
  } else if (!meta.path.endsWith('.zstd') && cursor.kind === 'plain') {
    const text = buffer.toString('utf8')
    const start = Math.min(cursor.processedBytes, text.length)
    if (start < text.length) {
      // 按完整行增量：丢弃可能被截断的半行
      const raw = text.slice(start)
      const nl = raw.lastIndexOf('\n')
      if (nl >= 0) {
        processLogText(raw.slice(0, nl + 1), cursor)
        cursor.processedBytes = start + nl + 1
      }
    }
  } else {
    // 文件格式变化：重置后整段重放
    const fresh = freshCursor(meta.path.endsWith('.zstd') ? 'zstd' : 'plain')
    Object.assign(cursor, fresh)
    return refreshCursor(meta, cursor)
  }
  cursor.rev = rev
  return true
}

const cursors = new Map<string, Cursor>()

/** 计算单个会话的进度快照（带增量游标缓存）。 */
export function progressForSession(logIndex: ReadonlyMap<string, SessionLogMeta>, id: string): TaskProgress {
  const meta = logIndex.get(id)
  if (meta === undefined) {
    cursors.delete(id)
    return { id, found: false, totalTodos: 0, doneTodos: 0, currentTodo: null, pct: null, stage: 'idle', tool: null, turn: null, step: null, updatedAt: null, awaitingUser: false }
  }
  let cursor = cursors.get(id)
  if (cursor === undefined) {
    cursor = freshCursor(meta.path.endsWith('.zstd') ? 'zstd' : 'plain')
    cursors.set(id, cursor)
  }
  refreshCursor(meta, cursor)

  const pct = cursor.todoTotal > 0 ? Math.round((cursor.todoDone / cursor.todoTotal) * 100) : null
  const last = cursor.lastEventType
  const stage = last === 'tool/call' || last === 'tool-call-chunks'
    ? 'tool'
    : last !== null
      ? 'thinking'
      : 'idle'
  const tool = cursor.lastTool !== null ? cursor.lastTool.name : null
  const turn = cursor.lastTool !== null ? cursor.lastTool.turn : cursor.lastTurn
  const step = cursor.lastTool !== null ? cursor.lastTool.step : (cursor.lastStep !== null ? cursor.lastStep.step : null)
  let updatedAt: number | null = null
  try {
    updatedAt = statSync(meta.path).mtimeMs
  } catch {
    // ignore
  }
  return {
    id,
    found: true,
    totalTodos: cursor.todoTotal,
    doneTodos: cursor.todoDone,
    currentTodo: cursor.todoCurrent,
    pct,
    stage,
    tool,
    turn,
    step,
    updatedAt,
    awaitingUser: cursor.awaitingUser,
  }
}

/** 单个模型在某个统计范围内的 token/费用汇总。 */
export interface ModelUsageSummary {
  model: string
  calls: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  cost: number
  costUsd: number
}

/** 单个会话的 token/费用汇总（用于任务完成弹窗）。 */
export interface SessionSummary {
  id: string
  found: boolean
  /** 模型名（取自最新 request/header）。 */
  model: string
  /** 本次对话：计价请求条数（最近一次 user/message 之后的 assistant/message）。 */
  calls: number
  /** 本次对话：输入 tokens。 */
  inputTokens: number
  /** 本次对话：缓存命中 tokens。 */
  cacheReadTokens: number
  /** 本次对话：输出 tokens。 */
  outputTokens: number
  /** 本次对话：估算人民币费用。 */
  cost: number
  /** 本次对话：估算美元费用。 */
  costUsd: number
  /** 本次对话：按实际使用模型分别计价。 */
  models: ModelUsageSummary[]
  /** 会话总计：计价请求条数。 */
  totalCalls: number
  /** 会话总计：输入 tokens。 */
  totalInputTokens: number
  /** 会话总计：缓存命中 tokens。 */
  totalCacheReadTokens: number
  /** 会话总计：输出 tokens。 */
  totalOutputTokens: number
  /** 会话总计：估算人民币费用。 */
  totalCost: number
  /** 会话总计：估算美元费用。 */
  totalCostUsd: number
  /** 会话总计：按实际使用模型分别计价。 */
  totalModels: ModelUsageSummary[]
}

const summaryCache = new Map<string, { rev: string; summary: SessionSummary }>()

type PricedUsage = ReturnType<typeof replayLogContent>[number]

/** 按首次出现顺序聚合模型用量；总费用仍由每条消息当时的历史/峰谷单价累加。 */
function usageByModel(events: readonly PricedUsage[]): ModelUsageSummary[] {
  const grouped = new Map<string, ModelUsageSummary>()
  for (const event of events) {
    let row = grouped.get(event.model)
    if (row === undefined) {
      row = { model: event.model, calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0, costUsd: 0 }
      grouped.set(event.model, row)
    }
    row.calls += 1
    row.inputTokens += event.inputTokens
    row.cacheReadTokens += event.cacheReadTokens
    row.outputTokens += event.outputTokens
    row.cost += event.cost
    row.costUsd += event.costUsd
  }
  return [...grouped.values()].map((row) => ({
    ...row,
    cost: Math.round(row.cost * 100) / 100,
    costUsd: Math.round(row.costUsd * 10000) / 10000,
  }))
}

/** 计算单个会话的 token/费用汇总（带修订缓存）。 */
export function sessionSummary(logIndex: ReadonlyMap<string, SessionLogMeta>, id: string): SessionSummary {
  const meta = logIndex.get(id)
  if (meta === undefined) {
    summaryCache.delete(id)
    return {
      id, found: false, model: 'unknown',
      calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0, costUsd: 0, models: [],
      totalCalls: 0, totalInputTokens: 0, totalCacheReadTokens: 0, totalOutputTokens: 0, totalCost: 0, totalCostUsd: 0, totalModels: [],
    }
  }
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(meta.path)
  } catch {
    return {
      id, found: false, model: 'unknown',
      calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0, costUsd: 0, models: [],
      totalCalls: 0, totalInputTokens: 0, totalCacheReadTokens: 0, totalOutputTokens: 0, totalCost: 0, totalCostUsd: 0, totalModels: [],
    }
  }
  const rev = `${stat.mtimeMs}\u0000${stat.size}`
  const cached = summaryCache.get(id)
  if (cached !== undefined && cached.rev === rev) return cached.summary

  const content = readLogContent(meta)
  if (content === undefined) {
    return {
      id, found: false, model: 'unknown',
      calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0, costUsd: 0, models: [],
      totalCalls: 0, totalInputTokens: 0, totalCacheReadTokens: 0, totalOutputTokens: 0, totalCost: 0, totalCostUsd: 0, totalModels: [],
    }
  }

  // 计算会话总计
  let totalCalls = 0
  let totalInputTokens = 0
  let totalCacheReadTokens = 0
  let totalOutputTokens = 0
  let totalCost = 0
  let totalCostUsd = 0
  const price = createPriceCache()
  const totalEvents = replayLogContent(content, (model, timeMs) => price(model, timeMs))
  for (const event of totalEvents) {
    totalCalls += 1
    totalInputTokens += event.inputTokens
    totalCacheReadTokens += event.cacheReadTokens
    totalOutputTokens += event.outputTokens
    totalCost += event.cost
    totalCostUsd += event.costUsd
  }

  // 计算本次对话（最近一次 user/message 之后）
  let model = 'unknown'
  let modelAtLastUser = 'unknown'
  let lastUserMessageIndex = -1
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') continue
    try {
      const event = JSON.parse(line) as { type?: string; data?: { header?: { config?: { model?: unknown } } } }
      if (event.type === 'request/header') {
        const m = event.data?.header?.config?.model
        if (typeof m === 'string' && m !== '') model = m
      }
      if (event.type === 'user/message') {
        lastUserMessageIndex = i
        modelAtLastUser = model
      }
    } catch {
      // skip
    }
  }

  let calls = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  let cost = 0
  let costUsd = 0
  let currentEvents: PricedUsage[]
  if (lastUserMessageIndex >= 0) {
    // 切片后的 replay 看不到更早的 request/header，补一条边界模型头避免按 unknown 兜底计价。
    const modelHeader = JSON.stringify({ type: 'request/header', data: { header: { config: { model: modelAtLastUser } } } })
    const contentAfter = `${modelHeader}\n${lines.slice(lastUserMessageIndex).join('\n')}`
    currentEvents = replayLogContent(contentAfter, (m, t) => price(m, t))
    for (const event of currentEvents) {
      calls += 1
      inputTokens += event.inputTokens
      cacheReadTokens += event.cacheReadTokens
      outputTokens += event.outputTokens
      cost += event.cost
      costUsd += event.costUsd
    }
  } else {
    currentEvents = totalEvents
    calls = totalCalls
    inputTokens = totalInputTokens
    cacheReadTokens = totalCacheReadTokens
    outputTokens = totalOutputTokens
    cost = totalCost
    costUsd = totalCostUsd
  }

  const summary: SessionSummary = {
    id,
    found: totalCalls > 0,
    model,
    calls,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    cost: Math.round(cost * 100) / 100,
    costUsd: Math.round(costUsd * 10000) / 10000,
    models: usageByModel(currentEvents),
    totalCalls,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    totalCost: Math.round(totalCost * 100) / 100,
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    totalModels: usageByModel(totalEvents),
  }
  summaryCache.set(id, { rev, summary })
  if (summaryCache.size > 400) {
    const keys = [...summaryCache.keys()]
    for (const key of keys.slice(0, 200)) summaryCache.delete(key)
  }
  return summary
}
