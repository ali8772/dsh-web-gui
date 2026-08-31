# Whale-chan Windows 桌面伴侣 🐳👧

DeepSeek Whale-chan 的 PowerShell 5.1 + WPF 实验性桌面伴侣，显示余额、今日消费和近 7 天消费，并提供漂浮、倾斜、眨眼、尾巴及呆毛动画。

> 这是由单张立绘切片与叠层动画实现的 “Live2D 风格”效果，并非 Cubism Live2D 模型。

## 获取与目录

Windows 伴侣不包含在 DSH 插件 `.tgz` 中。请从可信 GitHub 源码获取，并保持以下运行文件相邻：

```text
windows/
├── WhaleMaidPet.ps1
└── assets/
    ├── whale-maid.png
    ├── tail.png
    ├── ahoge.png
    └── whale-icon.ico   (可选)
```

## 运行

在 PowerShell 中进入 `windows` 目录，审查脚本后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\WhaleMaidPet.ps1
```

`-ExecutionPolicy Bypass` 会放宽本次进程的脚本策略；只应对已审查且可信的本地文件使用。

## 交互

- 单击：余额 → 今日消费 → 近 7 天消费。
- 按住拖动：移动并保存位置。
- 右键：立即刷新或退出。

## 数据源

1. 首选 `http://127.0.0.1:3080/api/whale-pet/state` 的本地 DSH 插件数据。
2. DSH 不可达时，可从 WSL DSH credentials 查询余额并本地估算消费。

通过环境变量配置 WSL：

```powershell
$env:DSH_WHALE_PET_WSL_DISTRO = 'Ubuntu'
$env:DSH_WHALE_PET_WSL_USER = 'your-wsl-user'
```

也可用 `DSH_WHALE_PET_DSH_URL` 覆盖本地 API URL。不要把密钥写入脚本、截图、日志或 Git；凭据读取属于实验性降级路径，优先使用运行中的 DSH 宿主。

消费历史与位置保存在 `%APPDATA%\dsh-whale-pet\state.json`。

## 自检

```powershell
powershell -ExecutionPolicy Bypass -File .\WhaleMaidPet.ps1 -RenderTest
powershell -ExecutionPolicy Bypass -File .\WhaleMaidPet.ps1 -SelfTest
```

## 常见问题

- WSL 发行版或用户名不同：设置上述两个环境变量。
- PowerShell 5.1 解析中文失败：将脚本保存为 UTF-8 with BOM。
- 缺少立绘：确认三个必需 PNG 位于 `assets/`。
- 自启动：使用 `Win+R` → `shell:startup`，添加经过审查的启动快捷方式。

素材与商标边界见仓库根目录 [`ASSET_NOTICE.md`](../ASSET_NOTICE.md)。
