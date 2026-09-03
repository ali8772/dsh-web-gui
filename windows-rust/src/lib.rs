//! whale-pet-rust — Rust 重写实验。
//!
//! 数据模型、价格引擎与 dsh-whale-pet 宿主/客户端逻辑镜像，
//! 但用 Rust + axum + egui 重新实现。

pub mod models;
pub mod pricing;
pub mod dsh_client;
pub mod server;
pub mod gui;
