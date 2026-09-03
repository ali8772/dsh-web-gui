//! 与 TypeScript 版本对齐的价格计算回归。

use whale_pet_rust::pricing::{cost_of, is_peak, price_at, CostUsage};

/// 2026-05-27 前后（V4 降价后、峰谷政策前）：flat 价格区间。
const T_V4_FLAT_MS: i64 = 1_780_000_000_000;

fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

#[test]
fn reasoner_standard_rate_matches_ts() {
    // deepseek-reasoner 标准价：未缓存输入 ¥4/M、缓存输入 ¥1/M、输出 ¥16/M。
    let unit = price_at("deepseek-reasoner", T_V4_FLAT_MS, None);
    assert!(approx(unit.cny.input, 4.0), "input cny {:?}", unit.cny.input);
    assert!(approx(unit.cny.cache_read, 1.0));
    assert!(approx(unit.cny.output, 16.0));
    assert!(approx(unit.usd.input, 0.55));
    assert!(approx(unit.usd.cache_read, 0.055));
    assert!(approx(unit.usd.output, 1.68));
    assert_eq!(unit.mode, "flat");
}

#[test]
fn v4_flash_flat_rate_matches_ts() {
    // V4 系列 2026-05-22 起的永久降价：flash 1/0.02/2。
    let unit = price_at("deepseek-v4-flash", T_V4_FLAT_MS, None);
    assert!(approx(unit.cny.input, 1.0));
    assert!(approx(unit.cny.cache_read, 0.02));
    assert!(approx(unit.cny.output, 2.0));
    assert!(approx(unit.usd.input, 0.14));
    assert_eq!(unit.mode, "flat");
}

#[test]
fn v4_pro_with_mixed_usage_cost_matches_ts() {
    // 1M 输入（未缓存）+ 0 缓存 + 0 输出 → flash ¥1 / pro ¥3 / reasoner ¥4。
    let usage = CostUsage { input_tokens: Some(1_000_000), cache_read_tokens: Some(0), output_tokens: Some(0) };
    let u_flash = price_at("deepseek-v4-flash", T_V4_FLAT_MS, None);
    let u_pro = price_at("deepseek-v4-pro", T_V4_FLAT_MS, None);
    let u_reasoner = price_at("deepseek-reasoner", T_V4_FLAT_MS, None);
    assert!(approx(cost_of(usage, u_flash).cost, 1.0));
    assert!(approx(cost_of(usage, u_pro).cost, 3.0));
    assert!(approx(cost_of(usage, u_reasoner).cost, 4.0));
    assert!(approx(cost_of(usage, u_pro).cost_usd, 0.435));
}

#[test]
fn peak_window_detection_works() {
    fn epoch(rfc3339: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .timestamp_millis()
    }
    // 03:00 UTC = 11:00 上海 → 高峰 [09:00, 12:00)
    let t_peak = epoch("2026-05-25T03:00:00Z");
    eprintln!("peak ts={} is_peak={}", t_peak, is_peak(t_peak, None, None));
    assert!(is_peak(t_peak, None, None), "11:00 SGT 高峰");
    // 00:00 UTC = 08:00 上海 → 高峰前
    assert!(!is_peak(epoch("2026-05-25T00:00:00Z"), None, None), "08:00 SGT 非高峰");
    // 04:00 UTC = 12:00 上海 → 高峰后
    assert!(!is_peak(epoch("2026-05-25T04:30:00Z"), None, None), "12:30 SGT 非高峰");
    // 09:00 UTC = 17:00 上海 → 下午高峰 [14:00, 18:00)
    assert!(is_peak(epoch("2026-05-25T09:00:00Z"), None, None), "17:00 SGT 高峰");
    // 10:30 UTC = 18:30 上海 → 高峰后
    assert!(!is_peak(epoch("2026-05-25T10:30:00Z"), None, None), "18:30 SGT 非高峰");
}