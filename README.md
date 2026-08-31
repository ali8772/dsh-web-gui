# dsh-whale-pet 🐳

[English](README.en.md) · [安装](docs/INSTALL.md) · [架构](docs/ARCHITECTURE.md) · [更新日志](CHANGELOG.md)

`dsh-whale-pet` 是 DeepSeek Harness Web GUI 的鲸鱼娘（Whale-chan）悬浮宠物插件。它显示账户余额、今日及近 7 天消费，并在会话运行时展示真实任务进度。

![Whale-chan 在 DSH Web GUI 中的脱敏演示](docs/images/whale-chan-demo.png)

> 截图使用固定示例数据（余额 ¥88.88），不包含真实账户信息。

## v0.2.0 功能

- **余额**：宿主通过 DSH credentials 读取 `DEEPSEEK_API_KEY` 并查询余额；密钥不会进入浏览器。
- **消费**：同页展示今日和近 7 个北京时间自然日；优先使用可选平台数据，否则根据 DSH 会话 token 本地估算并标注“本地估算”。
- **任务**：自动发现最多 10 个运行中会话，显示最多 5 行，每 5 秒滚动；解析 todo、工具、轮次和步骤，点击任务可打开对应会话。
- **鲸鱼娘**：透明立绘、漂浮动画、拖拽及位置记忆、点击切页、明暗背景自适应、高峰/低谷提示和充值入口。
- **刷新**：余额和消费每 60 秒刷新，任务状态按更短间隔更新。

> 本地消费估算只覆盖经过 DSH 且日志含可识别 token 用量的调用，不是正式账单。

## 安装

要求：Node.js 20+、可运行的 DSH CLI，且 `pnpm` 在 `PATH` 中。

从 [GitHub Releases](https://github.com/ali8772/dsh-web-gui/releases) 下载 `dsh-whale-pet-0.2.0.tgz`，然后执行：

```sh
dsh plugin --profile web add ./dsh-whale-pet-0.2.0.tgz
```

重启 `dsh web`，再刷新浏览器。不要在 profile patch 中重复插入插件；安装包自带的 bundle patch 负责激活。升级、卸载和验证步骤见 [安装文档](docs/INSTALL.md)。

## 数据与隐私

- `DEEPSEEK_API_KEY`：余额查询所需，仅由宿主端解析。
- `DEEPSEEK_PLATFORM_TOKEN`：可选的消费数据来源，属于敏感凭据。
- 无平台 token 时，宿主读取本地 DSH 会话日志进行估算和任务进度分析。
- 本地 API 会返回余额、消费与任务摘要；应仅在可信的本机 DSH Web 环境使用。

不要把凭据、profile 文件、会话日志或真实账户截图提交到 Git。

## 验证

```sh
curl http://127.0.0.1:3080/api/whale-pet/health
```

预期包含：

```json
{"plugin":"dsh-whale-pet","version":"0.2.0","ok":true}
```

## Windows 伴侣

源码仓库的 `windows/` 包含 PowerShell 5.1 + WPF 桌面伴侣。它是独立实验性程序，不随 npm/tarball 插件包发布。请阅读 [`windows/README.md`](windows/README.md)，运行前审查脚本且不要硬编码凭据。

## 开发

```sh
npm ci
npm run build
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
