#requires -version 5.1
<#
  DshWhalePet.ps1 — 大肥鲸 Windows 桌面宠物（零依赖，PowerShell 5.1 + WPF）

  一只圆滚滚的 DeepSeek 大肥鲸悬浮在 Windows 桌面：
    - 实时余额 / 今日消费 / 近 7 天消费，每 60 秒刷新
    - 单击鲸鱼循环切换显示模式，按住可拖拽到任意位置
    - 透明背景、始终置顶、不占任务栏；右键鲸鱼可退出

  数据源（自动降级）：
    1. DSH 模式 —— WSL 里运行的 DeepSeek Harness Web GUI 在
       http://127.0.0.1:3080 提供 /api/whale-pet/state
       （官方余额 + 会话日志回放估价的消费，含调用次数）
    2. 独立模式 —— DSH 不可达时，直接读 WSL 里的
       \\wsl.localhost\<发行版>\home\<用户>\.dsh\.credentials.yaml
       的 DEEPSEEK_API_KEY 查询官方余额；消费按本地记录的
       余额变化推算（近似值，气泡标注「≈」）

  用法：
    powershell -ExecutionPolicy Bypass -File DshWhalePet.ps1
  自启动：
    将脚本的快捷方式放入 shell:startup 文件夹
  渲染自检（不弹窗，仅截图验证）：
    powershell -ExecutionPolicy Bypass -File DshWhalePet.ps1 -RenderTest
#>
param(
  [switch]$RenderTest,
  [switch]$SelfTest,
  [switch]$AsLibrary,
  [switch]$DragTest
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.Windows.Forms

# 工具窗口样式：任务栏 / Alt-Tab 均不出现（配合 ShowInTaskbar=false 双保险）
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W32Window { [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex); [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong); }' -ErrorAction SilentlyContinue
} catch { }

# 关闭 DPI 虚拟化（必须在任何窗口创建前调用）：消除物理像素/DIP 混合单位混乱。
# 之后 PointToScreen=设备像素、Window.Left/Top=DIP、GetDpiForSystem=系统真实值，
# 拖拽按 DpiScale 换算即可精确 1:1 跟手。
try {
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiAware { [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value); [DllImport("user32.dll")] public static extern uint GetDpiForSystem(); }' -ErrorAction Stop
  $awareOk = [DpiAware]::SetProcessDpiAwareness(1)   # 1 = SystemAware（兼容性最好）
  Start-Sleep -Milliseconds 50
} catch { }
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiProbe2 { [DllImport("user32.dll")] public static extern uint GetDpiForSystem(); }' -ErrorAction SilentlyContinue
$script:DpiScale = 1.0
try {
  $dpiValue = [DpiProbe2]::GetDpiForSystem()
  if ($dpiValue -gt 0) { $script:DpiScale = [double]$dpiValue / 96.0 }
} catch { }

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
$script:RefreshMs = 60000
$script:HttpTimeoutSec = 8
$script:PetWidth = 336
$script:PetHeight = 648
$script:ModeCount = 3
$script:Zoom = 1.0      # 宠物缩放比例（0.5x - 2.5x）
$script:ZoomMin = 0.5
$script:ZoomMax = 2.5

# WSL 凭据（独立模式）：用环境变量覆盖；默认自动读取当前 Windows 用户名。
$script:WslDistro = if ($env:DSH_WHALE_PET_WSL_DISTRO) { $env:DSH_WHALE_PET_WSL_DISTRO } else { 'Ubuntu' }
$script:WslUser = if ($env:DSH_WHALE_PET_WSL_USER) { $env:DSH_WHALE_PET_WSL_USER } else { $env:USERNAME }
$script:CredentialsUnc = "\\wsl.localhost\$($script:WslDistro)\home\$($script:WslUser)\.dsh\.credentials.yaml"

# 资源目录（立绘切分贴图，与脚本同目录 assets/）
$script:AssetDir = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'assets' } else { 'assets' }

# 本地状态（位置 + 余额变化历史）
$script:StateDir = Join-Path $env:APPDATA 'dsh-whale-pet'
if (-not (Test-Path $script:StateDir)) { New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null }
$script:StateFile = Join-Path $script:StateDir 'state.json'

