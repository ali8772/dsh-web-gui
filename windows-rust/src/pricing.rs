//! 价格表与计费：与 `src/host/pricing.ts` 完全对齐。
//!
//! - `OFFICIAL_PRICING_POLICIES`：按时间排序的官方政策。
//! - `price_at(model, time_ms, opts)`：返回某模型某时刻的单价（双币种）。
//! - `create_price_cache()`：带小时桶记忆化的批处理闭包。

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Debug, Clone, Copy)]
pub struct PriceUnit {
    pub input: f64,
    pub cache_read: f64,
    pub output: f64,
}

impl Default for PriceUnit {
    fn default() -> Self {
        Self { input: 0.0, cache_read: 0.0, output: 0.0 }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct DualCurrencyUnit {
    pub cny: PriceUnit,
    pub usd: PriceUnit,
}

#[derive(Debug, Clone)]
pub struct PricePolicy {
    pub since: &'static str,
    pub label: &'static str,
    pub prices: HashMap<&'static str, DualCurrencyUnit>,
    pub peak: Option<HashMap<&'static str, DualCurrencyUnit>>,
    pub off_peak: Option<HashMap<&'static str, DualCurrencyUnit>>,
}

fn unit_map(pairs: &[(&'static str, DualCurrencyUnit)]) -> HashMap<&'static str, DualCurrencyUnit> {
    pairs.iter().copied().collect()
}

/// 官方价格政策时间表（与 TS 版保持一致）。
pub static OFFICIAL_PRICING_POLICIES: LazyLock<Vec<PricePolicy>> = LazyLock::new(|| {
    vec![
        PricePolicy {
            since: "2025-02-09T00:00:00+08:00",
            label: "deepseek-chat / deepseek-reasoner 标准价（2025-02-09 优惠期结束）",
            prices: unit_map(&[
                (
                    "deepseek-chat",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 2.0, cache_read: 0.5, output: 8.0 },
                        usd: PriceUnit { input: 0.28, cache_read: 0.028, output: 0.42 },
                    },
                ),
                (
                    "deepseek-reasoner",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 4.0, cache_read: 1.0, output: 16.0 },
                        usd: PriceUnit { input: 0.55, cache_read: 0.055, output: 1.68 },
                    },
                ),
                (
                    "*",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 2.0, cache_read: 0.5, output: 8.0 },
                        usd: PriceUnit { input: 0.28, cache_read: 0.028, output: 0.42 },
                    },
                ),
            ]),
            peak: None,
            off_peak: None,
        },
        PricePolicy {
            since: "2026-05-22T00:00:00+08:00",
            label: "V4 系列 75% 降价转永久（deepseek-v4-flash / deepseek-v4-pro 上线）",
            prices: unit_map(&[
                (
                    "deepseek-v4-flash",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 1.0, cache_read: 0.02, output: 2.0 },
                        usd: PriceUnit { input: 0.14, cache_read: 0.0028, output: 0.28 },
                    },
                ),
                (
                    "deepseek-v4-pro",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 3.0, cache_read: 0.025, output: 6.0 },
                        usd: PriceUnit { input: 0.435, cache_read: 0.003625, output: 0.87 },
                    },
                ),
                (
                    "*",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 1.0, cache_read: 0.02, output: 2.0 },
                        usd: PriceUnit { input: 0.14, cache_read: 0.0028, output: 0.28 },
                    },
                ),
            ]),
            peak: None,
            off_peak: None,
        },
        PricePolicy {
            since: "2026-08-17T00:00:00+08:00",
            label: "峰谷定价：高峰 09:00-12:00 / 14:00-18:00（北京时间），空闲时段半价",
            prices: HashMap::new(),
            peak: Some(unit_map(&[
                (
                    "deepseek-v4-flash",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 3.0, cache_read: 0.1, output: 9.0 },
                        usd: PriceUnit { input: 0.44, cache_read: 0.014, output: 1.32 },
                    },
                ),
                (
                    "deepseek-v4-pro",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 9.0, cache_read: 0.3, output: 27.0 },
                        usd: PriceUnit { input: 1.32, cache_read: 0.044, output: 3.96 },
                    },
                ),
                (
                    "*",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 3.0, cache_read: 0.1, output: 9.0 },
                        usd: PriceUnit { input: 0.44, cache_read: 0.014, output: 1.32 },
                    },
                ),
            ])),
            off_peak: Some(unit_map(&[
                (
                    "deepseek-v4-flash",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 1.5, cache_read: 0.05, output: 4.5 },
                        usd: PriceUnit { input: 0.22, cache_read: 0.007, output: 0.66 },
                    },
                ),
                (
                    "deepseek-v4-pro",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 4.5, cache_read: 0.15, output: 13.5 },
                        usd: PriceUnit { input: 0.66, cache_read: 0.022, output: 1.98 },
                    },
                ),
                (
                    "*",
                    DualCurrencyUnit {
                        cny: PriceUnit { input: 1.5, cache_read: 0.05, output: 4.5 },
                        usd: PriceUnit { input: 0.22, cache_read: 0.007, output: 0.66 },
                    },
                ),
            ])),
        },
    ]
});

pub const DEFAULT_TIMEZONE: &str = "Asia/Shanghai";
pub const DEFAULT_PEAK_WINDOWS: &[(u32, u32)] = &[(9, 12), (14, 18)];

#[derive(Debug, Clone, Copy)]
pub struct PriceAtResult {
    pub cny: PriceUnit,
    pub usd: PriceUnit,
    pub mode: &'static str,
}

pub struct PriceCache {
    inner: HashMap<String, PriceAtResult>,
}

