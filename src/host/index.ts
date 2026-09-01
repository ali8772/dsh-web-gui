/**
 * dsh-whale-pet — host half.
 *
 * 大肥鲸桌面宠物的数据服务：在 dsh web server 上注册两条精确路由：
 *
 *   GET /api/whale-pet/health  — 存活检查
 *   GET /api/whale-pet/state   — 余额 + 今日/近7天消费
 *
 * 余额通过凭据服务解析 `DEEPSEEK_API_KEY`（与 llm-deepseek 适配器同一引用），
 * 请求 DeepSeek 官方 `/user/balance`。消费金额以相邻余额快照的下降值为准：
 * 首次观察建立基线，后续下降按北京时间记入当日；充值导致的余额上升只更新
 * 基线，不抵扣既有消费。会话日志仅用于补充调用次数和任务进度。
 * API Key 永不出宿主：浏览器只访问这些本地路由。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import {
  aggregateSessionSpend,
  dshHome,
  listSessionLogs,
  spendWindowDays,
  sumWindow,
} from './sessions.ts'
import { observeBalanceSpend } from './balance-spend.ts'
import { progressForSession } from './tasks.ts'

export const name = 'dsh-whale-pet'
export const inject = ['credentials', 'webServer']

const VERSION = '0.2.1'

const HEALTH_PATH = '/api/whale-pet/health'
const STATE_PATH = '/api/whale-pet/state'
const TASKS_PATH = '/api/whale-pet/tasks'

const PUBLIC_BASE_URL = 'https://api.deepseek.com'
/** 与 llm-deepseek 适配器对齐的环境变量覆盖。 */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
const CREDENTIAL_REF = credentialRef('DEEPSEEK_API_KEY')
const BALANCE_PATH = '/user/balance'

const BALANCE_CACHE_MS = 55_000
const FETCH_TIMEOUT_MS = 15_000
/** 「近 7 天」= 今日 + 前 6 个日历日（北京时间）。 */
const SPEND_WINDOW_DAYS = 7

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

interface BalanceSnapshot {
  readonly available: boolean
  readonly currency: string
  readonly totalBalance: number | null
  readonly grantedBalance: number | null
  readonly toppedUpBalance: number | null
  /** 多币种明细（原样数值化）。 */
  readonly infos: ReadonlyArray<{
    readonly currency: string
    readonly totalBalance: number | null
    readonly grantedBalance: number | null
    readonly toppedUpBalance: number | null
  }>
  readonly fetchedAt: number
}

interface SpendSnapshot {
  readonly today: { amount: number; amountUsd: null; calls: number; source: 'balance' }
  readonly days7: { amount: number; amountUsd: null; calls: number; source: 'balance' }
  readonly byDay: Readonly<Record<string, number>>
  readonly computedAt: number
}

let balanceMemo: { at: number; value: BalanceSnapshot | null } | undefined
/** 进行中的余额请求：并发 /state 共享同一次抓取，避免乱序观察。 */
let balanceInFlight: Promise<BalanceSnapshot | null> | undefined

function balanceUrl(): string {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL
  return `${base.replace(/\/+$/, '')}${BALANCE_PATH}`
}

function sendJson(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** 读取 JSON 请求体；空体或坏体返回 `{}`。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Buffer))
    if (chunks.reduce((sum, c) => sum + c.length, 0) > 1024 * 1024) break
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 解析 DeepSeek `/user/balance` 响应。 */
function parseBalanceBody(body: unknown, fetchedAt: number): BalanceSnapshot | null {
  if (body === null || typeof body !== 'object') return null
  const record = body as { is_available?: unknown; balance_infos?: unknown }
  const infos = Array.isArray(record.balance_infos)
    ? record.balance_infos
        .filter((info): info is Record<string, unknown> => info !== null && typeof info === 'object')
        .map((info) => ({
          currency: typeof info.currency === 'string' ? info.currency : 'CNY',
          totalBalance: toFiniteNumber(info.total_balance),
          grantedBalance: toFiniteNumber(info.granted_balance),
          toppedUpBalance: toFiniteNumber(info.topped_up_balance),
        }))
    : []
  if (infos.length === 0) return null
  const primary = infos.find((info) => info.currency === 'CNY') ?? infos[0]!
  return {
    available: record.is_available !== false,
    currency: primary.currency,
    totalBalance: primary.totalBalance,
    grantedBalance: primary.grantedBalance,
    toppedUpBalance: primary.toppedUpBalance,
    infos,
    fetchedAt,
  }
}