# 运行期状态
$script:Mode = 0                       # 0=余额 1=今日 2=近7天
$script:Data = $null                   # DSH state 或独立模式数据
$script:Source = 'none'                # 'dsh' | 'standalone' | 'none'
$script:FetchError = $null
$script:Fetching = $false
$script:LastFetchAt = 0
$script:BalanceHistory = @{}           # date -> { spend, topup }
$script:LastBalance = $null
$script:LastCurrency = 'CNY'
$script:DragStart = $null              # 拖拽起点
$script:DragMoved = $false
$script:WindowPos = $null

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
function Get-UnixNowMs {
  return [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
}

function Format-Money([double]$amount, [string]$currency, [bool]$approx = $false) {
  $symbol = if ($currency -eq 'USD') { '$' } else { '¥' }
  $prefix = if ($approx) { '≈' } else { '' }
  if ($amount -lt 0.005) { return "$prefix$symbol 0.00" }
  if ($amount -lt 0.01) { return "$prefix$symbol<0.01" }
  return ("{0}{1}{2:N2}" -f $prefix, $symbol, $amount)
}

function Get-LocalDateString([long]$epochMs) {
  $dt = [DateTimeOffset]::FromUnixTimeMilliseconds($epochMs).ToLocalTime()
  return $dt.ToString('yyyy-MM-dd')
}

function ConvertTo-Finite([object]$value) {
  $n = 0.0
  if ($value -is [double] -or $value -is [int] -or $value -is [long]) { $n = [double]$value }
  elseif ($value -is [string]) { [double]::TryParse($value, [ref]$n) | Out-Null }
  # PS 5.1（.NET Framework）没有 double.IsFinite，用 NaN/Infinity 组合判断
  if ([double]::IsNaN($n) -or [double]::IsInfinity($n)) { $n = 0.0 }
  return $n
}

# ---------------------------------------------------------------------------
# 本地状态（位置记忆 + 余额变化历史）
# ---------------------------------------------------------------------------
function Read-LocalState {
  try {
    if (Test-Path $script:StateFile) {
      $raw = Get-Content $script:StateFile -Raw -ErrorAction Stop
      $obj = $raw | ConvertFrom-Json
      if ($null -ne $obj.pos) {
        $script:WindowPos = @{ x = [double]$obj.pos.x; y = [double]$obj.pos.y }
      }
      if ($null -ne $obj.lastBalance) { $script:LastBalance = [double]$obj.lastBalance }
      if ($null -ne $obj.currency) { $script:LastCurrency = [string]$obj.currency }
      if ($null -ne $obj.zoom -and [double]$obj.zoom -gt 0) {
        $script:Zoom = [Math]::Max($script:ZoomMin, [Math]::Min($script:ZoomMax, [double]$obj.zoom))
      }
      if ($null -ne $obj.history) {
        foreach ($entry in $obj.history) {
          $script:BalanceHistory[[string]$entry.date] = @{
            spend = [double]$entry.spend
            topup = [double]$entry.topup
          }
        }
      }
    }
  } catch {
    # 损坏状态文件直接忽略
  }
}

function Save-LocalState {
  try {
    $historyArray = @()
    foreach ($date in ($script:BalanceHistory.Keys | Sort-Object)) {
      $entry = $script:BalanceHistory[$date]
      $historyArray += @{ date = $date; spend = [math]::Round($entry.spend, 4); topup = [math]::Round($entry.topup, 4) }
    }
    $payload = @{
      pos = $script:WindowPos
      zoom = [Math]::Round($script:Zoom, 3)
      lastBalance = $script:LastBalance
      currency = $script:LastCurrency
      history = $historyArray
    } | ConvertTo-Json -Compress -Depth 5
    Set-Content -Path $script:StateFile -Value $payload -Encoding UTF8
  } catch {
    # 写失败不影响运行
  }
}

# 记录一次观测到的余额变动：负 delta = 消费，正 delta = 充值（不计入消费）
function Record-BalanceObservation([double]$balance, [string]$currency) {
  $today = Get-LocalDateString (Get-UnixNowMs)
  if (-not $script:BalanceHistory.ContainsKey($today)) {
    $script:BalanceHistory[$today] = @{ spend = 0.0; topup = 0.0 }
  }
  if ($null -eq $script:LastBalance -or $script:LastCurrency -ne $currency) {
    # 首次观测 / 币种变化：仅建立基线
    $script:LastBalance = $balance
    $script:LastCurrency = $currency
    Save-LocalState
    return
  }
  $delta = $balance - $script:LastBalance
  if ([math]::Abs($delta) -ge 0.005) {
    $entry = $script:BalanceHistory[$today]
    if ($delta -lt 0) { $entry.spend += -$delta } else { $entry.topup += $delta }
    $script:LastBalance = $balance
    $script:LastCurrency = $currency
    Save-LocalState
  }
}

# 余额变化推算的消费窗口
function Get-DeltaSpend([int]$days) {
  $today = Get-LocalDateString (Get-UnixNowMs)
  $start = (Get-Date).AddDays(-($days - 1)).ToString('yyyy-MM-dd')
  $total = 0.0
  foreach ($date in $script:BalanceHistory.Keys) {
    if ($date -ge $start -and $date -le $today) {
      $total += $script:BalanceHistory[$date].spend
    }
  }
  return $total
}

# ---------------------------------------------------------------------------
# 数据获取：DSH 模式优先，独立模式兜底
# ---------------------------------------------------------------------------
function Get-DshApiKey {
  # 独立模式：从 WSL 凭据文件读 DEEPSEEK_API_KEY
  try {
    if (Test-Path $script:CredentialsUnc) {
      $content = Get-Content $script:CredentialsUnc -Raw -ErrorAction Stop
      $match = [regex]::Match($content, 'DEEPSEEK_API_KEY:\s*(.+?)[\r\n]')
      if ($match.Success) {
        $key = $match.Groups[1].Value.Trim().Trim('"').Trim("'")
        if ($key.Length -gt 8) { return $key }
      }
    }
  } catch {
    # fall through
  }
  return $null
}

# 同步获取（在后台任务线程执行，避免阻塞 UI）
function Fetch-State {
  $result = @{ source = 'none'; data = $null; error = $null }

  # --- 尝试 DSH 模式 ---
  # 可用环境变量 DSH_WHALE_PET_DSH_URL 覆盖数据源地址（默认 WSL DSH GUI）
  $dshUrl = if ($env:DSH_WHALE_PET_DSH_URL) { $env:DSH_WHALE_PET_DSH_URL } else { 'http://127.0.0.1:3080/api/whale-pet/state' }
  try {
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($script:HttpTimeoutSec)
    $resp = $client.GetAsync($dshUrl).Result
    if ($resp.IsSuccessStatusCode) {
      $json = $resp.Content.ReadAsStringAsync().Result
      $obj = $json | ConvertFrom-Json
      if ($obj.ok) {
        $result.source = 'dsh'
        $result.data = $obj
        $result.error = $null
        $client.Dispose()
        return $result
      }
    }
    $client.Dispose()
  } catch {
    # DSH 不可达 → 独立模式
  }

  # --- 独立模式 ---
  try {
    $key = Get-DshApiKey
    if ($null -eq $key) {
      $result.error = 'no-key'
      return $result
    }
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($script:HttpTimeoutSec)
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, 'https://api.deepseek.com/user/balance')
    $req.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $key)
    $resp = $client.SendAsync($req).Result
    if ($resp.IsSuccessStatusCode) {
      $json = $resp.Content.ReadAsStringAsync().Result
      $body = $json | ConvertFrom-Json
      $info = $null
      foreach ($candidate in $body.balance_infos) {
        if ($candidate.currency -eq 'CNY') { $info = $candidate; break }
      }
      if ($null -eq $info) { $info = $body.balance_infos[0] }
      $result.source = 'standalone'
      $result.data = @{
        fetchedAt = Get-UnixNowMs
        balance = @{
          available = $body.is_available
          currency = $info.currency
          totalBalance = ConvertTo-Finite $info.total_balance
          grantedBalance = ConvertTo-Finite $info.granted_balance
          toppedUpBalance = ConvertTo-Finite $info.topped_up_balance
        }
        spend = $null
      }
      $result.error = $null
    } else {
      $result.error = "http-$($resp.StatusCode)"
    }
    $client.Dispose()
  } catch {
    $result.error = $_.Exception.Message
  }
  return $result
}

# ---------------------------------------------------------------------------
# 气泡内容
# ---------------------------------------------------------------------------
function Get-BubbleContent {
  $title = '加载中…'
  $sub = '正在询问深海'
  $cls = 'normal'   # normal | low | error
  $currency = 'CNY'
  $approx = $false
  $calls = 0

  if ($null -ne $script:Data -and $null -ne $script:Data.balance) {
    $currency = $script:Data.balance.currency
  }

  if ($script:Source -eq 'none' -and $null -ne $script:FetchError) {
    $title = '鲸鱼连不上深海'
    $sub = '点我重试 · 每 60s 自动刷新'
    $cls = 'error'
    return @{ title = $title; sub = $sub; cls = $cls; currency = $currency; approx = $approx; calls = $calls }
  }

  if ($null -eq $script:Data) {
    return @{ title = $title; sub = $sub; cls = $cls; currency = $currency; approx = $approx; calls = $calls }
  }

  if ($script:Mode -eq 0) {
    $balance = $script:Data.balance
    if ($null -eq $balance -or $null -eq $balance.totalBalance) {
      $title = '余额不可用'
      $sub = '检查 DEEPSEEK_API_KEY'
      $cls = 'error'
    } else {
      $title = '余额 ' + (Format-Money ([double]$balance.totalBalance) $balance.currency)
      $time = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$script:Data.fetchedAt).ToLocalTime().ToString('HH:mm:ss')
      $parts = @("更新于 $time")
      if ($script:Source -eq 'dsh') {
        if ($null -ne $balance.toppedUpBalance) { $parts += '充值 ' + (Format-Money ([double]$balance.toppedUpBalance) $balance.currency) }
      } else {
        $parts += '独立模式'
      }
      $sub = $parts -join ' · '
      $cls = if ($balance.currency -eq 'CNY' -and [double]$balance.totalBalance -lt 10) { 'low' } else { 'normal' }
    }
  } elseif ($script:Mode -eq 1) {
    if ($script:Source -eq 'dsh' -and $null -ne $script:Data.spend) {
      $amount = [double]$script:Data.spend.today.amount
      $calls = [int]$script:Data.spend.today.calls
      $title = '今日消费 ' + (Format-Money $amount $currency)
      $sub = "余额变化 · $calls 次调用"
    } else {
      $amount = Get-DeltaSpend 1
      $title = '今日消费 ' + (Format-Money $amount $currency)
      $sub = '余额变化'
    }
  } else {
    if ($script:Source -eq 'dsh' -and $null -ne $script:Data.spend) {
      $amount = [double]$script:Data.spend.days7.amount
      $calls = [int]$script:Data.spend.days7.calls
      $title = '近 7 天消费 ' + (Format-Money $amount $currency)
      $sub = "余额变化 · $calls 次调用"
    } else {
      $amount = Get-DeltaSpend 7
      $title = '近 7 天消费 ' + (Format-Money $amount $currency)
      $sub = '余额变化'
    }
  }
  return @{ title = $title; sub = $sub; cls = $cls; currency = $currency; approx = $approx; calls = $calls }
}

