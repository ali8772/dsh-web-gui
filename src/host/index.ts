/**
 * dsh-whale-pet — host half.
 *
 * 大肥鲸桌面宠物的数据服务：在 dsh web server 上注册两条精确路由：
 *
 *   GET /api/whale-pet/health  — 存活检查
 *   GET /api/whale-pet/state   — 余额 + 今日/近7天消费
 *
 * 余额通过凭据服务解析 `DEEPSEEK_API_KEY`（与 llm-deepseek 适配器同一引用），
 * 请求 DeepSeek 官方 `/user/balance`。消费金额有两个来源：
 *   1. official（优先）：配置了 `DEEPSEEK_PLATFORM_TOKEN` 时，查询
 *      platform.deepseek.com 官方逐日消费；
 *   2. estimate（兜底）：回放 `$DSH_HOME/sessions` 下的会话日志，按官方
 *      价格表（峰谷感知）对 token 用量计价 —— 只统计经过 DSH 的调用。
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
  type SessionAggregates,
} from './sessions.ts'
import { fetchPlatformWindow, sumPlatformWindow } from './official.ts'
import { progressForSession } from './tasks.ts'

export const name = 'dsh-whale-pet'
export const inject = ['credentials', 'webServer']

const VERSION = '0.2.0'

const HEALTH_PATH = '/api/whale-pet/health'
const STATE_PATH = '/api/whale-pet/state'
const TASKS_PATH = '/api/whale-pet/tasks'

const PUBLIC_BASE_URL = 'https://api.deepseek.com'
/** 与 llm-deepseek 适配器对齐的环境变量覆盖。 */
const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'
const CREDENTIAL_REF = credentialRef('DEEPSEEK_API_KEY')
/** 可选的平台会话 token（platform.deepseek.com localStorage 的 userToken）。 */
const PLATFORM_TOKEN_REF = credentialRef('DEEPSEEK_PLATFORM_TOKEN')
const BALANCE_PATH = '/user/balance'

const BALANCE_CACHE_MS = 55_000
const SPEND_CACHE_MS = 60_000
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
  readonly today: { amount: number; amountUsd: number | null; calls: number; source: 'official' | 'estimate' }
  readonly days7: { amount: number; amountUsd: number | null; calls: number; source: 'official' | 'estimate' }
  readonly byDay: SessionAggregates['byDay']
  readonly computedAt: number
}

interface SpendMemo {
  at: number
  value: SpendSnapshot
}

let balanceMemo: { at: number; value: BalanceSnapshot | null } | undefined
let spendMemo: SpendMemo | undefined

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

/** 拉取余额（带 55s 内存缓存）。 */
async function fetchBalance(ctx: Context): Promise<BalanceSnapshot | null> {
  if (balanceMemo !== undefined && Date.now() - balanceMemo.at < BALANCE_CACHE_MS) {
    return balanceMemo.value
  }
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
}

/**
 * 计算消费快照：官方优先（平台 token），否则本地估算（会话日志回放）。
 * 结果带 60s 记忆；会话日志本身还有逐会话修订缓存。
 */
async function computeSpend(ctx: Context, nowMs = Date.now()): Promise<SpendSnapshot> {
  if (spendMemo !== undefined && nowMs - spendMemo.at < SPEND_CACHE_MS) {
    return spendMemo.value
  }
  const errors: string[] = []
  const window = spendWindowDays(nowMs, SPEND_WINDOW_DAYS)

  // --- 官方来源（可选） ---
  let official: { today: number; days7: number } | null = null
  try {
    const platformHit = await ctx.credentials.resolve(PLATFORM_TOKEN_REF)
    if (platformHit !== undefined && typeof platformHit.value === 'string' && platformHit.value !== '') {
      const result = await fetchPlatformWindow(platformHit.value, SPEND_WINDOW_DAYS)
      if (result.ok) {
        official = {
          today: sumPlatformWindow(result.days, window.endDay, window.endDay),
          days7: sumPlatformWindow(result.days, window.startDay, window.endDay),
        }
      } else {
        errors.push(result.error ?? 'official unavailable')
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  // --- 本地估算（兜底 / 无平台 token 时的主来源） ---
  let home = ''
  try {
    const homeFn = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
    home = dshHome(typeof homeFn === 'function' ? homeFn : undefined)
  } catch {
    home = dshHome()
  }
  const aggregates = aggregateSessionSpend(home)
  const estimateToday = sumWindow(aggregates.byDay, window.endDay, window.endDay)
  const estimateDays7 = sumWindow(aggregates.byDay, window.startDay, window.endDay)

  const today = official !== null
    ? { amount: official.today, amountUsd: null, calls: estimateToday.calls, source: 'official' as const }
    : { amount: estimateToday.cost, amountUsd: estimateToday.costUsd, calls: estimateToday.calls, source: 'estimate' as const }
  const days7 = official !== null
    ? { amount: official.days7, amountUsd: null, calls: estimateDays7.calls, source: 'official' as const }
    : { amount: estimateDays7.cost, amountUsd: estimateDays7.costUsd, calls: estimateDays7.calls, source: 'estimate' as const }

  const value: SpendSnapshot = {
    today,
    days7,
    byDay: aggregates.byDay,
    computedAt: nowMs,
  }
  spendMemo = { at: nowMs, value }
  return value
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
          const [balance, spend] = await Promise.all([fetchBalance(ctx), computeSpend(ctx)])
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
          let home = ''
          try {
            const homeFn = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined
            home = dshHome(typeof homeFn === 'function' ? homeFn : undefined)
          } catch {
            home = dshHome()
          }
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
