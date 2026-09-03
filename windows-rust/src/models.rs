//! 数据模型：与 TypeScript 版本字段一一对应。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceSnapshot {
    pub available: bool,
    pub currency: String,
    pub total_balance: Option<f64>,
    pub granted_balance: Option<f64>,
    pub topped_up_balance: Option<f64>,
    #[serde(default)]
    pub infos: Vec<BalanceInfo>,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceInfo {
    pub currency: String,
    pub total_balance: Option<f64>,
    pub granted_balance: Option<f64>,
    pub topped_up_balance: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendSnapshot {
    pub today: SpendBucket,
    pub days7: SpendBucket,
    #[serde(default)]
    pub by_day: std::collections::BTreeMap<String, f64>,
    pub computed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendBucket {
    pub amount: f64,
    pub amount_usd: Option<f64>,
    pub calls: u64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetState {
    pub ok: bool,
    pub fetched_at: i64,
    pub balance: Option<BalanceSnapshot>,
    pub spend: SpendSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub progress: Option<TaskProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    pub total: u32,
    pub done: u32,
    pub pct: Option<f64>,
    pub current: Option<String>,
    pub stage: Option<String>,
    pub tool: Option<String>,
    pub turn: Option<u32>,
    pub step: Option<u32>,
    pub awaiting_user: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub calls: u64,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub output_tokens: u64,
    pub cost: f64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub found: bool,
    pub model: String,
    pub calls: u64,
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub output_tokens: u64,
    pub cost: f64,
    pub cost_usd: f64,
    #[serde(default)]
    pub models: Vec<ModelUsage>,
    pub total_calls: u64,
    pub total_input_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cost: f64,
    pub total_cost_usd: f64,
    #[serde(default)]
    pub total_models: Vec<ModelUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeGoWindow {
    pub key: String,
    pub label: String,
    pub status: String,
    pub percent: Option<f64>,
    pub remaining: Option<f64>,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeGoUsage {
    pub configured: bool,
    #[serde(default)]
    pub key_source: Option<String>,
    pub error: Option<String>,
    pub fetched_at: i64,
    #[serde(default)]
    pub windows: std::collections::BTreeMap<String, OpenCodeGoWindow>,
}