impl PriceCache {
    pub fn new() -> Self {
        Self { inner: HashMap::new() }
    }

    pub fn lookup(&mut self, model: &str, time_ms: i64) -> PriceAtResult {
        let bucket = time_ms / 3_600_000;
        let key = format!("{}\x00{}", model, bucket);
        if let Some(hit) = self.inner.get(&key) {
            return *hit;
        }
        let value = price_at(model, time_ms, None);
        self.inner.insert(key, value);
        value
    }
}

pub fn create_price_cache() -> impl FnMut(&str, i64) -> PriceAtResult {
    let cache = Arc::new(Mutex::new(PriceCache::new()));
    move |model: &str, time_ms: i64| {
        let mut guard = cache.lock().expect("price cache poisoned");
        guard.lookup(model, time_ms)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CostBreakdown {
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub output_tokens: u64,
    pub cost: f64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct CostUsage {
    pub input_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

pub fn cost_of(usage: CostUsage, unit: PriceAtResult) -> CostBreakdown {
    let input_tokens = usage.input_tokens.unwrap_or(0);
    let cache_read_tokens = usage.cache_read_tokens.unwrap_or(0);
    let output_tokens = usage.output_tokens.unwrap_or(0);
    let cost = (input_tokens as f64 * unit.cny.input
        + cache_read_tokens as f64 * unit.cny.cache_read
        + output_tokens as f64 * unit.cny.output) / 1_000_000.0;
    let cost_usd = (input_tokens as f64 * unit.usd.input
        + cache_read_tokens as f64 * unit.usd.cache_read
        + output_tokens as f64 * unit.usd.output) / 1_000_000.0;
    CostBreakdown { input_tokens, cache_read_tokens, output_tokens, cost, cost_usd }
}

pub fn is_peak(time_ms: i64, timezone: Option<&str>, windows: Option<&[(u32, u32)]>) -> bool {
    let tz = timezone.unwrap_or(DEFAULT_TIMEZONE);
    let win = windows.unwrap_or(DEFAULT_PEAK_WINDOWS);
    let hour = hour_in_timezone(time_ms, tz);
    if hour < 0 {
        return false;
    }
    win.iter().any(|&(start, end)| hour >= start as i32 && hour < end as i32)
}

fn hour_in_timezone(time_ms: i64, timezone: &str) -> i32 {
    use chrono::{DateTime, Timelike};
    if timezone == "Asia/Shanghai" {
        let dt = DateTime::from_timestamp(time_ms / 1000, ((time_ms % 1000) * 1_000_000) as u32);
        if let Some(dt) = dt {
            let shanghai = dt + chrono::Duration::hours(8);
            return shanghai.hour() as i32;
        }
        return -1;
    }
    let dt = DateTime::from_timestamp(time_ms / 1000, ((time_ms % 1000) * 1_000_000) as u32);
    match dt {
        Some(dt) => dt.hour() as i32,
        None => -1,
    }
}

#[derive(Clone, Copy, Default)]
pub struct PriceAtOptions<'a> {
    pub timezone: Option<&'a str>,
    pub peak_windows: Option<&'a [(u32, u32)]>,
    pub policies: Option<&'a [PricePolicy]>,
}

pub fn price_at(model: &str, time_ms: i64, opts: Option<PriceAtOptions<'_>>) -> PriceAtResult {
    let opts = opts.unwrap_or_default();
    let peak = is_peak(time_ms, opts.timezone, opts.peak_windows);
    let policies: &[PricePolicy] = opts.policies.unwrap_or_else(|| OFFICIAL_PRICING_POLICIES.as_slice());
    let applicable: Vec<&PricePolicy> = policies
        .iter()
        .filter(|p| time_ms >= chrono::DateTime::parse_from_rfc3339(p.since).map(|d| d.timestamp_millis()).unwrap_or(0))
        .collect();
    let scope: Vec<&PricePolicy> = if !applicable.is_empty() {
        applicable
    } else {
        policies.iter().take(1).collect()
    };
    let mut winner: Option<&PricePolicy> = None;
    let mut base_table: Option<&HashMap<&'static str, DualCurrencyUnit>> = None;
    for policy in scope.iter().rev() {
        let table_opt: Option<&HashMap<&'static str, DualCurrencyUnit>> = match (&policy.peak, &policy.off_peak) {
            (Some(_), Some(_)) => Some(if peak { policy.peak.as_ref().unwrap() } else { policy.off_peak.as_ref().unwrap() }),
            _ => Some(&policy.prices),
        };
        if let Some(table) = table_opt {
            if table.contains_key(model) {
                winner = Some(policy);
                base_table = Some(table);
                break;
            }
        }
    }
    if winner.is_none() || base_table.is_none() {
        let last = scope.last().copied().unwrap_or(&policies[0]);
        winner = Some(last);
        let table = match (&last.peak, &last.off_peak) {
            (Some(_), Some(_)) => if peak { last.peak.as_ref().unwrap() } else { last.off_peak.as_ref().unwrap() },
            _ => &last.prices,
        };
        base_table = Some(table);
    }
    let unit = price_for(model, base_table.unwrap());
    let mode: &'static str = match (winner.unwrap().peak.as_ref(), winner.unwrap().off_peak.as_ref()) {
        (Some(_), Some(_)) => if peak { "peak" } else { "offPeak" },
        _ => "flat",
    };
    PriceAtResult { cny: unit.cny, usd: unit.usd, mode }
}

fn price_for(model: &str, table: &HashMap<&'static str, DualCurrencyUnit>) -> DualCurrencyUnit {
    table
        .get(model)
        .copied()
        .or_else(|| table.get("*").copied())
        .unwrap_or_default()
}
