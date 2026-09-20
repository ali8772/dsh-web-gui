/**
 * dsh-whale-pet — host half.
 *
 * 大肥鲸桌面宠物的数据服务：在 dsh web server 上注册精确路由：
 *
 *   GET /api/whale-pet/health       — 存活检查
 *   GET /api/whale-pet/state        — 余额 + 今日/近7天消费
 *   GET /api/whale-pet/opencode-go  — OpenCode Go 套餐额度（5 小时/7 天/1 个月）
 *
 * 余额通过凭据服务解析 `DEEPSEEK_API_KEY`（与 llm-deepseek 适配器同一引用），
 * 请求 DeepSeek 官方 `/user/balance`。消费金额以相邻余额快照的下降值为准：
 * 首次观察建立基线，后续下降按北京时间记入当日；充值导致的余额上升只更新
 * 基线，不抵扣既有消费。会话日志仅用于补充调用次数和任务进度，并兼容当前 DSH 的
 * `session.v3.jsonl(.zstd)` 持久化文件。
 * OpenCode Go 额度由官方网关 `https://opencode.ai/zen/go/v1/usage` 提供，
 * 凭证优先 `OPENCODE_GO_API_KEY`，回退 opencode CLI 登录文件；密钥不出宿主。
 * API Key 永不出宿主：浏览器只访问这些本地路由。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  aggregateSessionSpend,
  dshHome,
  spendWindowDays,
  sumWindow,
} from './sessions.ts'
import { observeBalanceSpend } from './balance-spend.ts'
import { fetchOpenCodeGoUsage } from './opencode.ts'
import { progressForSession, sessionSummary } from './tasks.ts'
import { createSessionProjection } from './session-projection.ts'
import { createPricingManager, type PricingManager } from './pricing-catalog.ts'
import {
  createCompanionGrants,
  isCompanionLoopback,
  isTrustedCompanionRequest,
} from './companion-grants.ts'
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_SESSION_ID_LENGTH,
  MAX_TASK_IDS,
  WHALE_PET_PATHS,
} from '../shared/contract.ts'

/** Live2D 浏览器资产：与宿主 index.js 同目录，由 DSH 本地路由提供。 */
const LIVE2D_CHUNK_PATH = fileURLToPath(new URL('./live2d.js', import.meta.url))
const LIVE2D_ZIP_WORKER_PATH = fileURLToPath(new URL('./live2d-zip-worker.js', import.meta.url))
const CUBISM_CORE_PATH = fileURLToPath(new URL('./live2dcubismcore.min.js', import.meta.url))
const IMMUTABLE_JS_HEADERS = {
  'content-type': 'application/javascript; charset=utf-8',
  'cache-control': 'public, max-age=31536000, immutable',
}

export const name = 'dsh-whale-pet'
export const inject = ['credentials', 'webServer', 'connection']

const VERSION = '0.4.1'

const {
  health: HEALTH_PATH,
  state: STATE_PATH,
  tasks: TASKS_PATH,
  taskSummary: TASK_SUMMARY_PATH,
  openCodeGo: OPENCODE_GO_PATH,
} = WHALE_PET_PATHS

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

/** 让私有 Web 路由复用 DSH 的 Host/Origin fence 与浏览器会话认证。 */
function rejectPrivateRequest(
  ctx: Context,
  req: IncomingMessage,
  res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void },
): boolean {
  const status = ctx.connection.requestRejection(req)
  if (status === undefined) return false
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  })
  res.end(status === 401 ? 'unauthorized' : 'forbidden')
  return true
}

class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413, readonly code: 'bad-json' | 'payload-too-large', message: string) {
    super(message)
  }
}

