//! 带桌面伴侣 Bearer 凭据的 dsh-whale-pet 宿主客户端。

use std::sync::Arc;
use std::time::Duration;

use crate::models::{OpenCodeGoUsage, PetState, SessionSummary, TaskItem};
use reqwest::{RequestBuilder, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use thiserror::Error;

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:3080";
const COMPANION_PREFIX: &str = "/dsh-whale-pet/companion/v1";

#[derive(Debug, Error)]
pub enum DshClientError {
    #[error("desktop companion pairing is required or has been revoked")]
    PairingRequired,
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Protocol(String),
}

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
    companion_token: String,
    http: reqwest::Client,
}

impl DshClient {
    pub fn new(base_url: impl Into<String>, companion_token: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client");
        Self {
            inner: Arc::new(Inner {
                base_url: base_url.into().trim_end_matches('/').to_owned(),
                companion_token: companion_token.into(),
                http,
            }),
        }
    }

    pub fn default_local(companion_token: impl Into<String>) -> Self {
        Self::new(DEFAULT_BASE_URL, companion_token)
    }

    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    pub async fn health(&self) -> anyhow::Result<Health> {
        let url = format!("{}/api/whale-pet/health", self.inner.base_url);
        let response = self.inner.http.get(&url).send().await?;
        if !response.status().is_success() {
            anyhow::bail!("GET {url} failed with {}", response.status());
        }
        Ok(response.json().await?)
    }

    pub async fn pet_state(&self) -> anyhow::Result<PetState> {
        self.get_companion("state").await.map_err(Into::into)
    }

    pub async fn tasks(&self, ids: &[String]) -> anyhow::Result<Vec<TaskItem>> {
        let body = serde_json::json!({ "ids": ids });
        let envelope: TasksEnvelope = self.post_companion("tasks", &body).await?;
        if !envelope.ok {
            return Err(DshClientError::Protocol("tasks route returned not ok".into()).into());
        }
        Ok(envelope
            .tasks
            .into_iter()
            .map(|row| TaskItem {
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
            })
            .collect())
    }

    pub async fn task_summary(&self, id: &str) -> anyhow::Result<SessionSummary> {
        let body = serde_json::json!({ "id": id });
        let envelope: TaskSummaryEnvelope = self.post_companion("task-summary", &body).await?;
        if !envelope.ok {
            return Err(
                DshClientError::Protocol("task-summary route returned not ok".into()).into(),
            );
        }
        Ok(envelope.summary)
    }

    pub async fn opencode_go(&self) -> anyhow::Result<OpenCodeGoUsage> {
        let envelope: OpenCodeGoEnvelope = self.get_companion("opencode-go").await?;
        if !envelope.ok {
            return Err(
                DshClientError::Protocol("opencode-go route returned not ok".into()).into(),
            );
        }
        Ok(envelope.usage)
    }

    fn authorize(&self, request: RequestBuilder) -> RequestBuilder {
        request.bearer_auth(&self.inner.companion_token)
    }

    async fn get_companion<T: DeserializeOwned>(
        &self,
        endpoint: &str,
    ) -> Result<T, DshClientError> {
        let url = format!("{}{COMPANION_PREFIX}/{endpoint}", self.inner.base_url);
        let response = self.authorize(self.inner.http.get(&url)).send().await?;
        Self::decode(response).await
    }

    async fn post_companion<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        endpoint: &str,
        body: &B,
    ) -> Result<T, DshClientError> {
        let url = format!("{}{COMPANION_PREFIX}/{endpoint}", self.inner.base_url);
        let response = self
            .authorize(self.inner.http.post(&url).json(body))
            .send()
            .await?;
        Self::decode(response).await
    }

    async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, DshClientError> {
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(DshClientError::PairingRequired);
        }
        if !response.status().is_success() {
            return Err(DshClientError::Protocol(format!(
                "companion route failed with {}",
                response.status()
            )));
        }
        Ok(response.json().await?)
    }
}
