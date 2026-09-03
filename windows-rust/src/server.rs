//! 本地 HTTP 服务（axum）。
//!
//! - `GET /health`：返回 `{ plugin, version, ok }`。
//! - `GET /api/whale-pet/state`：反向代理 dsh 宿主 `/state`。
//! - `GET /api/whale-pet/opencode-go`：反向代理 dsh 宿主 `/opencode-go`。
//! - `POST /api/whale-pet/tasks` / `/task-summary`：反向代理并透传。
//!
//! 这一层让桌面伴侣可以与宿主解耦（宿主不可达时本地缓存兜底）。

use std::sync::Arc;

use axum::{
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::dsh_client::DshClient;

#[derive(Clone)]
pub struct AppState {
    pub client: DshClient,
    pub version: &'static str,
}

pub async fn serve(client: DshClient, listener: TcpListener) -> anyhow::Result<()> {
    let state = AppState { client, version: env!("CARGO_PKG_VERSION") };
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/whale-pet/state", get(state_route))
        .route("/api/whale-pet/opencode-go", get(opencode_go_route))
        .route("/api/whale-pet/tasks", post(tasks_route))
        .route("/api/whale-pet/task-summary", post(task_summary_route))
        .with_state(Arc::new(state));

    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.client.health().await {
        Ok(h) if h.ok => (
            StatusCode::OK,
            Json(json!({
                "plugin": "dsh-whale-pet",
                "version": state.version,
                "ok": true,
                "host": h,
            })),
        ).into_response(),
        Ok(h) => (
            StatusCode::OK,
            Json(json!({
                "plugin": "dsh-whale-pet",
                "version": state.version,
                "ok": false,
                "host": h,
            })),
        ).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "plugin": "dsh-whale-pet",
                "version": state.version,
                "ok": false,
                "error": err.to_string(),
            })),
        ).into_response(),
    }
}

async fn state_route(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.client.pet_state().await {
        Ok(pet) => (StatusCode::OK, Json(pet)).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn opencode_go_route(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.client.opencode_go().await {
        Ok(usage) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "usage": usage })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn tasks_route(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> impl IntoResponse {
    let ids: Vec<String> = body
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    match state.client.tasks(&ids).await {
        Ok(tasks) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "tasks": tasks })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn task_summary_route(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "missing id" })),
        )
            .into_response();
    }
    match state.client.task_summary(id).await {
        Ok(summary) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "summary": summary })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}
