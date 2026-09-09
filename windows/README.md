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

## 配对与数据源

1. 在已认证的 DSH Web 鲸鱼娘 `⚙️` 设置中，为这台设备生成独立的桌面伴侣 token。
2. 只为首次导入打开一个 PowerShell 进程：

```powershell
$env:DSH_WHALE_PET_COMPANION_TOKEN = 'wpg1.…'
powershell -ExecutionPolicy Bypass -File .\WhaleMaidPet.ps1
Remove-Item Env:DSH_WHALE_PET_COMPANION_TOKEN
```

脚本验证 token 格式后，用 Windows CurrentUser DPAPI 加密写入 `%APPDATA%\dsh-whale-pet\companion-token.dat`。之后它使用 `Authorization: Bearer` 请求 `http://127.0.0.1:3080/dsh-whale-pet/companion/v1/state`，无需再次设置环境变量。不要把 token 放进 URL、命令行参数、脚本、截图、日志或 Git；撤销设备后重新生成并导入。

DSH 不可达或未配对时，实验性的旧降级路径仍可从 WSL DSH credentials 查询余额，并按相邻余额下降累计本地消费；首次读取只建立基线，充值不会抵扣已累计消费。建议保持降级路径禁用所需的凭据不可访问，并优先使用配对宿主。

通过环境变量配置 WSL 降级路径：

```powershell
$env:DSH_WHALE_PET_WSL_DISTRO = 'Ubuntu'
$env:DSH_WHALE_PET_WSL_USER = 'your-wsl-user'
```

也可用 `DSH_WHALE_PET_DSH_URL` 覆盖本地 API 基址；客户端仅接受 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]` 的纯 origin（可带端口），宿主还会验证真实 loopback socket 与 Host/Origin；不要指向远程代理。不要把密钥写入脚本、截图、日志或 Git；凭据读取属于实验性降级路径，优先使用运行中的已配对 DSH 宿主。

消费历史与位置保存在 `%APPDATA%\dsh-whale-pet\state.json`；伴侣 token 单独以 DPAPI 密文保存，不写入该 JSON。

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
