/**
 * OpenCode Go 套餐额度（官方网关 `GET https://opencode.ai/zen/go/v1/usage`）。
 *
 * 网关只返回每个滚动窗口的已用百分比（`percent`）与重置时刻（`resetsAt`），
 * 没有绝对值；剩余额度 = 100 − percent。凭证优先取 `OPENCODE_GO_API_KEY`
 * 环境变量，回退到 opencode CLI 的登录文件 `~/.local/share/opencode/auth.json`
 * （`opencode-go.key`），因此用 CLI 登录过 Go 套餐的用户零配置可用。
 *
 * 模块内做 30s 内存缓存 + 并发合并；刷新失败时回退到上一次成功数据并打上
 * 错误标记，避免额度页闪断。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type OpenCodeGoWindowKey = 'rolling' | 'weekly' | 'monthly'

export interface OpenCodeGoWindow {
  readonly key: OpenCodeGoWindowKey
  /** 窗口中文标签。 */
  readonly label: string
  /** 网关状态（'ok' 或其它）。 */
  readonly status: string
  /** 已用百分比 0-100；未知为 null。 */
  readonly percent: number | null
  /** 剩余百分比 0-100；未知为 null。 */
  readonly remaining: number | null
  /** 重置时刻（epoch ms）；未知为 null。 */
  readonly resetsAt: number | null
}

export interface OpenCodeGoUsage {
  /** 是否检测到可用于查询的凭证。 */
  readonly configured: boolean
  /** 凭证来源：'env' | 'auth' | null。 */
  readonly keySource: 'env' | 'auth' | null
  /** 查询失败时的错误说明；成功或未配置时为 null。 */
  readonly error: string | null
  readonly fetchedAt: number
  readonly windows: Readonly<Record<OpenCodeGoWindowKey, OpenCodeGoWindow>>
}

export const OPENCODE_GO_API = 'https://opencode.ai/zen/go/v1/usage'
const KEY_ENV = 'OPENCODE_GO_API_KEY'
const AUTH_JSON_REL = join('.local', 'share', 'opencode', 'auth.json')
const FETCH_TIMEOUT_MS = 15_000
const CACHE_MS = 30_000

const WINDOW_LABELS: Readonly<Record<OpenCodeGoWindowKey, string>> = {
  rolling: '5 小时',
  weekly: '7 天',
  monthly: '1 个月',
}

const WINDOW_KEYS: readonly OpenCodeGoWindowKey[] = ['rolling', 'weekly', 'monthly']

function emptyWindows(): Record<OpenCodeGoWindowKey, OpenCodeGoWindow> {
  return {
    rolling: { key: 'rolling', label: WINDOW_LABELS.rolling, status: '', percent: null, remaining: null, resetsAt: null },
    weekly: { key: 'weekly', label: WINDOW_LABELS.weekly, status: '', percent: null, remaining: null, resetsAt: null },
    monthly: { key: 'monthly', label: WINDOW_LABELS.monthly, status: '', percent: null, remaining: null, resetsAt: null },
  }
}

/**
 * 解析 Go 套餐凭证：优先环境变量 `OPENCODE_GO_API_KEY`，其次
 * opencode CLI 登录文件中的 `opencode-go.key`。
 */
export function resolveOpenCodeGoKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir: string = homedir(),
): { key: string; source: 'env' | 'auth' } | null {
  const envKey = env[KEY_ENV]
  if (typeof envKey === 'string' && envKey !== '') return { key: envKey, source: 'env' }
  try {
    const parsed = JSON.parse(readFileSync(join(homeDir, AUTH_JSON_REL), 'utf8')) as unknown
    const token = (parsed as { 'opencode-go'?: { key?: unknown } })?.['opencode-go']?.key
    if (typeof token === 'string' && token !== '') return { key: token, source: 'auth' }
  } catch {
    // 文件缺失或不可解析 → 未配置
  }
  return null
}

function toPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function toTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/** 解析网关响应 `{ usage: { rolling, weekly, monthly } }`；形状不符返回 null。 */
export function parseOpenCodeGoUsage(
  body: unknown,
  fetchedAt: number,
  keySource: 'env' | 'auth',
): OpenCodeGoUsage | null {
  if (body === null || typeof body !== 'object') return null
  const usage = (body as { usage?: unknown }).usage
  if (usage === null || typeof usage !== 'object') return null
  const record = usage as Record<string, unknown>
  const windows = emptyWindows()
  for (const key of WINDOW_KEYS) {
    const raw = record[key]
    if (raw === null || typeof raw !== 'object') continue
    const row = raw as { status?: unknown; percent?: unknown; resetsAt?: unknown }
    const percent = toPercent(row.percent)
    windows[key] = {
      key,
      label: WINDOW_LABELS[key],
      status: typeof row.status === 'string' ? row.status : '',
      percent,
      remaining: percent === null ? null : Math.max(0, 100 - percent),
      resetsAt: toTime(row.resetsAt),
    }
  }
  return {
    configured: true,
    keySource,
    error: null,
    fetchedAt,
    windows,
  }
}

let memo: { at: number; value: OpenCodeGoUsage } | undefined
let inFlight: Promise<OpenCodeGoUsage> | undefined
let lastOk: OpenCodeGoUsage | undefined

export interface FetchOpenCodeGoOptions {
  env?: Readonly<Record<string, string | undefined>>
  homeDir?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  cacheMs?: number
}

/** 拉取 Go 套餐额度（30s 缓存；并发合并；失败回退上次成功数据）。 */
export async function fetchOpenCodeGoUsage(options: FetchOpenCodeGoOptions = {}): Promise<OpenCodeGoUsage> {
  const {
    env = process.env,
    homeDir = homedir(),
    baseUrl = OPENCODE_GO_API,
    fetchImpl = fetch,
    timeoutMs = FETCH_TIMEOUT_MS,
    cacheMs = CACHE_MS,
  } = options
  const now = Date.now()
  if (memo !== undefined && now - memo.at < cacheMs) return memo.value
  if (inFlight !== undefined) return inFlight

  inFlight = (async (): Promise<OpenCodeGoUsage> => {
    const fetchedAt = Date.now()
    const credential = resolveOpenCodeGoKey(env, homeDir)
    if (credential === null) {
      const usage: OpenCodeGoUsage = {
        configured: false,
        keySource: null,
        error: null,
        fetchedAt,
        windows: emptyWindows(),
      }
      memo = { at: fetchedAt, value: usage }
      return usage
    }
    try {
      const response = await fetchImpl(baseUrl, {
        headers: {
          Authorization: `Bearer ${credential.key}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`gateway ${response.status}`)
      const parsed = parseOpenCodeGoUsage(await response.json(), fetchedAt, credential.source)
      if (parsed === null) throw new Error('unexpected response shape')
      memo = { at: fetchedAt, value: parsed }
      lastOk = parsed
      return parsed
    } catch (cause) {
      if (lastOk !== undefined) {
        // 刷新失败：沿用上次成功数据，并提示数据可能延迟。
        const stale: OpenCodeGoUsage = {
          ...lastOk,
          error: '暂时无法刷新，显示上次数据',
        }
        memo = { at: fetchedAt, value: stale }
        return stale
      }
      const usage: OpenCodeGoUsage = {
        configured: true,
        keySource: credential.source,
        error: cause instanceof Error ? cause.message : String(cause),
        fetchedAt,
        windows: emptyWindows(),
      }
      memo = { at: fetchedAt, value: usage }
      return usage
    }
  })()

  try {
    return await inFlight
  } finally {
    inFlight = undefined
  }
}

/** 清除缓存（测试用）。 */
export function resetOpenCodeGoCache(): void {
  memo = undefined
  inFlight = undefined
  lastOk = undefined
}