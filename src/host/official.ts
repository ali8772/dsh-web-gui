/**
 * DeepSeek 平台官方用量接口（可选）：当配置 `DEEPSEEK_PLATFORM_TOKEN` 时，
 * 从 platform.deepseek.com 拉取官方逐日消费，作为「今日消费 / 近 7 天消费」
 * 的权威来源。token 取自平台网页 localStorage 的 `userToken`，会随平台
 * 会话过期；失败时调用方应回退到本地估算。
 *
 * 参考 dsh-codex-meter（MIT）对平台接口的调用方式。
 */

export const PLATFORM_USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/cost'

const TIMEOUT_MS = 15_000

export interface PlatformDayRow {
  /** `YYYY-MM-DD`（北京时间）。 */
  readonly date: string
  /** 当日官方消费（人民币元）。 */
  readonly cost: number
}

export interface PlatformUsageResult {
  readonly ok: boolean
  /** 官方逐日消费（当月，可能跨月合并）。 */
  readonly days: PlatformDayRow[]
  /** 失败原因（ok=false 时）。 */
  readonly error?: string
  /** token 是否已过期（code 40002/40003）。 */
  readonly expired?: boolean
}

/** 把平台返回体解析为逐日消费。结构防御式解析，异常字段跳过。 */
export function parsePlatformDays(body: unknown, todayDate: string): PlatformDayRow[] {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined
  const biz = data && typeof data === 'object' ? (data as { biz_data?: unknown }).biz_data : undefined
  const container = Array.isArray(biz) ? biz[0] : biz
  const days = container && typeof container === 'object' ? (container as { days?: unknown }).days : undefined
  if (!Array.isArray(days)) return []
  const rows: PlatformDayRow[] = []
  for (const entry of days) {
    if (entry === null || typeof entry !== 'object') continue
    const date = (entry as { date?: unknown }).date
    const dataList = (entry as { data?: unknown }).data
    if (typeof date !== 'string' || !Array.isArray(dataList)) continue
    // 平台对本月剩余日期返回零值占位，不是消费历史。
    if (date > todayDate) continue
    let total = 0
    for (const modelEntry of dataList) {
      if (modelEntry === null || typeof modelEntry !== 'object') continue
      const usageList = (modelEntry as { usage?: unknown }).usage
      if (!Array.isArray(usageList)) continue
      for (const usage of usageList) {
        if (usage === null || typeof usage !== 'object') continue
        const value = toFinite((usage as { cost?: unknown; amount?: unknown }).cost ?? (usage as { amount?: unknown }).amount)
        if (Number.isFinite(value)) total += value
      }
    }
    rows.push({ date, cost: Math.round(total * 100) / 100 })
  }
  rows.sort((a, b) => a.date.localeCompare(b.date))
  return rows
}

function toFinite(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** 北京时间本地日期 `YYYY-MM-DD`。 */
export function shanghaiDateString(d = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00'
  return `${value('year')}-${value('month')}-${value('day')}`
}

/**
 * 拉取指定月份的官方逐日消费。`month`/`year` 为北京时间当月。
 */
export async function fetchPlatformMonth(
  token: string,
  year: number,
  month: number, // 1-12
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PlatformUsageResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const url = `${PLATFORM_USAGE_URL}?month=${month}&year=${year}`
  try {
    const response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'x-app-version': '1.0.0',
        Origin: 'https://platform.deepseek.com',
        Referer: 'https://platform.deepseek.com/usage',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return { ok: false, days: [], error: `DeepSeek 平台用量接口返回 HTTP ${response.status}` }
    }
    const body: unknown = await response.json()
    const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined
    const biz = data && typeof data === 'object' ? (data as { biz_code?: unknown }).biz_code : undefined
    const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined
    if (code !== 0 || biz !== 0) {
      const numeric = Number(code ?? biz ?? 'unknown')
      if (numeric === 40002 || numeric === 40003) {
        return { ok: false, days: [], expired: true, error: 'DEEPSEEK_PLATFORM_TOKEN 已过期：请重新登录 platform.deepseek.com 并更新 userToken' }
      }
      return { ok: false, days: [], error: `DeepSeek 平台用量接口错误 (code ${String(code ?? biz ?? 'unknown')})` }
    }
    return { ok: true, days: parsePlatformDays(body, shanghaiDateString()) }
  } catch (error) {
    return { ok: false, days: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 拉取覆盖「今日 + 前 N-1 天」的官方逐日消费；窗口跨月时自动补拉上月。
 */
export async function fetchPlatformWindow(
  token: string,
  days: number,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PlatformUsageResult> {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1 // 1-12（机器本地时区；北京时间相差不超过一天，跨月边界罕见，容忍）
  const current = await fetchPlatformMonth(token, year, month, options)
  if (!current.ok) return current
  const rows = [...current.days]
  // 窗口起点（北京时间）所在月不同于当月时补拉上月。
  const windowStart = new Date(Date.now() - (days - 1) * 86_400_000)
  const startMonth = windowStart.getMonth() + 1
  const startYear = windowStart.getFullYear()
  if (startYear !== year || startMonth !== month) {
    const previous = await fetchPlatformMonth(token, startYear, startMonth, options)
    if (previous.ok) {
      rows.push(...previous.days)
      rows.sort((a, b) => a.date.localeCompare(b.date))
    }
  }
  return { ok: true, days: rows }
}

/** 从逐日消费里取窗口合计（`[startDay, endDay]` 闭区间，含当日）。 */
export function sumPlatformWindow(days: readonly PlatformDayRow[], startDay: string, endDay: string): number {
  let total = 0
  for (const row of days) {
    if (row.date < startDay || row.date > endDay) continue
    total += row.cost
  }
  return Math.round(total * 100) / 100
}
