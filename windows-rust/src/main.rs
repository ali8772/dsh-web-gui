//! Windows 端桌面宠物入口（实验性）。
//!
//! 在 Linux 上启动会先打开一个本地 HTTP 服务（axum）用于联调，
//! 然后启动 egui 桌面窗口显示同一份状态。Windows 上另外启用透明窗口。

use whale_pet_rust::dsh_client::DshClient;
use whale_pet_rust::server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let client = DshClient::default_local();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let local_addr = listener.local_addr()?;
    tracing::info!(%local_addr, "starting whale-pet-rust companion");

    let server_client = client.clone();
    tokio::spawn(async move {
        if let Err(err) = server::serve(server_client, listener).await {
            tracing::error!(?err, "http server failed");
        }
    });

    // GUI 启动（暂时 Linux 上也是普通窗口；Windows cfg 后切到透明）
    whale_pet_rust::gui::run(client, local_addr).await
}