# ---------------------------------------------------------------------------
# WPF：鲸鱼图形（由 SVG 转换，viewBox 220×170 → 148×112）
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 角色渲染（立绘切分叠层：全图 + 闭眼贴图×2 + 尾巴 + 呆毛）
# 素材位于脚本同目录 assets/（由 make-assets.mjs 生成）
# ---------------------------------------------------------------------------
$script:CharScale = 0.4493   # 690×1215 -> 310×546

function New-CharacterCanvas {
  $scale = $script:CharScale
  $canvas = [System.Windows.Controls.Canvas]::new()
  $canvas.Width = 310
  $canvas.Height = 546

  $full = New-Object System.Windows.Controls.Image
  # 睁/闭两张图预解码并冻结（OnLoad）：眨眼=单元素切换 Source，光栅化完全一致
  $load = { param($path)
    $bmp = [System.Windows.Media.Imaging.BitmapImage]::new()
    $bmp.BeginInit()
    $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bmp.UriSource = [System.Uri]::new($path)
    $bmp.EndInit()
    $bmp.Freeze()
    return $bmp
  }
  $openSrc = & $load (Join-Path $script:AssetDir 'whale-maid.png')
  $full.Source = $openSrc
  $full.Width = 690 * $scale
  $full.Height = 1215 * $scale
  [System.Windows.Controls.Canvas]::SetLeft($full, 0)
  [System.Windows.Controls.Canvas]::SetTop($full, 0)
  $canvas.Children.Add($full) | Out-Null

  # 尾巴（先于全图？不——全图包含尾巴，独立元素叠在上层，静止时完全重合）
  $tailImg = New-Object System.Windows.Controls.Image
  $tailImg.Source = [System.Windows.Media.Imaging.BitmapImage]::new(
    [System.Uri]::new((Join-Path $script:AssetDir 'tail.png')))
  $tailImg.Width = 220 * $scale
  $tailImg.Height = 315 * $scale
  $tailRotate = [System.Windows.Media.RotateTransform]::new(0)
  $tailImg.RenderTransform = $tailRotate
  $tailImg.RenderTransformOrigin = [System.Windows.Point]::new(0.341, 0.317)  # 根部 (545,600)
  [System.Windows.Controls.Canvas]::SetLeft($tailImg, 470 * $scale)
  [System.Windows.Controls.Canvas]::SetTop($tailImg, 500 * $scale)
  $canvas.Children.Add($tailImg) | Out-Null

  # 呆毛
  $ahogeImg = New-Object System.Windows.Controls.Image
  $ahogeImg.Source = [System.Windows.Media.Imaging.BitmapImage]::new(
    [System.Uri]::new((Join-Path $script:AssetDir 'ahoge.png')))
  $ahogeImg.Width = 115 * $scale
  $ahogeImg.Height = 90 * $scale
  $ahogeRotate = [System.Windows.Media.RotateTransform]::new(0)
  $ahogeImg.RenderTransform = $ahogeRotate
  $ahogeImg.RenderTransformOrigin = [System.Windows.Point]::new(0.409, 0.944)  # 根部 (47,85)
  [System.Windows.Controls.Canvas]::SetLeft($ahogeImg, 215 * $scale)
  [System.Windows.Controls.Canvas]::SetTop($ahogeImg, 15 * $scale)
  $canvas.Children.Add($ahogeImg) | Out-Null



  # 整体变换组：呼吸平移 + 微倾斜 + 鼠标注视（平移+倾角）
  $group = [System.Windows.Media.TransformGroup]::new()
  $breath = [System.Windows.Media.TranslateTransform]::new(0, 0)
  $tilt = [System.Windows.Media.RotateTransform]::new(0, 155, 546)
  $look = [System.Windows.Media.TranslateTransform]::new(0, 0)
  $lookTilt = [System.Windows.Media.RotateTransform]::new(0, 155, 546)
  $group.Children.Add($breath) | Out-Null
  $group.Children.Add($tilt) | Out-Null
  $group.Children.Add($look) | Out-Null
  $group.Children.Add($lookTilt) | Out-Null
  $canvas.RenderTransform = $group

  return @{
    canvas = $canvas
    breath = $breath
    tilt = $tilt
    look = $look
    lookTilt = $lookTilt
    tailRotate = $tailRotate
    ahogeRotate = $ahogeRotate
    full = $full
    openSrc = $openSrc
  }
}

# ---------------------------------------------------------------------------
# Live2D 风格动画
# ---------------------------------------------------------------------------
function Start-CharacterAnimations($char) {
  # 呼吸浮动：整体 ±6px（更明显）
  $breath = [System.Windows.Media.Animation.DoubleAnimation]::new()
  $breath.From = 0.0; $breath.To = -6.0
  $breath.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds(3.2))
  $breath.AutoReverse = $true
  $breath.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $char.breath.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $breath)

  # 微倾斜：整体 ±1.6 度（底部为轴）
  $tilt = [System.Windows.Media.Animation.DoubleAnimation]::new()
  $tilt.From = -1.6; $tilt.To = 1.6
  $tilt.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds(6))
  $tilt.AutoReverse = $true
  $tilt.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $char.tilt.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $tilt)

  # 尾巴摆动：±10 度
  $wag = [System.Windows.Media.Animation.DoubleAnimation]::new()
  $wag.From = -3.0; $wag.To = 10.0
  $wag.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds(4.2))
  $wag.AutoReverse = $true
  $wag.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $char.tailRotate.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $wag)

  # 呆毛摆动：±9 度
  $ahoge = [System.Windows.Media.Animation.DoubleAnimation]::new()
  $ahoge.From = -9.0; $ahoge.To = 9.0
  $ahoge.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds(2.6))
  $ahoge.AutoReverse = $true
  $ahoge.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  $char.ahogeRotate.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $ahoge)

}