/**
 * 拉取余额（带 55s 内存缓存；并发请求合并为同一次抓取）。
 * 成功时总是返回余额快照，失败返回 null 并缓存短暂不可用。
 */
async function fetchBalance(ctx: Context): Promise<BalanceSnapshot | null> {
  if (balanceMemo !== undefined && Date.now() - balanceMemo.at < BALANCE_CACHE_MS) {
    return balanceMemo.value
  }
  if (balanceInFlight !== undefined) return balanceInFlight
  balanceInFlight = (async (): Promise<BalanceSnapshot | null> => {
    let snapshot: BalanceSnapshot | null = null
    try {
      const hit = await ctx.credentials.resolve(CREDENTIAL_REF)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') {
        const response = await fetch(balanceUrl(), {
          headers: {
            Authorization: `Bearer ${hit.value}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (response.ok) {
          snapshot = parseBalanceBody(await response.json(), Date.now())
        }
      }
    } catch {
      // 网络或解析失败 → null，客户端显示余额不可用
    }
    balanceMemo = { at: Date.now(), value: snapshot }
    return snapshot
  })()
  try {
    return await balanceInFlight
  } finally {
    balanceInFlight = undefined
  }
}

/** 解析宿主 DSH 主目录。 */
function resolveDshHome(ctx: Context): string {
  try {
    const homeFn = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
    return dshHome(typeof homeFn === 'function' ? homeFn : undefined)
  } catch {
    return dshHome()
  }
}

/**
 * 以余额观察账本生成消费快照。会话日志只提供调用次数，不参与金额计算。
 * 每个成功余额观察都会立即写入账本；不再使用消费缓存，避免吞掉新余额或
 * 跨北京时间午夜后仍返回昨天的「今日」。
 */
function computeSpend(ctx: Context, balance: BalanceSnapshot | null, nowMs = Date.now()): SpendSnapshot {
  const home = resolveDshHome(ctx)
  const ledger = observeBalanceSpend(
    home,
    balance?.totalBalance === null || balance === null
      ? null
      : { currency: balance.currency, totalBalance: balance.totalBalance },
    nowMs,
  )
  const aggregates = aggregateSessionSpend(home)
  const window = spendWindowDays(nowMs, SPEND_WINDOW_DAYS)
  const todayCalls = sumWindow(aggregates.byDay, window.endDay, window.endDay).calls
  const days7Calls = sumWindow(aggregates.byDay, window.startDay, window.endDay).calls
  return {
    today: { amount: ledger.today, amountUsd: null, calls: todayCalls, source: 'balance' },
    days7: { amount: ledger.days7, amountUsd: null, calls: days7Calls, source: 'balance' },
    byDay: ledger.byDay,
    computedAt: nowMs,
  }
}

/** Cordis 插件体。 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: HEALTH_PATH,
      handler: (_req, res) => {
        sendJson(res, 200, { plugin: name, version: VERSION, ok: true })
      },
    }),
    'dsh-whale-pet: health route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (_req, res) => {
        try {
          // 消费依赖本次余额观察，必须顺序执行，不能与余额请求并行。
          const balance = await fetchBalance(ctx)
          const spend = computeSpend(ctx, balance)
          sendJson(res, 200, {
            ok: true,
            fetchedAt: Date.now(),
            balance,
            spend,
          })
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: state route failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    'dsh-whale-pet: state route',
  )

  // 真实任务进度：POST { ids: string[] } → 每会话 { totalTodos, doneTodos, pct, stage, tool, turn, step }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: TASKS_PATH,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const rawIds = Array.isArray(body.ids) ? body.ids : []
          const ids = rawIds.filter((id): id is string => typeof id === 'string')
          const home = resolveDshHome(ctx)
          const logs = listSessionLogs(home)
          const index = new Map(logs.map((meta) => [meta.id, meta]))
          const tasks = ids.map((id) => progressForSession(index, id))
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), tasks })
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: tasks route failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    'dsh-whale-pet: tasks route',
  )
}
