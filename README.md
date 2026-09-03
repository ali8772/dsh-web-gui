# dsh-whale-pet 🐳

[English](README.en.md) · [安装](docs/INSTALL.md) · [架构](docs/ARCHITECTURE.md) · [更新日志](CHANGELOG.md)

`dsh-whale-pet` 是 DeepSeek Harness Web GUI 的鲸鱼娘（Whale-chan）悬浮宠物插件。它显示账户余额与消费、OpenCode Go 套餐额度（5 小时 / 7 天 / 1 个月已用与剩余），并在会话运行时展示真实任务进度与完成弹窗（按模型分别计费）。

![Whale-chan 在 DSH Web GUI 中的脱敏演示](docs/images/whale-chan-demo.png)

> 截图使用固定示例数据（余额 ¥88.88），不包含真实账户信息。

## v0.3.0 功能

### 余额与消费（合并页）
- 宿主通过 DSH credentials 读取 `DEEPSEEK_API_KEY` 并查询余额；密钥不会进入浏览器。
- 余额与今日/近 7 天消费合并在同一页：标题显示余额金额，标题行保留高峰/低谷徽标；面板展示「今日消费」「近 7 天消费」的金额与调用次数。
- 金额严格按账户余额下降累计；充值或赠金导致的余额上升只更新计算基线，不抵扣已累计消费。
- 首次成功读取余额只建立基线，不产生消费；之后每次成功刷新时，将相较上次观察到的余额下降计入当前北京时间日期。

### OpenCode Go 套餐额度
- 新增独立页面，调用官方网关 `https://opencode.ai/zen/go/v1/usage` 读取三个滚动窗口：5 小时 / 7 天 / 1 个月。
- 每个窗口显示已用百分比、剩余百分比（=100 − 已用）、状态与重置时间。
- 凭证优先解析 `OPENCODE_GO_API_KEY` 环境变量，回退到 opencode CLI 登录文件 `~/.local/share/opencode/auth.json` 中的 `opencode-go.key`；密钥不出宿主，浏览器只访问同源代理路由。
- 宿主做 30 秒缓存与并发合并；刷新失败时回退上次成功数据并提示「暂时无法刷新」。

### 任务与完成弹窗
- 自动发现最多 10 个运行中会话；子代理任务行嵌套在主任务容器下，按主任务 family 分组显示。
- 点击任务可打开对应会话；超过 5 条时自动滚动；每行显示 todo 进度、阶段（思考/工具/空闲）、当前工具、轮次与步骤。
- `approval/asked` 让状态点变黄等待用户操作；`approval/decided` 立即清除黄点。
- 任务完成时弹出对话框，按模型分别计费：每条 `assistant/message` 按其发生时的 `request/header.config.model` 走官方价格，本次对话与对话总消耗量各自按模型分组展示。

### 鲸鱼娘与交互
- 透明立绘、漂浮动画、拖拽及位置记忆、点击切页、明暗背景自适应、高峰/低谷提示、充值入口与 OpenCode Go 额度页。

### 刷新策略
- 余额与消费每 60 秒刷新一次；任务进度按更短间隔更新；OpenCode Go 额度在进入页面时立即拉取并在该页常驻期间每 60 秒轮询。

## 安装

要求：Node.js 20+、可运行的 DSH CLI，且 `pnpm` 在 `PATH` 中。

从 [GitHub Releases](https://github.com/ali8772/dsh-web-gui/releases) 下载 `dsh-whale-pet-0.3.0.tgz`，然后执行：

```sh
dsh plugin --profile web add ./dsh-whale-pet-0.3.0.tgz
```

重启 `dsh web`，再刷新浏览器。不要在 profile patch 中重复插入插件；安装包自带的 bundle patch 负责激活。升级、卸载和验证步骤见 [安装文档](docs/INSTALL.md)。

## 宿主路由

| 路径 | 用途 |
|---|---|
| `GET /api/whale-pet/health` | 存活检查，返回 `{ plugin, version, ok }` |
| `GET /api/whale-pet/state` | 余额 + 今日/近 7 天消费 + 调用次数 |
| `POST /api/whale-pet/tasks` | 真实任务进度（todo/工具/轮次/步骤 + 黄点状态） |
| `POST /api/whale-pet/task-summary` | 单会话 token/费用汇总，按模型分别计费 |
| `GET /api/whale-pet/opencode-go` | OpenCode Go 套餐额度（5 小时 / 7 天 / 1 个月） |

## 数据与隐私

- `DEEPSEEK_API_KEY`：余额查询及余额变化消费统计所需，仅由宿主端解析，浏览器仅访问同源代理路由。
- `OPENCODE_GO_API_KEY` / `~/.local/share/opencode/auth.json` 的 `opencode-go.key`：用于查询 OpenCode Go 套餐额度；密钥不出宿主。
- 余额观察账本保存在 `$DSH_HOME/whale-pet/balance-spend.json`，只存币种、上次余额与按日累计下降额，不存 API Key。
- 宿主读取本地 DSH 会话日志仅用于调用次数、任务进度和按模型计费，不用于计算消费金额。
- 浏览器只能访问 `127.0.0.1` 上的本地 DSH Web 服务；任何路由都不会返回原始凭证。

不要把凭据、profile 文件、会话日志或真实账户截图提交到 Git；`.gitignore` 已长期排除这些内容。

## 验证

```sh
curl http://127.0.0.1:3080/api/whale-pet/health
```

预期包含：

```json
{"plugin":"dsh-whale-pet","version":"0.3.0","ok":true}
```

## Windows 伴侣

源码仓库的 `windows/` 包含 PowerShell 5.1 + WPF 桌面伴侣。它是独立实验性程序，不随 npm/tarball 插件包发布。请阅读 [`windows/README.md`](windows/README.md)，运行前审查脚本且不要硬编码凭据。

## 开发

```sh
npm ci
npm run build
npm test
npm run check
npm pack --dry-run
```

完整说明见 [贡献指南](CONTRIBUTING.md) 和 [发布流程](docs/RELEASE.md)。

## 文档

- [安装与升级](docs/INSTALL.md)
- [架构与信任边界](docs/ARCHITECTURE.md)
- [故障排查](docs/TROUBLESHOOTING.md)
- [素材说明](ASSET_NOTICE.md)
- [更新日志](CHANGELOG.md)

## 许可

代码采用 [MIT](LICENSE) 许可证。鲸鱼娘视觉素材及商标说明见 [ASSET_NOTICE.md](ASSET_NOTICE.md)。项目与 DeepSeek 官方无隶属或背书关系。