# ---------------------------------------------------------------------------
# 系统托盘图标：任务栏通知区出现鲸鱼图标，右键菜单操作宠物
# ---------------------------------------------------------------------------
function New-TrayIcon {
  # 从立绘头部生成 32x32 图标
  $iconBitmap = $null
  $icon = $null
  try {
    $src = [System.Drawing.Bitmap]::new((Join-Path $script:AssetDir 'whale-maid.png'))
    $crop = New-Object System.Drawing.Bitmap(32, 32)
    $g = [System.Drawing.Graphics]::FromImage($crop)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.Clear([System.Drawing.Color]::FromArgb(255, 77, 107, 254))   # DeepSeek 蓝底
    # 立绘头部区域（约 150-540, 20-420）按方形取中
    $g.DrawImage($src, [System.Drawing.Rectangle]::new(2, 2, 28, 28),
      [System.Drawing.Rectangle]::new(210, 40, 270, 340), [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($crop.GetHicon())
    $iconBitmap = $crop
  } catch {
    $icon = [System.Drawing.SystemIcons]::Application
  }

  $notify = New-Object System.Windows.Forms.NotifyIcon
  if ($null -ne $icon) { $notify.Icon = $icon }
  $notify.Text = '大肥鲸桌面宠物'
  $notify.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $showItem = New-Object System.Windows.Forms.ToolStripMenuItem('显示 / 隐藏')
  $showItem.add_Click({ Toggle-PetVisibility })
  $refreshItem = New-Object System.Windows.Forms.ToolStripMenuItem('立即刷新数据')
  $refreshItem.add_Click({ Start-Refresh })
  $sep1 = New-Object System.Windows.Forms.ToolStripSeparator
  $zoomInItem = New-Object System.Windows.Forms.ToolStripMenuItem('放大 (+10%)')
  $zoomInItem.add_Click({
    $script:Zoom = [Math]::Min($script:ZoomMax, $script:Zoom * 1.1)
    Apply-Zoom; Save-LocalState
  })
  $zoomOutItem = New-Object System.Windows.Forms.ToolStripMenuItem('缩小 (-10%)')
  $zoomOutItem.add_Click({
    $script:Zoom = [Math]::Max($script:ZoomMin, $script:Zoom / 1.1)
    Apply-Zoom; Save-LocalState
  })
  $zoomResetItem = New-Object System.Windows.Forms.ToolStripMenuItem('重置大小')
  $zoomResetItem.add_Click({ $script:Zoom = 1.0; Apply-Zoom; Save-LocalState })
  $sep2 = New-Object System.Windows.Forms.ToolStripSeparator
  $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem('退出大肥鲸')
  $exitItem.add_Click({ $window.Close() })
  $menu.Items.Add($showItem) | Out-Null
  $menu.Items.Add($refreshItem) | Out-Null
  $menu.Items.Add($sep1) | Out-Null
  $menu.Items.Add($zoomInItem) | Out-Null
  $menu.Items.Add($zoomOutItem) | Out-Null
  $menu.Items.Add($zoomResetItem) | Out-Null
  $menu.Items.Add($sep2) | Out-Null
  $menu.Items.Add($exitItem) | Out-Null
  $notify.ContextMenuStrip = $menu

  # 双击托盘图标 = 显示/隐藏
  $notify.add_MouseDoubleClick({
    param($sender, $e)
    if ($e.Button -eq 'Left') { Toggle-PetVisibility }
  })

  $script:NotifyIcon = $notify
  if ($null -ne $iconBitmap) { $iconBitmap.Dispose() }
}

function Toggle-PetVisibility {
  $ui = $script:UI
  if ($null -eq $ui) { return }
  if ($ui.window.Visibility -eq 'Visible') { $ui.window.Visibility = 'Hidden' }
  else { $ui.window.Visibility = 'Visible' }
}

# 冻结一切动画（渲染校验用：让两帧差异只来自闭眼图层本身）
function Stop-CharacterAnimations($char) {
  $char.breath.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $char.tilt.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $char.tailRotate.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $char.ahogeRotate.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
}

# ---------------------------------------------------------------------------
# 眨眼状态机 + 随机小动作（Live2D 风格）
# ---------------------------------------------------------------------------
$script:BlinkState = @{ phase = 'open'; t = 0.0; next = 4.2 }
$script:ActState = @{ busy = $false; act = ''; t = 0.0; dur = 0.0; amp = 0.0; gap = 6.0 }

function Update-Blink {
  # 眨眼特效已移除：保持睁眼状态，无操作
}

function Trigger-RandomAction {
  $a = $script:ActState
  if ($a.busy) { return }
  $roll = Get-Random -Maximum 100
  if ($roll -lt 42) {
    # 歪头
    $a.act = 'tilt'; $a.amp = if ((Get-Random -Maximum 2) -eq 0) { 3.6 } else { -3.6 }
    $a.dur = 1.4; $a.t = 0.0; $a.busy = $true
  } elseif ($roll -lt 72) {
    # 轻跳（小幅上浮）
    $a.act = 'hop'; $a.amp = -11.0
    $a.dur = 0.9; $a.t = 0.0; $a.busy = $true
  } else {
    # 摇摆（快速左右微倾两下）
    $a.act = 'sway'; $a.amp = 2.2
    $a.dur = 1.1; $a.t = 0.0; $a.busy = $true
  }
}

function Update-Act {
  $a = $script:ActState
  if (-not $a.busy) {
    $a.gap -= 0.15
    if ($a.gap -le 0) {
      Trigger-RandomAction
      $a.gap = 5.0 + (Get-Random -Maximum 700) / 100.0   # 每次触发后 5-12s 再随机
    }
    return
  }
  $a.t += 0.05
  # 渲染统一由 Update-Look 按 act 状态合成；这里只维护状态机与随机节奏
  if ($a.t -ge $a.dur) {
    $a.busy = $false; $a.act = ''
  }
}

# ---------------------------------------------------------------------------
# 主窗口
# ---------------------------------------------------------------------------
function New-PetWindow {
  $window = [System.Windows.Window]::new()
  $window.Width = $script:PetWidth
  $window.Height = $script:PetHeight
  $window.WindowStyle = 'None'
  $window.AllowsTransparency = $true
  $window.Background = [System.Windows.Media.Brushes]::Transparent
  $window.Topmost = $true
  $window.ShowInTaskbar = $false
  $window.ResizeMode = 'NoResize'
  $window.WindowStartupLocation = 'Manual'

  # 位置：记忆 or 右下角
  $work = [System.Windows.SystemParameters]::WorkArea
  if ($null -ne $script:WindowPos) {
    $x = [math]::Max($work.Left, [math]::Min([double]$script:WindowPos.x, $work.Right - $window.Width))
    $y = [math]::Max($work.Top, [math]::Min([double]$script:WindowPos.y, $work.Bottom - $window.Height))
    $window.Left = $x
    $window.Top = $y
  } else {
    $window.Left = $work.Right - $window.Width - 16
    $window.Top = $work.Bottom - $window.Height - 16
  }

  # ---- 气泡 ----
  $bubbleBorder = [System.Windows.Controls.Border]::new()
  $bubbleBorder.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(235, 20, 24, 34))
  $bubbleBorder.CornerRadius = [System.Windows.CornerRadius]::new(12)
  $bubbleBorder.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(90, 120, 140, 190))
  $bubbleBorder.BorderThickness = [System.Windows.Thickness]::new(1)
  $bubbleBorder.Margin = [System.Windows.Thickness]::new(8, 4, 8, 0)
  $bubbleBorder.MaxWidth = 320   # 随窗口缩放动态更新（Apply-Zoom）
  $bubbleBorder.Padding = [System.Windows.Thickness]::new(10, 6, 10, 5)
  $bubbleBorder.Effect = [System.Windows.Media.Effects.DropShadowEffect]::new()
  $bubbleBorder.Effect.BlurRadius = 14
  $bubbleBorder.Effect.ShadowDepth = 3
  $bubbleBorder.Effect.Opacity = 0.5

  $bubbleStack = [System.Windows.Controls.StackPanel]::new()

  # 标题行：状态点 + 可换行标题（Grid 两列）
  $titlePanel = [System.Windows.Controls.Grid]::new()
  $colDot = [System.Windows.Controls.ColumnDefinition]::new()
  $colDot.Width = [System.Windows.GridLength]::new(16)
  $colTitle = [System.Windows.Controls.ColumnDefinition]::new()
  $colTitle.Width = [System.Windows.GridLength]::new(1, 'Star')
  $titlePanel.ColumnDefinitions.Add($colDot) | Out-Null
  $titlePanel.ColumnDefinitions.Add($colTitle) | Out-Null

  $dot = [System.Windows.Shapes.Ellipse]::new()
  $dot.Width = 7; $dot.Height = 7
  $dot.VerticalAlignment = 'Top'
  $dot.Margin = [System.Windows.Thickness]::new(0, 3, 6, 0)
  $dot.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#3FB950')
  [System.Windows.Controls.Grid]::SetColumn($dot, 0)
  $titlePanel.Children.Add($dot) | Out-Null

  $titleText = [System.Windows.Controls.TextBlock]::new()
  $titleText.FontSize = 13
  $titleText.FontWeight = 'Bold'
  $titleText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#E6E8EB')
  $titleText.Text = '加载中…'
  $titleText.TextWrapping = 'Wrap'
  $titleText.TextAlignment = 'Center'
  [System.Windows.Controls.Grid]::SetColumn($titleText, 1)
  $titlePanel.Children.Add($titleText) | Out-Null

  $subText = [System.Windows.Controls.TextBlock]::new()
  $subText.FontSize = 10.5
  $subText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#9AA4B2')
  $subText.Text = '正在询问深海'
  $subText.TextWrapping = 'Wrap'
  $subText.TextAlignment = 'Center'
  $subText.HorizontalAlignment = 'Center'
  $subText.Margin = [System.Windows.Thickness]::new(0, 1, 0, 0)

  $bubbleStack.Children.Add($titlePanel) | Out-Null
  $bubbleStack.Children.Add($subText) | Out-Null
  $bubbleBorder.Child = $bubbleStack

  # 气泡箭头
  $arrowCanvas = [System.Windows.Controls.Canvas]::new()
  $arrowCanvas.Width = 318; $arrowCanvas.Height = 8
  $arrowPoly = [System.Windows.Shapes.Polygon]::new()
  $arrowPoly.Points = [System.Windows.Media.PointCollection]::new()
  $arrowPoly.Points.Add([System.Windows.Point]::new(152, 0))
  $arrowPoly.Points.Add([System.Windows.Point]::new(166, 0))
  $arrowPoly.Points.Add([System.Windows.Point]::new(159, 8))
  $arrowPoly.Fill = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(235, 20, 24, 34))
  $arrowCanvas.Children.Add($arrowPoly) | Out-Null

  # ---- 鲸鱼 ----
  $script:character = New-CharacterCanvas

  # ---- 分页点 ----
  $pager = [System.Windows.Controls.StackPanel]::new()
  $pager.Orientation = 'Horizontal'
  $pager.HorizontalAlignment = 'Center'
  $pager.Margin = [System.Windows.Thickness]::new(0, 3, 0, 0)
  $script:PagerDots = @()
  for ($i = 0; $i -lt $script:ModeCount; $i++) {
    $dotEl = [System.Windows.Shapes.Ellipse]::new()
    $dotEl.Width = 5; $dotEl.Height = 5
    $dotEl.Margin = [System.Windows.Thickness]::new(3, 0, 3, 0)
    $dotEl.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#6B7280')
    $pager.Children.Add($dotEl) | Out-Null
    $script:PagerDots += $dotEl
  }

  # ---- 布局：角色层（Viewbox 缩放）与气泡层（固定不缩放，文字始终可读） ----
  $grid = [System.Windows.Controls.Grid]::new()
  $grid.Width = $script:PetWidth
  $grid.Height = $script:PetHeight

  # 角色层：角色 + 分页点固定布局 336×648，缩放走 RenderTransform（气泡保持固定不缩放）
  $charStack = [System.Windows.Controls.StackPanel]::new()
  $charStack.Width = $script:PetWidth
  $charStack.Height = $script:PetHeight
  $charStack.Margin = [System.Windows.Thickness]::new(0, 0, 0, 0)
  $charStack.HorizontalAlignment = 'Left'
  $charStack.VerticalAlignment = 'Top'
  # 预置 RenderTransform（创建时设置，避免显示后赋值异常）
  $charStack.RenderTransform = [System.Windows.Media.ScaleTransform]::new(1, 1)
  $charInner = [System.Windows.Controls.StackPanel]::new()
  $charInner.Margin = [System.Windows.Thickness]::new(0, 62, 0, 0)   # 顶部给气泡留位
  $charInner.Children.Add($script:character.canvas) | Out-Null
  $charInner.Children.Add($pager) | Out-Null
  $charStack.Children.Add($charInner) | Out-Null
  $grid.Children.Add($charStack) | Out-Null

  # 气泡层：固定在窗口顶部居中，文字字号恒定，不随缩放变化
  $bubbleStack = [System.Windows.Controls.StackPanel]::new()
  $bubbleStack.HorizontalAlignment = 'Center'
  $bubbleStack.VerticalAlignment = 'Top'
  $bubbleStack.Margin = [System.Windows.Thickness]::new(0, 6, 0, 0)
  $bubbleStack.Children.Add($bubbleBorder) | Out-Null
  $bubbleStack.Children.Add($arrowCanvas) | Out-Null
  $grid.Children.Add($bubbleStack) | Out-Null

  $window.Content = $grid
  $root = $grid

  # ---- 交互：拖拽 + 单击切换 ----
  # 拖拽位移基于 PointToScreen（WPF 逻辑屏幕坐标），窗口移动后自动校正，
  # 鼠标相对窗口坐标不再漂移 → 消除左右晃动；DPI 缩放兼容。
  $window.add_MouseLeftButtonDown({
    param($sender, $e)
    $start = $window.PointToScreen($e.GetPosition($window))
    $script:DragStart = @{ sx = $start.X; sy = $start.Y; wx = $window.Left; wy = $window.Top }
    $script:DragMoved = $false
    $window.CaptureMouse()
  })
  $window.add_MouseMove({
    param($sender, $e)
    if ($null -ne $script:DragStart) {
      $pos = $window.PointToScreen($e.GetPosition($window))
      $dx = $pos.X - $script:DragStart.sx
      $dy = $pos.Y - $script:DragStart.sy
      if (-not $script:DragMoved -and ([math]::Abs($dx) + [math]::Abs($dy)) -gt 4) {
        $script:DragMoved = $true
      }
      if ($script:DragMoved) {
        # PointToScreen 为设备像素，Left/Top 为 DIP：除以 DPI 缩放比（175% -> /1.75）
        $window.Left = $script:DragStart.wx + $dx / $script:DpiScale
        $window.Top = $script:DragStart.wy + $dy / $script:DpiScale
        # 追踪：记录鼠标位移与窗口位移（诊断用）
        $script:DragTrace = @{ mx = $dx; my = $dy; wx = $window.Left - $script:DragStart.wx; wy = $window.Top - $script:DragStart.wy }
      }
    }
  })
  $window.add_MouseLeftButtonUp({
    param($sender, $e)
    $window.ReleaseMouseCapture()
    if ($null -ne $script:DragStart) {
      if (-not $script:DragMoved) {
        # 单击 → 切换模式
        $script:Mode = ($script:Mode + 1) % $script:ModeCount
        Update-Bubble
      } else {
        # 记录拖拽校准数据（诊断用）
        try {
          if ($null -ne $script:DragTrace) {
            $traceLine = ("drag mouse=({0:N1},{1:N1}) win=({2:N1},{3:N1}) dpiScale={4:N2} at {5}" -f `
              $script:DragTrace.mx, $script:DragTrace.my, $script:DragTrace.wx, $script:DragTrace.wy, $script:DpiScale, (Get-Date -Format 'HH:mm:ss'))
            Add-Content -Path (Join-Path $script:StateDir 'trace.log') -Value $traceLine -Encoding UTF8
          }
        } catch { }
        # 记住新位置
        $work = [System.Windows.SystemParameters]::WorkArea
        $script:WindowPos = @{
          x = [math]::Max($work.Left, [math]::Min($window.Left, $work.Right - $window.Width))
          y = [math]::Max($work.Top, [math]::Min($window.Top, $work.Bottom - $window.Height))
        }
        Save-LocalState
      }
      $script:DragStart = $null
    }
  })

  # ---- 窗口创建后应用工具窗口样式（任务栏/Alt-Tab 不可见） ----
  $window.add_SourceInitialized({
    try {
      $hwnd = [System.Windows.Interop.WindowInteropHelper]::new($window).Handle
      if ($hwnd -ne [IntPtr]::Zero -and [W32Window]::GetWindowLong($hwnd, -20) -ne 0) {
        $exStyle = [W32Window]::GetWindowLong($hwnd, -20)
        [W32Window]::SetWindowLong($hwnd, -20, $exStyle -bor 0x80)   # WS_EX_TOOLWINDOW
      }
    } catch { }
  })

  # ---- 滚轮缩放（悬浮在宠物上滚动） ----
  $window.add_MouseWheel({
    param($sender, $e)
    if ($e.Delta -gt 0) { $script:Zoom = [Math]::Min($script:ZoomMax, $script:Zoom * 1.1) }
    elseif ($e.Delta -lt 0) { $script:Zoom = [Math]::Max($script:ZoomMin, $script:Zoom / 1.1) }
    Apply-Zoom
    Save-LocalState
    $e.Handled = $true
  })

  # ---- 右键菜单：退出 ----
  $menu = [System.Windows.Controls.ContextMenu]::new()
  $exitItem = [System.Windows.Controls.MenuItem]::new()
  $exitItem.Header = '退出大肥鲸'
  $exitItem.add_Click({
    $window.Close()
  })
  $menu.Items.Add($exitItem) | Out-Null
  $refreshItem = [System.Windows.Controls.MenuItem]::new()
  $refreshItem.Header = '立即刷新'
  $refreshItem.add_Click({
    Start-Refresh
  })
  $menu.Items.Add($refreshItem) | Out-Null
  $zoomInItem = [System.Windows.Controls.MenuItem]::new()
  $zoomInItem.Header = '放大 (+10%)'
  $zoomInItem.add_Click({
    $script:Zoom = [Math]::Min($script:ZoomMax, $script:Zoom * 1.1)
    Apply-Zoom
    Save-LocalState
  })
  $menu.Items.Add($zoomInItem) | Out-Null
  $zoomOutItem = [System.Windows.Controls.MenuItem]::new()
  $zoomOutItem.Header = '缩小 (-10%)'
  $zoomOutItem.add_Click({
    $script:Zoom = [Math]::Max($script:ZoomMin, $script:Zoom / 1.1)
    Apply-Zoom
    Save-LocalState
  })
  $menu.Items.Add($zoomOutItem) | Out-Null
  $zoomResetItem = [System.Windows.Controls.MenuItem]::new()
  $zoomResetItem.Header = '重置大小'
  $zoomResetItem.add_Click({
    $script:Zoom = 1.0
    Apply-Zoom
    Save-LocalState
  })
  $menu.Items.Add($zoomResetItem) | Out-Null
  $menu.Items.Add([System.Windows.Controls.Separator]::new()) | Out-Null
  $root.ContextMenu = $menu

  # 返回 UI 引用
  return @{
    window = $window
    root = $root
    charStack = $charStack
    dot = $dot
    titleText = $titleText
    subText = $subText
    bubbleBorder = $bubbleBorder
    whale = $script:character
  }
}

# ---------------------------------------------------------------------------
# 鼠标注视跟随（Live2D 风格）：角色整体朝鼠标方向微移+微倾，无输入 1.5s 回位
# ---------------------------------------------------------------------------
$script:LookState = @{ tx = 0.0; ty = 0.0; ang = 0.0; cx = 0.0; cy = 0.0; ca = 0.0; active = $false; last = 0 }

function Set-LookTarget($e) {
  if ($null -ne $script:DragStart) { return }   # 拖拽中不注视
  $ui = $script:UI
  if ($null -eq $ui) { return }
  $pos = $ui.window.PointToScreen($e.GetPosition($ui.window))
  $cx = $ui.window.Left + $ui.window.Width / 2
  $cy = $ui.window.Top + $ui.window.Height * 0.35
  $dx = [Math]::Max(-120, [Math]::Min(120, ($pos.X - $cx) / $script:DpiScale))
  $dy = [Math]::Max(-70, [Math]::Min(70, ($pos.Y - $cy) / $script:DpiScale))
  $script:LookState.tx = -$dx * 0.05
  $script:LookState.ty = -$dy * 0.06
  $script:LookState.ang = [Math]::Max(-2.6, [Math]::Min(2.6, $dx * 0.022))
  $script:LookState.last = Get-UnixNowMs
  $script:LookState.active = $true
}

function Update-Look {
  $s = $script:LookState
  if ($s.active -and ((Get-UnixNowMs) - $s.last) -gt 1500) {
    $s.active = $false; $s.tx = 0.0; $s.ty = 0.0; $s.ang = 0.0
  }
  $s.cx += ($s.tx - $s.cx) * 0.22
  $s.cy += ($s.ty - $s.cy) * 0.22
  $s.ca += ($s.ang - $s.ca) * 0.22
  $ui = $script:UI
  if ($null -eq $ui -or $null -eq $ui.whale) { return }
  $ui.whale.look.X = $s.cx
  $act = $script:ActState
  $actDy = 0.0
  $actDa = 0.0
  if ($act.busy -and $act.act -eq 'hop') { $actDy = $act.amp * [Math]::Sin([Math]::PI * $act.t / $act.dur) }
  if ($act.busy -and ($act.act -eq 'tilt' -or $act.act -eq 'sway')) { $actDa = $act.amp * [Math]::Sin([Math]::PI * $act.t / $act.dur) }
  $ui.whale.look.Y = $s.cy + $actDy
  $ui.whale.lookTilt.Angle = $s.ca + $actDa
}

# ---------------------------------------------------------------------------
# 缩放：内容整体缩放，窗口尺寸跟随，保持窗口中心不动
# ---------------------------------------------------------------------------
function Apply-Zoom {
  $ui = $script:UI
  $oldW = [double]$ui.window.Width
  $oldH = [double]$ui.window.Height
  $newW = $script:PetWidth * $script:Zoom
  $newH = $script:PetHeight * $script:Zoom
  # 角色层按 zoom 等比缩放（气泡层固定不动）
  if ($null -ne $ui.charStack -and $null -ne $ui.charStack.RenderTransform) {
    $scale = $ui.charStack.RenderTransform
    $scale.ScaleX = $script:Zoom
    $scale.ScaleY = $script:Zoom
  }
  # 气泡动态缩放：宽度随窗口（自适应+换行），字号温和跟随（钳制 0.75-1.4 保可读）
  if ($null -ne $ui.bubbleBorder) {
    $fontScale = [Math]::Max(0.75, [Math]::Min(1.4, $script:Zoom))
    $ui.titleText.FontSize = 13 * $fontScale
    $ui.subText.FontSize = 10.5 * $fontScale
    $ui.bubbleBorder.MaxWidth = [Math]::Max(96, $newW - 16)
  }
  $cx = $ui.window.Left + $oldW / 2
  $cy = $ui.window.Top + $oldH / 2
  $ui.window.Width = $newW
  $ui.window.Height = $newH
  $ui.window.Left = $cx - $newW / 2
  $ui.window.Top = $cy - $newH / 2
}

# 缩放变体验证（RenderTest 用）：返回各倍率下内容外接边界是否全部落在窗口内
function Test-ZoomExtent {
  $ui = $script:UI
  $results = @()
  foreach ($z in @(0.5, 0.75, 1.0, 1.5, 2.5)) {
    $script:Zoom = $z
    Apply-Zoom
    $ui.window.UpdateLayout()
    $target = [System.Windows.Media.Imaging.RenderTargetBitmap]::new(
      [int]$ui.window.ActualWidth, [int]$ui.window.ActualHeight, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
    $target.Render($ui.window)
    $copy = [System.Windows.Media.Imaging.WriteableBitmap]::new($target)
    $px = New-Object int[] ($copy.PixelWidth * $copy.PixelHeight)
    $copy.CopyPixels($px, $copy.PixelWidth * 4, 0)
    $minX = $copy.PixelWidth; $minY = $copy.PixelHeight; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $copy.PixelHeight; $y++) {
      for ($x = 0; $x -lt $copy.PixelWidth; $x++) {
        if ((($px[$y * $copy.PixelWidth + $x] -shr 24) -band 0xFF) -gt 40) {
          if ($x -lt $minX) { $minX = $x }
          if ($x -gt $maxX) { $maxX = $x }
          if ($y -lt $minY) { $minY = $y }
          if ($y -gt $maxY) { $maxY = $y }
        }
      }
    }
    $contentW = if ($maxX -ge 0) { $maxX - $minX + 1 } else { 0 }
    $contentH = if ($maxY -ge 0) { $maxY - $minY + 1 } else { 0 }
    # 内容应完整落在窗口内（不裁切），且内容外接框等比缩放（≈336x648 x zoom）
    $inside = $maxX -ge 0 -and $contentW -le $copy.PixelWidth -and $contentH -le $copy.PixelHeight
    $ratio = [math]::Round($contentH / 648, 2)

    $results += @{
      zoom = $z
      w = $copy.PixelWidth
      h = $copy.PixelHeight
      contentW = $contentW
      contentH = $contentH
      ratio = $ratio
      inside = $inside
    }
  }
  $script:Zoom = 1.0
  Apply-Zoom
  return $results
}

# ---------------------------------------------------------------------------
# UI 更新
# ---------------------------------------------------------------------------
function Update-Bubble {
  $content = Get-BubbleContent
  $ui = $script:UI
  $ui.titleText.Text = $content.title
  $ui.subText.Text = $content.sub

  # 状态点
  $dotBrush = '#3FB950'
  if ($script:Fetching) { $dotBrush = '#58A6FF' }
  elseif ($content.cls -eq 'error') { $dotBrush = '#F85149' }
  elseif ($script:Source -eq 'none') { $dotBrush = '#D29922' }
  $ui.dot.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString($dotBrush)

  # 气泡配色
  if ($content.cls -eq 'error') {
    $ui.titleText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#F85149')
    $ui.bubbleBorder.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(140, 248, 81, 73))
  } elseif ($content.cls -eq 'low') {
    $ui.titleText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#FFB454')
    $ui.bubbleBorder.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(90, 210, 153, 34))
  } else {
    $ui.titleText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#E6E8EB')
    $ui.bubbleBorder.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(90, 120, 140, 190))
  }

  # 分页点
  for ($i = 0; $i -lt $script:ModeCount; $i++) {
    $dotEl = $script:PagerDots[$i]
    if ($i -eq $script:Mode) {
      $dotEl.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#4D6BFE')
      $dotEl.Width = 6; $dotEl.Height = 6
    } else {
      $dotEl.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#6B7280')
      $dotEl.Width = 5; $dotEl.Height = 5
    }
  }
}

# ---------------------------------------------------------------------------
# 刷新（独立 runspace 拉数据，UI 线程轮询完成）
# ---------------------------------------------------------------------------
function Start-Refresh {
  if ($script:Fetching) { return }
  $script:Fetching = $true
  $script:FetchStartedAt = Get-UnixNowMs
  Update-Bubble

  # 独立 runspace 执行 Fetch-State：拥有自己的线程与 runspace，
  # 不占用 UI runspace（PS 5.1 中 Task.Run 的 scriptblock 无法在
  # ShowDialog 期间运行，必须用独立 runspace）。
  try {
    $fetchPS = [powershell]::Create()
    [void]$fetchPS.AddScript(". '$($PSCommandPath -replace "'", "''")' -AsLibrary; Fetch-State")
    $script:FetchPS = $fetchPS
    $script:FetchAsync = $fetchPS.BeginInvoke()
  } catch {
    $script:Fetching = $false
    $script:FetchError = $_.Exception.Message
    $script:Source = 'none'
    Update-Bubble
  }
}

# 由轮询定时器调用：抓取完成则收尾并更新 UI
function Complete-RefreshIfDone {
  if ($null -eq $script:FetchPS -or $null -eq $script:FetchAsync) { return }

  if ($script:FetchAsync.IsCompleted) {
    $result = $null
    try {
      $out = $script:FetchPS.EndInvoke($script:FetchAsync)
      if ($out -is [System.Collections.ICollection]) {
        if ($out.Count -gt 0) { $result = $out[0] }
      } elseif ($null -ne $out) {
        $result = $out
      }
    } catch {
      $script:FetchError = $_.Exception.Message
    }
    $script:FetchPS.Dispose()
    $script:FetchPS = $null
    $script:FetchAsync = $null
    $script:Fetching = $false

    if ($null -ne $result -and $result -is [hashtable]) {
      $script:Source = $result.source
      $script:Data = $result.data
      $script:FetchError = $result.error
      if ($null -ne $result.data) {
        $script:LastFetchAt = Get-UnixNowMs
        # 始终记录余额观测：消费统一以余额变化为准；DSH 数据中的消费仅用于显示。
        if ($null -ne $result.data.balance -and $null -ne $result.data.balance.totalBalance) {
          Record-BalanceObservation ([double]$result.data.balance.totalBalance) $result.data.balance.currency
        }
      }
    } else {
      $script:Source = 'none'
      if ($null -eq $script:FetchError) { $script:FetchError = 'fetch-empty' }
    }
    Update-Bubble
    return
  }

  # 超时保护：25s 未完成则放弃本次抓取
  if ((Get-UnixNowMs) - $script:FetchStartedAt -gt 25000) {
    try { $script:FetchPS.Stop() } catch { }
    try { $script:FetchPS.Dispose() } catch { }
    $script:FetchPS = $null
    $script:FetchAsync = $null
    $script:Fetching = $false
    $script:FetchError = 'timeout'
    $script:Source = 'none'
    Update-Bubble
  }
}

# ---------------------------------------------------------------------------
# 渲染自检：RenderTest 模式（不依赖真实屏幕）
# ---------------------------------------------------------------------------
function Test-Render {
  $script:UI = New-PetWindow
  $window = $script:UI.window
  $window.Show()
  $window.UpdateLayout()
  Start-CharacterAnimations $script:UI.whale

  # 模拟数据，验证气泡
  $script:Source = 'dsh'
  $script:Data = @{
    fetchedAt = Get-UnixNowMs
    balance = @{ currency = 'CNY'; totalBalance = 11.27; toppedUpBalance = 11.27 }
    spend = @{
      today = @{ amount = 1.94; calls = 178 }
      days7 = @{ amount = 8.83; calls = 522 }
    }
  }
  Update-Bubble

  # 冻结动画：让睁/闭两帧的差异只来自闭眼图层
  Stop-CharacterAnimations $script:UI.whale
  $window.UpdateLayout()

  # 渲染到位图（不依赖屏幕）
  $target = [System.Windows.Media.Imaging.RenderTargetBitmap]::new(
    [int]$window.ActualWidth, [int]$window.ActualHeight, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
  $target.Render($window)
  $encoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
  $frame = [System.Windows.Media.Imaging.BitmapFrame]::Create($target)
  $encoder.Frames.Add($frame) | Out-Null
  $outPath = Join-Path (Get-Location).ProviderPath 'whale-pet-render-test.png'
  $stream = [System.IO.File]::Create($outPath)
  try {
    $encoder.Save($stream)
  } finally {
    $stream.Dispose()
  }

  # 像素统计：非透明像素占比与主色
  $copy = [System.Windows.Media.Imaging.WriteableBitmap]::new($target)
  $pixels = New-Object int[] ($copy.PixelWidth * $copy.PixelHeight)
  $stride = $copy.PixelWidth * 4
  $copy.CopyPixels($pixels, $stride, 0)
  $opaque = 0
  $blueish = 0
  foreach ($p in $pixels) {
    $alpha = ($p -shr 24) -band 0xFF
    if ($alpha -gt 40) {
      $opaque++
      $r = ($p -shr 16) -band 0xFF
      $b = $p -band 0xFF
      if ($b -gt $r -and ($b - $r) -gt 40) { $blueish++ }
    }
  }
  $total = $copy.PixelWidth * $copy.PixelHeight
  Write-Host ("render test: {0}x{1}, opaque {2:P1}, blueish {3:P1} (DpiScale={4:N2})" -f $copy.PixelWidth, $copy.PixelHeight, ($opaque / $total), ($blueish / $total), $script:DpiScale)

  # 缩放验证：各倍率下内容完整落在窗口内（气泡固定层不缩放）
  foreach ($rz in (Test-ZoomExtent)) {
    Write-Host ("zoom OK: {0}x window={1}x{2} content={3}x{4} inside={5}" -f `
      $rz.zoom, $rz.w, $rz.h, $rz.contentW, $rz.contentH, $rz.inside)
  }

  # 注视跟随模拟自检：设置目标 → 泵 1s → 变换应朝目标收敛
  $script:LookState.tx = 6.0; $script:LookState.ty = -4.0; $script:LookState.ang = 2.0
  $script:LookState.active = $true; $script:LookState.last = Get-UnixNowMs
  $pump2 = [System.Windows.Threading.DispatcherFrame]::new()
  $t2 = [System.Windows.Threading.DispatcherTimer]::new()
  $script:LookTick = 0
  $t2.Interval = [TimeSpan]::FromMilliseconds(100)
  $t2.add_Tick({
    try { Update-Look } catch { Write-Host ("LOOKERR: " + $_.Exception.Message) }
    $script:LookTick++
    if ($script:LookTick -ge 10) { $t2.Stop(); $pump2.Continue = $false }
  })
  $t2.Start()
  [System.Windows.Threading.Dispatcher]::PushFrame($pump2)
  Write-Host ("look follow: x={0:N1} y={1:N1} ang={2:N2} cx={3:N1} (target 6,-4,2)" -f `
    $script:UI.whale.look.X, $script:UI.whale.look.Y, $script:UI.whale.lookTilt.Angle, $script:LookState.cx)
  $window.Close()
}

# ---------------------------------------------------------------------------
# 入口（-AsLibrary 时跳过：供独立 runspace 点源复用本文件的函数）
# ---------------------------------------------------------------------------
if (-not $AsLibrary) {
  Read-LocalState

  if ($RenderTest) {
    Test-Render
    exit 0
  }

  if ($SelfTest) {
    # 自检：真实拉取数据并打印气泡内容，验证数据管线
    $script:UI = New-PetWindow
    $window = $script:UI.window
    Start-CharacterAnimations $script:UI.whale
    Start-Refresh
    $check = [System.Windows.Threading.DispatcherTimer]::new()
    $check.Interval = [TimeSpan]::FromMilliseconds(300)
    $check.add_Tick({
      Complete-RefreshIfDone
      if (-not $script:Fetching -and ($null -ne $script:Data -or $null -ne $script:FetchError)) {
        $check.Stop()
        # 依次输出三个模式的显示内容
        for ($m = 0; $m -lt $script:ModeCount; $m++) {
          $script:Mode = $m
          $content = Get-BubbleContent
          Write-Host ("SELFTEST mode={0} title={1} sub={2}" -f $m, $content.title, $content.sub)
        }
        Write-Host ("SELFTEST source={0} err={1}" -f $script:Source, ($script:FetchError -as [string]))
        $window.Close()
      }
    })
    $check.Start()
    $window.ShowDialog() | Out-Null
    exit 0
  }

  if ($DragTest) {
    # 真实拖拽自检（模拟鼠标）：本机 DPI 175%，验证窗口位移 = 鼠标位移 / DpiScale
    $script:UI = New-PetWindow
    $window = $script:UI.window
    $window.Left = 320; $window.Top = 320
    Apply-Zoom
    Start-CharacterAnimations $script:UI.whale
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class MouseSim { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint dwData, UIntPtr extra); }' -ReferencedAssemblies System.Windows.Forms
    $script:DragTestPhase = 0
    $dt = [System.Windows.Threading.DispatcherTimer]::new()
    $dt.Interval = [TimeSpan]::FromMilliseconds(400)
    $dt.add_Tick({
      $phase = $script:DragTestPhase
      if ($phase -eq 0) {
        # 光标移动到窗口中心（物理像素 = DIP × DpiScale）
        $cx = [int]((320 + $window.Width / 2) * $script:DpiScale)
        $cy = [int]((320 + $window.Height / 2) * $script:DpiScale)
        [MouseSim]::SetCursorPos($cx, $cy) | Out-Null
        [MouseSim]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # LEFTDOWN
        $script:DragTestPhase = 1
      } elseif ($phase -eq 1) {
        # 移动 +200, +120 物理像素（20 步平滑）
        $cx = [int]((320 + $window.Width / 2) * $script:DpiScale)
        $cy = [int]((320 + $window.Height / 2) * $script:DpiScale)
        for ($s = 1; $s -le 20; $s++) {
          [MouseSim]::SetCursorPos($cx + [int]($s * 10), $cy + [int]($s * 6)) | Out-Null
          Start-Sleep -Milliseconds 16
        }
        [MouseSim]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # LEFTUP
        $script:DragTestPhase = 2
      } elseif ($phase -eq 2) {
        $dt.Stop()
        $t = $script:DragTrace
        Write-Host ("DRAGTEST: mouse=({0:N1},{1:N1}) window=({2:N1},{3:N1}) dpiScale={4:N2} expectedWin=({5:N1},{6:N1})" -f `
          $t.mx, $t.my, $t.wx, $t.wy, $script:DpiScale, ($t.mx / $script:DpiScale), ($t.my / $script:DpiScale))
        $window.Close()
      }
    })
    $dt.Start()
    $window.ShowDialog() | Out-Null
    exit 0
  }

  $script:UI = New-PetWindow
  $window = $script:UI.window
  Apply-Zoom
  # Live2D 动画启动（关键：此前主入口漏调，宠物一直是静态的）
  Start-CharacterAnimations $script:UI.whale

  # 鼠标注视跟随：平滑定时器 + 窗口 MouseMove 采样
  $lookTimer = [System.Windows.Threading.DispatcherTimer]::new()
  $lookTimer.Interval = [TimeSpan]::FromMilliseconds(100)
  $lookTimer.add_Tick({ Update-Look })
  $lookTimer.Start()
  $blinkTimer = [System.Windows.Threading.DispatcherTimer]::new()
  $blinkTimer.Interval = [TimeSpan]::FromMilliseconds(50)
  $blinkTimer.add_Tick({ Update-Act })
  $blinkTimer.Start()
  $window.add_MouseMove({ param($sender, $e2) Set-LookTarget $e2 })

  # 系统托盘图标（通知区操作入口）
  New-TrayIcon

  # 首次刷新 + 每 60s
  Start-Refresh
  $timer = [System.Windows.Threading.DispatcherTimer]::new()
  $timer.Interval = [TimeSpan]::FromMilliseconds($script:RefreshMs)
  $timer.add_Tick({ Start-Refresh })
  $timer.Start()

  # 抓取完成轮询（250ms）
  $poll = [System.Windows.Threading.DispatcherTimer]::new()
  $poll.Interval = [TimeSpan]::FromMilliseconds(250)
  $poll.add_Tick({ Complete-RefreshIfDone })
  $poll.Start()

  # 窗口激活时补刷
  $window.add_Activated({ Start-Refresh })

  # 关闭时保存位置并退出
  $window.add_Closed({
    $timer.Stop()
    $poll.Stop()
    $lookTimer.Stop()
    $blinkTimer.Stop()
    if ($null -ne $script:NotifyIcon) { $script:NotifyIcon.Visible = $false; $script:NotifyIcon.Dispose() }
    if ($null -ne $script:WindowPos) { Save-LocalState }
    # 关闭窗口时结束 Dispatcher 消息循环（否则进程永不退出）
    try {
      [System.Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvokeShutdown([System.Windows.Threading.DispatcherPriority]::Send)
    } catch { }
  })

  # 主循环：Show + Dispatcher.Run —— 窗口被隐藏（托盘显示/隐藏）时
  # 消息循环继续运行，进程与托盘图标常驻；窗口关闭时才退出。
  $window.Show()
  [System.Windows.Threading.Dispatcher]::Run()
}
