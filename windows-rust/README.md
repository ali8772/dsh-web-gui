# whale-pet-rust 🦀🐳

用 Rust 重建 dsh-whale-pet Windows 端的实验项目（独立服务，不集成 DSH bundle）。

## 为什么

原 Windows 伴侣是 PowerShell 5.1 + WPF 脚本（`../windows/`），启动慢、依赖系统 PowerShell、
UI 表达能力有限。Rust 单一二进制可自带全部依赖，构建为原生 Windows 程序。

## 结构

| 模块 | 职责 |
|---|---|
| `src/models.rs` | 与 TS 版字段一一对应的数据结构（余额/消费/任务/汇总/Go 额度） |
| `src/pricing.rs` | 官方价格表 + 按模型/时间/峰谷计价，与 `src/host/pricing.ts` 对齐 |
| `src/dsh_client.rs` | 统一 Bearer 认证并聚合 `127.0.0.1:3080` 上的 `/dsh-whale-pet/companion/v1/*` 宿主路由 |
| `src/server.rs` | 本地 axum HTTP 服务（健康检查与宿主路由代理） |
| `src/gui.rs` | egui + eframe 桌面宠物（三页：余额+消费 / 任务 / Go 额度） |
| `tests/pricing_test.rs` | 价格引擎回归（reasoner/flash/pro 单价、峰谷窗口） |

## 配对

1. 在已认证的 DSH Web 鲸鱼娘 `⚙️` 设置中，为这台设备生成独立 token。
2. 在 Windows 终端中只导入一次：

```powershell
$env:DSH_WHALE_PET_COMPANION_TOKEN = 'wpg1.…'
.\target\release\whale-pet.exe
Remove-Item Env:DSH_WHALE_PET_COMPANION_TOKEN
```

首次启动将 token 存入 Windows Credential Manager（service `dsh-whale-pet`，account `desktop-companion`）；后续不需要环境变量。程序统一为 state/tasks/task-summary/opencode-go 请求添加 Bearer header。被撤销、缺失或无效时会报告 pairing required。不要把 token 放入 URL、命令行参数、配置文件、日志、截图或 Git。

## 构建与测试

```sh
# 需要 Rust ≥ 1.80（LazyLock）
cargo build            # 构建 debug 二进制
cargo build --release  # 发布版（Windows 上交叉/原生构建均可）
cargo test             # 价格引擎与解析回归
```

Windows 上原生构建：

```sh
cargo build --release --target x86_64-pc-windows-msvc  # 或 gnu toolchain
```

## 设计说明

- **API Key 永远不出宿主**：Rust 程序只请求 `127.0.0.1` 上 DSH 宿主的 `/dsh-whale-pet/companion/v1/*`；API Key 由宿主解析。桌面端只持有可独立撤销的 companion token，宿主 credentials 只保存其 verifier。
- **独立服务**：二进制自带 axum 本地 HTTP 服务，方便以后为其它客户端（如系统托盘、
  手机联动）复用同一层；GUI 只是其中一类消费者。
- **峰谷/历史定价**：价格表按政策生效时间排序，`price_at(model, time)` 沿政策链
  解析，被下线的模型自动沿用旧政策价格，与平台账单一致。

## 当前状态

- [x] 已重新生成 `Cargo.lock`，并在 Linux 上运行 `cargo fmt --check` / `cargo check --locked` / `cargo test --locked` / `cargo clippy --locked -- -D warnings`
- [x] 价格引擎、宿主路由模型、本地 HTTP 服务骨架
- [ ] Windows 透明窗口（winit + Win32）完成前 GUI 为普通窗口占位
- [ ] 立绘资源打包（`include_bytes!`）与真实素材替换
- [ ] Windows 上 `cargo build --release` 产物验证