/** 读取一个有界 JSON object；格式与大小错误由路由映射为稳定 400/413。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Buffer)
    size += bytes.length
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyError(413, 'payload-too-large', 'request body exceeds 64 KiB')
    }
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
  } catch {
    throw new RequestBodyError(400, 'bad-json', 'request body must be valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestBodyError(400, 'bad-json', 'request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function sendRequestError(
  res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void },
  error: unknown,
): boolean {
  if (!(error instanceof RequestBodyError)) return false
  sendJson(res, error.status, { ok: false, error: error.code, message: error.message })
  return true
}

const INVALID_TASK_IDS = `ids must contain at most ${MAX_TASK_IDS} unique session ids of at most ${MAX_SESSION_ID_LENGTH} characters`

function parseTaskIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids: string[] = []
  const seen = new Set<string>()
  for (const valueId of value) {
    if (typeof valueId !== 'string' || valueId.length === 0 || valueId.length > MAX_SESSION_ID_LENGTH) return undefined
    if (seen.has(valueId)) continue
    seen.add(valueId)
    ids.push(valueId)
    if (ids.length > MAX_TASK_IDS) return undefined
  }
  return ids
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
function computeSpend(ctx: Context, balance: BalanceSnapshot | null, pricing: PricingManager, nowMs = Date.now()): SpendSnapshot {
  const home = resolveDshHome(ctx)
  const ledger = observeBalanceSpend(
    home,
    balance?.totalBalance === null || balance === null
      ? null
      : { currency: balance.currency, totalBalance: balance.totalBalance },
    nowMs,
  )
  const aggregates = aggregateSessionSpend(home, { pricing: pricing.snapshot() })
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
  const companionGrants = createCompanionGrants(ctx.credentials)
  const sessions = createSessionProjection()
  const pricing = createPricingManager({ home: resolveDshHome(ctx) })
  void pricing.refresh().catch(() => {})

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
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return
        try {
          // 消费依赖本次余额观察，必须顺序执行，不能与余额请求并行。
          const balance = await fetchBalance(ctx)
          const spend = computeSpend(ctx, balance, pricing)
          sendJson(res, 200, {
            ok: true,
            fetchedAt: Date.now(),
            balance,
            spend,
          })
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: state route failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
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
        if (rejectPrivateRequest(ctx, req, res)) return
        try {
          const body = await readJsonBody(req)
          const ids = parseTaskIds(body.ids)
          if (ids === undefined) {
            sendJson(res, 400, { ok: false, error: 'bad-request', message: INVALID_TASK_IDS })
            return
          }
          const home = resolveDshHome(ctx)
          const index = sessions.index(home)
          const tasks = ids.map((id) => {
            try {
              return progressForSession(index, id)
            } catch (error) {
              ctx.logger?.warn?.(`dsh-whale-pet: session progress failed for ${id}`)
              ctx.logger?.warn?.(error)
              return { id, found: false, errorCode: 'session-log-corrupt' as const }
            }
          })
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), tasks })
        } catch (error) {
          if (sendRequestError(res, error)) return
          ctx.logger?.warn?.('dsh-whale-pet: tasks route failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: tasks route',
  )

  // 任务完成汇总：POST { id: string } → 单会话 token/费用汇总
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: TASK_SUMMARY_PATH,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return
        try {
          const body = await readJsonBody(req)
          const id = typeof body.id === 'string' && body.id.length > 0 && body.id.length <= MAX_SESSION_ID_LENGTH ? body.id : ''
          if (id === '') {
            sendJson(res, 400, { ok: false, error: 'bad-request', message: `id must be a non-empty session id of at most ${MAX_SESSION_ID_LENGTH} characters` })
            return
          }
          const home = resolveDshHome(ctx)
          const index = sessions.index(home)
          const summary = sessionSummary(index, id, { pricing: pricing.snapshot() })
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), summary })
        } catch (error) {
          if (sendRequestError(res, error)) return
          ctx.logger?.warn?.('dsh-whale-pet: task-summary route failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: task-summary route',
  )

  // OpenCode Go 套餐额度：GET → { ok, fetchedAt, usage }（凭证与网关请求全部留在宿主）
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: OPENCODE_GO_PATH,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return
        try {
          const usage = await fetchOpenCodeGoUsage()
          sendJson(res, 200, { ok: true, fetchedAt: usage.fetchedAt, usage })
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: opencode-go route failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: opencode-go route',
  )

  // 已认证浏览器管理桌面伴侣 grants。令牌明文只在 issue 响应出现一次。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.companions,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'bad-request', message: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, { ok: true, grants: await companionGrants.list() })
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: companion list failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: companion list route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.companionIssue,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'bad-request', message: 'method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const label = typeof body.label === 'string' ? body.label : ''
          const issued = await companionGrants.issue(label)
          sendJson(res, 201, { ok: true, ...issued })
        } catch (error) {
          if (sendRequestError(res, error)) return
          if (error instanceof Error && error.message === 'companion label must be 1-80 characters') {
            sendJson(res, 400, { ok: false, error: 'bad-request', message: error.message })
            return
          }
          ctx.logger?.warn?.('dsh-whale-pet: companion issue failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: companion issue route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.companionRevoke,
      handler: async (req, res) => {
        if (rejectPrivateRequest(ctx, req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'bad-request', message: 'method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const id = typeof body.id === 'string' ? body.id : ''
          if (id === '') {
            sendJson(res, 400, { ok: false, error: 'bad-request', message: 'id is required' })
            return
          }
          sendJson(res, 200, { ok: true, revoked: await companionGrants.revoke(id) })
        } catch (error) {
          if (sendRequestError(res, error)) return
          ctx.logger?.warn?.('dsh-whale-pet: companion revoke failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: companion revoke route',
  )

  const rejectCompanion = async (req: IncomingMessage, res: Parameters<typeof sendJson>[0]): Promise<boolean> => {
    if (!isCompanionLoopback(req.socket.remoteAddress) || !isTrustedCompanionRequest(req.headers)) {
      sendJson(res, 403, { ok: false, error: 'forbidden', message: 'forbidden' })
      return true
    }
    try {
      const authorization = req.headers.authorization
      if (await companionGrants.authenticate(req.socket.remoteAddress, authorization) !== null) return false
      sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'unauthorized' })
      return true
    } catch (error) {
      ctx.logger?.warn?.('dsh-whale-pet: companion credential record failed')
      ctx.logger?.warn?.(error)
      sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
      return true
    }
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.companionState,
      handler: async (req, res) => {
        if (await rejectCompanion(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'bad-request', message: 'method not allowed' })
          return
        }
        try {
          const balance = await fetchBalance(ctx)
          const spend = computeSpend(ctx, balance, pricing)
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), balance, spend })
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: companion state failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: companion state route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.companionTasks,
      handler: async (req, res) => {
        if (await rejectCompanion(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'bad-request', message: 'method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const ids = parseTaskIds(body.ids)
          if (ids === undefined) {
            sendJson(res, 400, { ok: false, error: 'bad-request', message: INVALID_TASK_IDS })
            return
          }
          const index = sessions.index(resolveDshHome(ctx))
          const tasks = ids.map((id) => {
            try {
              return progressForSession(index, id)
            } catch (error) {
              ctx.logger?.warn?.(`dsh-whale-pet: companion session progress failed for ${id}`)
              ctx.logger?.warn?.(error)
              return { id, found: false, errorCode: 'session-log-corrupt' as const }
            }
          })
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), tasks })
        } catch (error) {
          if (sendRequestError(res, error)) return
          ctx.logger?.warn?.('dsh-whale-pet: companion tasks failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: companion tasks route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.companionTaskSummary,
      handler: async (req, res) => {
        if (await rejectCompanion(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'bad-request', message: 'method not allowed' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const id = typeof body.id === 'string' && body.id.length > 0 && body.id.length <= MAX_SESSION_ID_LENGTH ? body.id : ''
          if (id === '') {
            sendJson(res, 400, { ok: false, error: 'bad-request', message: `id must be a non-empty session id of at most ${MAX_SESSION_ID_LENGTH} characters` })
            return
          }
          const index = sessions.index(resolveDshHome(ctx))
          sendJson(res, 200, { ok: true, fetchedAt: Date.now(), summary: sessionSummary(index, id, { pricing: pricing.snapshot() }) })
        } catch (error) {
          if (sendRequestError(res, error)) return
          ctx.logger?.warn?.('dsh-whale-pet: companion task summary failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: companion task summary route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.companionOpenCodeGo,
      handler: async (req, res) => {
        if (await rejectCompanion(req, res)) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'bad-request', message: 'method not allowed' })
          return
        }
        try {
          const usage = await fetchOpenCodeGoUsage()
          sendJson(res, 200, { ok: true, fetchedAt: usage.fetchedAt, usage })
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: companion opencode-go failed')
          ctx.logger?.warn?.(error)
          sendJson(res, 500, { ok: false, error: 'internal', message: 'internal error' })
        }
      },
    }),
    'dsh-whale-pet: companion opencode-go route',
  )

  // Live2D 动态 chunk（pixi + 渲染器，仅配置模型后浏览器动态加载）。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.live2d,
      handler: (_req, res) => {
        try {
          const code = readFileSync(LIVE2D_CHUNK_PATH, 'utf8')
          res.writeHead(200, IMMUTABLE_JS_HEADERS)
          res.end(code)
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: live2d chunk missing')
          ctx.logger?.warn?.(error)
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('live2d chunk not found')
        }
      },
    }),
    'dsh-whale-pet: live2d chunk route',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.live2dZipWorker,
      handler: (_req, res) => {
        try {
          const code = readFileSync(LIVE2D_ZIP_WORKER_PATH, 'utf8')
          res.writeHead(200, IMMUTABLE_JS_HEADERS)
          res.end(code)
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: Live2D ZIP Worker missing')
          ctx.logger?.warn?.(error)
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Live2D ZIP Worker not found')
        }
      },
    }),
    'dsh-whale-pet: Live2D ZIP Worker route',
  )

  // 官方 Cubism Core 的本地副本。必须先于上面的 ESM chunk 执行，且不访问 CDN。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: WHALE_PET_PATHS.cubismCore,
      handler: (_req, res) => {
        try {
          const code = readFileSync(CUBISM_CORE_PATH, 'utf8')
          res.writeHead(200, IMMUTABLE_JS_HEADERS)
          res.end(code)
        } catch (error) {
          ctx.logger?.warn?.('dsh-whale-pet: Cubism Core runtime missing')
          ctx.logger?.warn?.(error)
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Cubism Core runtime not found')
        }
      },
    }),
    'dsh-whale-pet: Cubism Core route',
  )
}
