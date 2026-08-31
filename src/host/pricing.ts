/**
 * DeepSeek 官方价格引擎（纯函数，无运行时依赖）。
 *
 * 价格表策展自 DeepSeek 官方公告（https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）。
 * 本实现移植自 bpc-oss/dsh-web-billing（MIT, https://github.com/bpc-oss/dsh-web-billing）
 * 经 dsh-codex-meter（MIT, https://github.com/ChrisZhangWG/dsh-codex-meter）整理的价格政策时间表，
 * 保留官方政策时间表与峰谷判定。单价单位：每 1M tokens，人民币（cny）与美元（usd）各一份。
 *
 * 语义约定（与 DeepSeek 官方及 provider 适配器一致）：
 * - input      缓存未命中输入
 * - cacheRead  缓存命中输入
 * - output     输出
 */

/** 峰谷判定的默认时区（北京时间）。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/** 官方高峰时段（本地小时，[start, end) 闭开区间）。 */
export const DEFAULT_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [[9, 12], [14, 18]]

const ZERO_UNIT = Object.freeze({ input: 0, cacheRead: 0, output: 0 })

export interface PriceUnit {
  readonly input: number
  readonly cacheRead: number
  readonly output: number
}

/** 双币种单价：`cny` / `usd` 各一份。 */
export interface DualCurrencyUnit {
  readonly cny: PriceUnit
  readonly usd: PriceUnit
}

export interface PricePolicy {
  readonly since: string
  readonly label: string
  readonly prices?: Readonly<Record<string, DualCurrencyUnit>>
  readonly peak?: Readonly<Record<string, DualCurrencyUnit>>
  readonly offPeak?: Readonly<Record<string, DualCurrencyUnit>>
}

/**
 * 官方政策时间表（`since` 为生效时刻，含时区偏移）。每条政策要么是固定单价表
 * （`prices`），要么是峰谷单价表（`peak`/`offPeak`）。
 */
export const OFFICIAL_PRICING_POLICIES: readonly PricePolicy[] = [
  {
    since: '2025-02-09T00:00:00+08:00',
    label: 'deepseek-chat / deepseek-reasoner 标准价（2025-02-09 优惠期结束）',
    prices: {
      'deepseek-chat': {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 },
      },
      'deepseek-reasoner': {
        cny: { input: 4, cacheRead: 1, output: 16 },
        usd: { input: 0.55, cacheRead: 0.055, output: 1.68 },
      },
      '*': {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 },
      },
    },
  },
  {
    since: '2026-05-22T00:00:00+08:00',
    label: 'V4 系列 75% 降价转永久（deepseek-v4-flash / deepseek-v4-pro 上线）',
    prices: {
      'deepseek-v4-flash': {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 },
      },
      'deepseek-v4-pro': {
        cny: { input: 3, cacheRead: 0.025, output: 6 },
        usd: { input: 0.435, cacheRead: 0.003625, output: 0.87 },
      },
      '*': {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 },
      },
    },
  },
  {
    since: '2026-08-17T00:00:00+08:00',
    label: '峰谷定价：高峰 09:00-12:00 / 14:00-18:00（北京时间），空闲时段半价',
    peak: {
      'deepseek-v4-flash': {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 },
      },
      'deepseek-v4-pro': {
        cny: { input: 9, cacheRead: 0.3, output: 27 },
        usd: { input: 1.32, cacheRead: 0.044, output: 3.96 },
      },
      '*': {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 },
      },
    },
    offPeak: {
      'deepseek-v4-flash': {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 },
      },
      'deepseek-v4-pro': {
        cny: { input: 4.5, cacheRead: 0.15, output: 13.5 },
        usd: { input: 0.66, cacheRead: 0.022, output: 1.98 },
      },
      '*': {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 },
      },
    },
  },
]

/** 某时刻生效的官方政策（第一个 `since` 之前取第一条）。 */
export function activePolicy(
  timeMs: number,
  policies: readonly PricePolicy[] = OFFICIAL_PRICING_POLICIES,
): PricePolicy {
  let active = policies[0]!
  for (const policy of policies) {
    const since = Date.parse(policy.since)
    if (Number.isFinite(since) && timeMs >= since) active = policy
  }
  return active
}

/** 该时刻是否处于高峰时段（按指定时区与窗口判定；窗口为 [start, end) 小时）。 */
export function isPeak(
  timeMs: number,
  timezone = DEFAULT_TIMEZONE,
  windows: ReadonlyArray<readonly [number, number]> = DEFAULT_PEAK_WINDOWS,
): boolean {
  let hour: number
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(new Date(timeMs))
    hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24
  } catch {
    // 非法时区等异常按非高峰处理，不阻断计价。
    hour = -1
  }
  return windows.some(([start, end]) => hour >= start && hour < end)
}

