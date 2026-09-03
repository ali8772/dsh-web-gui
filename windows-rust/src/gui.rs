//! 桌面宠物 GUI（egui + eframe）。实验性骨架。
//!
//! - 单一可拖拽窗口。
//! - 鲸鱼娘立绘后续用嵌入字节替换；当前先显示一个深色占位矩形与当前页标签。
//! - 气泡展示余额/任务/OpenCode Go 三页内容（与 dsh-whale-pet 客户端镜像）。
//! - 每 60s 拉一次 DSH 宿主，OpenCode Go 页面进入时立即拉取。
//!
//! Windows 透明窗口需要平台特定代码（winit + Win32 SetLayeredWindowAttributes），
//! 留给真实 Windows 构建时再补。

use std::sync::Arc;
use std::time::{Duration, Instant};

use eframe::egui::{self, Color32, Sense, Vec2};
use tokio::sync::Mutex as AsyncMutex;

use crate::dsh_client::DshClient;
use crate::models::{OpenCodeGoUsage, PetState};

const POLL_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    #[default]
    Balance,
    Tasks,
    Go,
}

pub async fn run(client: DshClient, _local_addr: std::net::SocketAddr) -> anyhow::Result<()> {
    let state = Arc::new(AppState::new(client));
    state.refresh_all().await;

    let state_for_ui = state.clone();
    let options = eframe::NativeOptions::default();

    eframe::run_simple_native("Whale-chan", options, move |ctx, _frame| {
        let state = state_for_ui.clone();
        egui::CentralPanel::default()
            .frame(egui::Frame::none())
            .show(ctx, |ui| {
                let resp = ui.allocate_response(Vec2::new(180.0, 240.0), Sense::click_and_drag());
                ui.painter()
                    .rect_filled(resp.rect, 14.0, Color32::from_black_alpha(220));
                ui.painter().text(
                    resp.rect.center(),
                    egui::Align2::CENTER_CENTER,
                    format!("Whale-chan\n{:?}", state.current_page()),
                    egui::FontId::proportional(14.0),
                    Color32::WHITE,
                );

                if resp.clicked() {
                    state.cycle_page();
                }
                if resp.drag_started() {
                    state.dragging.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                if !resp.dragged() {
                    state.dragging.store(false, std::sync::atomic::Ordering::Relaxed);
                }

                ctx.request_repaint_after(Duration::from_millis(100));
            });
    })
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    Ok(())
}

pub struct AppState {
    client: DshClient,
    page: std::sync::Mutex<Page>,
    dragging: std::sync::atomic::AtomicBool,
    state: AsyncMutex<Option<PetState>>,
    go: AsyncMutex<Option<OpenCodeGoUsage>>,
    last_refresh: AsyncMutex<Instant>,
    last_go_refresh: AsyncMutex<Instant>,
}

impl AppState {
    pub fn new(client: DshClient) -> Self {
        Self {
            client,
            page: std::sync::Mutex::new(Page::default()),
            dragging: std::sync::atomic::AtomicBool::new(false),
            state: AsyncMutex::new(None),
            go: AsyncMutex::new(None),
            last_refresh: AsyncMutex::new(Instant::now() - POLL_INTERVAL),
            last_go_refresh: AsyncMutex::new(Instant::now() - POLL_INTERVAL),
        }
    }

    pub fn cycle_page(&self) {
        let mut guard = self.page.lock().expect("page mutex poisoned");
        *guard = match *guard {
            Page::Balance => Page::Tasks,
            Page::Tasks => Page::Go,
            Page::Go => Page::Balance,
        };
    }

    pub fn current_page(&self) -> Page {
        *self.page.lock().expect("page mutex poisoned")
    }

    pub async fn refresh_all(&self) {
        self.refresh_state().await;
        self.refresh_go().await;
    }

    pub async fn refresh_state(&self) {
        let mut guard = self.last_refresh.lock().await;
        if guard.elapsed() < POLL_INTERVAL {
            return;
        }
        *guard = Instant::now();
        drop(guard);
        if let Ok(pet) = self.client.pet_state().await {
            *self.state.lock().await = Some(pet);
        }
    }

    pub async fn refresh_go(&self) {
        let mut guard = self.last_go_refresh.lock().await;
        *guard = Instant::now();
        drop(guard);
        if let Ok(usage) = self.client.opencode_go().await {
            *self.go.lock().await = Some(usage);
        }
    }
}
