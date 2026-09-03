//! 反向代理 / 聚合 dsh-whale-pet 宿主路由。
//!
//! 桌面宠物直接请求宿主 (`/api/whale-pet/*`) 即可；本模块主要做：
//! - 健康检查 (`/health`)
//! - 状态聚合 (`/state`、`/tasks`、`/task-summary`、`/opencode-go`)
//! - 错误透明传递与可重试
//!
//! 由于 DSH 宿主暴露的接口已封装好（`{ ok, fetchedAt, ... }`），客户端只需反序列化即可。

use std::sync::Arc;
use std::time::Duration;

use crate::models::{OpenCodeGoUsage, PetState, SessionSummary, TaskItem};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:3080";

#[derive(Debug, Deserialize, Serialize)]
pub struct Health {
    pub plugin: String,
    pub version: String,
    pub ok: bool,
}

#[derive(Debug, Deserialize)]
struct TasksEnvelope {
    ok: bool,
    #[serde(default)]
    tasks: Vec<TaskProgressWire>,
}

#[derive(Debug, Deserialize)]
struct TaskProgressWire {
    id: String,
    #[allow(dead_code)]
    found: bool,
    #[serde(default)]
    total_todos: u32,
    #[serde(default)]
    done_todos: u32,
    #[serde(default)]
    pct: Option<f64>,
    #[serde(default)]
    current_todo: Option<String>,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    turn: Option<u32>,
    #[serde(default)]
    step: Option<u32>,
    #[serde(default)]
    awaiting_user: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct TaskSummaryEnvelope {
    ok: bool,
    summary: SessionSummary,
}

#[derive(Debug, Deserialize)]
struct OpenCodeGoEnvelope {
    ok: bool,
    usage: OpenCodeGoUsage,
}

#[derive(Clone)]
pub struct DshClient {
    inner: Arc<Inner>,
}

struct Inner {
    base_url: String,
    http: reqwest::Client,
}

impl DshClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client");
        Self { inner: Arc::new(Inner { base_url: base_url.into(), http }) }
    }

    pub fn default_local() -> Self {
        Self::new(DEFAULT_BASE_URL)
    }

    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    pub async fn health(&self) -> anyhow::Result<Health> {
        let url = format!("{}/api/whale-pet/health", self.inner.base_url);
        self.get_json(&url).await
    }

    pub async fn pet_state(&self) -> anyhow::Result<PetState> {
        let url = format!("{}/api/whale-pet/state", self.inner.base_url);
        self.get_json(&url).await
    }

    pub async fn tasks(&self, ids: &[String]) -> anyhow::Result<Vec<TaskItem>> {
        let url = format!("{}/api/whale-pet/tasks", self.inner.base_url);
        let body = serde_json::json!({ "ids": ids });
        let envelope: TasksEnvelope = self.inner.http.post(&url).json(&body).send().await?.json().await?;
        if !envelope.ok {
            anyhow::bail!("tasks route returned not ok");
        }
        Ok(envelope.tasks.into_iter().map(|row| TaskItem {
            id: row.id,
            title: String::new(),
            parent_id: None,
            progress: Some(crate::models::TaskProgress {
                total: row.total_todos,
                done: row.done_todos,
                pct: row.pct,
                current: row.current_todo,
                stage: row.stage,
                tool: row.tool,
                turn: row.turn,
                step: row.step,
                awaiting_user: row.awaiting_user,
            }),
        }).collect())
    }

    pub async fn task_summary(&self, id: &str) -> anyhow::Result<SessionSummary> {
        let url = format!("{}/api/whale-pet/task-summary", self.inner.base_url);
        let body = serde_json::json!({ "id": id });
        let envelope: TaskSummaryEnvelope = self.inner.http.post(&url).json(&body).send().await?.json().await?;
        if !envelope.ok {
            anyhow::bail!("task-summary route returned not ok");
        }
        Ok(envelope.summary)
    }

    pub async fn opencode_go(&self) -> anyhow::Result<OpenCodeGoUsage> {
        let url = format!("{}/api/whale-pet/opencode-go", self.inner.base_url);
        let envelope: OpenCodeGoEnvelope = self.get_json(&url).await?;
        if !envelope.ok {
            anyhow::bail!("opencode-go route returned not ok");
        }
        Ok(envelope.usage)
    }

    async fn get_json<T: DeserializeOwned>(&self, url: &str) -> anyhow::Result<T> {
        let resp = self.inner.http.get(url).send().await?;
        if !resp.status().is_success() {
            anyhow::bail!("GET {url} failed with {}", resp.status());
        }
        Ok(resp.json().await?)
    }
}