/** 在单张价格表内取模型单价（含 `*` 兜底）。 */
function priceFor(model: string, table: Readonly<Record<string, DualCurrencyUnit>>): DualCurrencyUnit {
  return table[model] ?? table['*'] ?? { cny: ZERO_UNIT, usd: ZERO_UNIT }
}

/** 把两份单价合并（后者的存在键覆盖前者）。 */
function mergeUnit(base: DualCurrencyUnit, over?: DualCurrencyUnit): DualCurrencyUnit {
  return {
    cny: { ...base.cny, ...(over?.cny ?? {}) },
    usd: { ...base.usd, ...(over?.usd ?? {}) },
  }
}

export interface PriceAtResult {
  /** 人民币单价（每 1M tokens）。 */
  readonly cny: PriceUnit
  /** 美元单价（每 1M tokens）。 */
  readonly usd: PriceUnit
  /** 'flat' | 'peak' | 'offPeak'。 */
  readonly mode: 'flat' | 'peak' | 'offPeak'
}

/**
 * 计算某模型在某一时刻的单价（双币种）。
 *
 * 解析顺序（政策链继承）：
 * 1. 从新到旧遍历「不晚于消息时刻」的政策，取第一个点名该模型的政策单价
 *    （被新政策下架的模型自动沿用旧政策价格，历史账单才与平台一致）；
 * 2. 没有任何政策点名 → 用最新适用政策的 `*` 兜底。
 *
 * @param model - 模型名。
 * @param timeMs - 消息时间（epoch ms）。
 * @param opts - { timezone, peakWindows, policies }。
 */
export function priceAt(
  model: string,
  timeMs: number,
  opts?: {
    timezone?: string
    peakWindows?: ReadonlyArray<readonly [number, number]>
    policies?: readonly PricePolicy[]
  },
): PriceAtResult {
  const { timezone = DEFAULT_TIMEZONE, peakWindows = DEFAULT_PEAK_WINDOWS, policies = OFFICIAL_PRICING_POLICIES } = opts ?? {}
  const peak = isPeak(timeMs, timezone, peakWindows)
  const applicable = policies.filter((policy) => timeMs >= Date.parse(policy.since))
  const scope = applicable.length > 0 ? applicable : [policies[0]!]
  let winner: PricePolicy | undefined
  let named = false
  let baseTable: Readonly<Record<string, DualCurrencyUnit>> | undefined
  for (let index = scope.length - 1; index >= 0; index--) {
    const policy = scope[index]!
    const table = policy.peak !== undefined && policy.offPeak !== undefined
      ? (peak ? policy.peak : policy.offPeak)
      : policy.prices
    if (table !== undefined && table[model] !== undefined) {
      winner = policy
      named = true
      baseTable = table
      break
    }
  }
  if (winner === undefined || baseTable === undefined) {
    winner = scope[scope.length - 1]!
    baseTable = winner.peak !== undefined && winner.offPeak !== undefined
      ? (peak ? winner.peak : winner.offPeak)
      : winner.prices
  }
  const unit = named ? priceFor(model, baseTable) : mergeUnit(priceFor(model, baseTable))
  return {
    cny: unit.cny,
    usd: unit.usd,
    mode: winner.peak !== undefined && winner.offPeak !== undefined ? (peak ? 'peak' : 'offPeak') : 'flat',
  }
}

/** 一次性计算一批消息的费用：`priceAt` 结果按 (model, hourBucket) 记忆化。 */
export function createPriceCache() {
  const cache = new Map<string, PriceAtResult>()
  return (model: string, timeMs: number): PriceAtResult => {
    const key = `${model}\u0000${Math.floor(timeMs / 3_600_000)}`
    let hit = cache.get(key)
    if (hit === undefined) {
      hit = priceAt(model, timeMs)
      cache.set(key, hit)
    }
    return hit
  }
}

export interface CostBreakdown {
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly outputTokens: number
  /** 人民币费用。 */
  readonly cost: number
  /** 美元费用。 */
  readonly costUsd: number
}

/**
 * 按 TokenUsage 与单价计算费用（双币种）与 token 拆分。
 * @param usage - `{ inputTokens, cacheReadTokens?, outputTokens }`。
 * @param unit - `priceAt` 返回的单价。
 */
export function costOf(usage: { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number }, unit: PriceAtResult): CostBreakdown {
  const inputTokens = usage.inputTokens ?? 0
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const cost = (inputTokens * unit.cny.input + cacheReadTokens * unit.cny.cacheRead + outputTokens * unit.cny.output) / 1e6
  const costUsd = (inputTokens * unit.usd.input + cacheReadTokens * unit.usd.cacheRead + outputTokens * unit.usd.output) / 1e6
  return { inputTokens, cacheReadTokens, outputTokens, cost, costUsd }
}
