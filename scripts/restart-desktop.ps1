<#
  restart-desktop.ps1 —— 安全重启 DSH 桌面端（Windows / Electron）

  设计要点（2026-10-02）：
    1. 只用「谁监听 -Port 端口（默认 19387）」+「谁有主窗口」精确定位目标，**绝不按进程名批量杀**；
    2. 先请求主窗口优雅关闭（等价于点 UI 的退出按钮，走同一套 before-quit）；
    3. 超过 -GracefulSeconds 还没退，才强制结束（只针对已确认的那两个 PID）；
    4. 等端口真正释放，再用 WMI Win32_Process.Create 重新拉起
       （父进程是 WmiPrvSE ⇒ 脱离调用方进程树，DSH 自己被杀也不影响重启）；
    5. 全过程写日志，事后可核对。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File restart-desktop.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File restart-desktop.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File restart-desktop.ps1 -DelaySeconds 3 -GracefulSeconds 8
    powershell -NoProfile -ExecutionPolicy Bypass -File restart-desktop.ps1 -StartIfDown   # 没在跑就直接启动
    ... -GracefulMode close|none      # close=只发关窗（实测会缩托盘，无效）；none=跳过优雅直接强杀
    ... -ResultFile <路径>            # 把结果写成 JSON（插件靠它区分「真在重启」与「当场拒绝」）

  优雅策略 -GracefulMode（2026-10-02 实测）：
    session（默认）—— 向主窗口伪造 WM_QUERYENDSESSION + WM_ENDSESSION。Electron 的 before-quit 在
      sessionEnding 分支会**跳过退出确认框直接 finishQuit()**，所以这条有可能真的优雅退出；
      实测若失败，脚本会在超时后强杀（并写日志说明）。
    close —— 只调用 CloseMainWindow()。**实测无效**：该 App 关窗只是缩到托盘
      （证据：userData 下会出现 background-close-confirmed 标记），进程不会退出。
    none  —— 不做优雅尝试，直接强杀，省掉 -GracefulSeconds 的等待。
#>
param(
  [ValidateSet('session', 'close', 'none')]
  [string]$GracefulMode = 'session',
  [switch]$DryRun,
  [switch]$StartIfDown,
  [int]$Port = 19387,
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
  [string]$ResultFile = '',
  [int]$GracefulSeconds = 8,
  [int]$DelaySeconds = 0,
  [int]$WaitReadySeconds = 90,
  [string]$LogFile = (Join-Path $env:TEMP 'dsh-restart-desktop.log')
)

$ErrorActionPreference = 'Continue'

function Write-Log([string]$Message) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
  Write-Host $line
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
}

# 结果回执：插件拉起本脚本后会回读这个文件，用来区分「真在重启」与「当场拒绝」。
# 必须写 UTF-8 **无 BOM**（Node 的 JSON.parse 不认 BOM）。
function Write-Result([string]$Outcome, [string]$Message, [int]$Code = 0) {
  if ([string]::IsNullOrWhiteSpace($ResultFile)) { return }
  try {
    $json = ([ordered]@{
      at      = (Get-Date).ToUniversalTime().ToString('o')
      pid     = $PID
      outcome = $Outcome
      code    = $Code
      message = $Message
    } | ConvertTo-Json -Compress)
    [System.IO.File]::WriteAllText($ResultFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

# 所有出口都走这里：先写回执，再退出。
function Exit-With([int]$Code, [string]$Outcome, [string]$Message) {
  Write-Result -Outcome $Outcome -Message $Message -Code $Code
  exit $Code
}

# 安装目录校验：规范化路径后按「根目录 + 反斜杠」前缀比较。
# 原来的 -like "$InstallRoot*" 通配有两个毛病：'...Harness-evil' 也放行、路径含 [ 会误拒。
function Test-UnderRoot([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  try {
    $rootFull = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    return $pathFull.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

# 伪造系统会话结束所需的 Win32 调用（FindMainWindow 也顺带解决"窗口缩进托盘后 MainWindowHandle 为 0"）
if (-not ('DshRestartWin' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshRestartWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  public static IntPtr FindMainWindow(int pid) {
    IntPtr best = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == (uint)pid && GetWindowTextLength(h) > 0) {
        if (IsWindowVisible(h)) { best = h; return false; }
        if (best == IntPtr.Zero) best = h;
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
}

function Get-PortOwnerPid([int]$p) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch {}
  return 0
}

function Wait-Port([int]$p, [bool]$WantListening, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $owner = Get-PortOwnerPid $p
    if ($WantListening -and $owner -ne 0) { return $owner }
    if (-not $WantListening -and $owner -eq 0) { return 0 }
    Start-Sleep -Milliseconds 500
  }
  return (Get-PortOwnerPid $p)
}

Write-Log ('--- restart-desktop 开始（DryRun={0} Port={1}）---' -f $DryRun, $Port)
Write-Result -Outcome 'running' -Message '脚本已启动' -Code 0

# 1) 找出后端 host（监听 -Port 端口的那个）
$backendPid = Get-PortOwnerPid $Port
if ($backendPid -eq 0) {
  Write-Log ('端口 {0} 上没有监听进程：DSH 似乎没在运行。' -f $Port)
  if (-not $StartIfDown) {
    Write-Log '（加 -StartIfDown 可以在这种情况直接把它启动起来）'
    Exit-With 2 'failed' ('端口 {0} 上没有监听进程：DSH 似乎没在运行' -f $Port)
  }
  $exe = Join-Path $InstallRoot 'DeepSeek Harness.exe'
  if (-not (Test-Path -LiteralPath $exe)) { Exit-With 6 'failed' ('找不到可执行文件：{0}' -f $exe) }
  Write-Log ('按 -StartIfDown 直接启动：{0}' -f $exe)
  if ($DryRun) { Write-Log 'DryRun：不实际启动。'; Exit-With 0 'ok' 'DryRun：不实际启动' }
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $exe + '"') }
  Write-Log ('Win32_Process.Create 返回码 {0}，新 PID {1}' -f $created.ReturnValue, $created.ProcessId)
  $up = Wait-Port $Port $true $WaitReadySeconds
  if ($up -eq 0) { Exit-With 7 'failed' ('启动后 {0} 秒内端口 {1} 仍未监听，请手动打开' -f $WaitReadySeconds, $Port) }
  Write-Log ('已启动：端口 {0} 由 PID {1} 监听。' -f $Port, $up)
  Exit-With 0 'ok' ('已启动：PID ' + $up)
}
$backend = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $backendPid) -ErrorAction SilentlyContinue
if ($null -eq $backend) { Exit-With 3 'failed' ('找不到 PID {0} 的进程信息' -f $backendPid) }
$backendExe = [string]$backend.ExecutablePath
Write-Log ('后端 host：PID {0}，exe {1}' -f $backendPid, $backendExe)

# 2) 安全校验：必须是我们安装目录下的 DeepSeek Harness
if (-not (Test-UnderRoot $backendExe)) {
  Write-Log ('拒绝操作：PID {0} 的可执行文件不在安装目录 {1} 下。' -f $backendPid, $InstallRoot)
  Exit-With 4 'failed' ('拒绝操作：PID {0} 的 exe 不在安装目录 {1} 下' -f $backendPid, $InstallRoot)
}

# 3) 主进程 = 后端父进程，且必须有主窗口（避免认错）
$mainPid = [int]$backend.ParentProcessId
$mainProc = Get-Process -Id $mainPid -ErrorAction SilentlyContinue
if ($null -eq $mainProc -or $mainProc.MainWindowHandle -eq 0) {
  $cand = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($cand) { $mainPid = $cand.Id; $mainProc = $cand }
}
if ($null -eq $mainProc) { Exit-With 5 'failed' '找不到带主窗口的主进程，放弃' }
$mainPath = ''
try { $mainPath = [string](Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $mainPid)).ExecutablePath } catch {}
Write-Log ('主进程：PID {0}，窗口标题「{1}」，exe {2}' -f $mainPid, $mainProc.MainWindowTitle, $mainPath)
if ($mainPath -ne '' -and -not (Test-UnderRoot $mainPath)) {
  Write-Log ('拒绝操作：主进程 exe 不在安装目录下（{0}）。' -f $mainPath)
  Exit-With 4 'failed' ('拒绝操作：主进程 exe 不在安装目录下（{0}）' -f $mainPath)
}

if ($DryRun) {
  Write-Log 'DryRun：只报告计划，不做任何动作。'
  Write-Log ('  计划：优雅策略 {0} → 关闭主进程 {1}（超时 {2}s 后强制），等端口 {3} 释放，再用 WMI 重新拉起 {4}' -f $GracefulMode, $mainPid, $GracefulSeconds, $Port, $mainPath)
  Exit-With 0 'ok' 'DryRun：只报告计划，未做任何动作'
}

if ($DelaySeconds -gt 0) {
  Write-Log ('先等 {0} 秒（留给调用方把回执发出去）…' -f $DelaySeconds)
  Start-Sleep -Seconds $DelaySeconds
}

# 4) 优雅关闭（按 -GracefulMode 分派）
$exited = $false
if ($GracefulMode -eq 'none') {
  Write-Log '按 -GracefulMode none：跳过优雅阶段。'
} elseif ($GracefulMode -eq 'close') {
  Write-Log '按 -GracefulMode close：只请求主窗口关闭（实测会缩到托盘，多半不会退出）…'
  try { [void]$mainProc.CloseMainWindow() } catch { Write-Log ('CloseMainWindow 失败：' + $_.Exception.Message) }
  try { $exited = $mainProc.WaitForExit($GracefulSeconds * 1000) } catch { $exited = $false }
} else {
  # session：伪造系统会话结束 —— Electron 的 before-quit 在 sessionEnding 分支会跳过确认直接退出
  $hwnd = [IntPtr]::Zero
  try { $hwnd = [DshRestartWin]::FindMainWindow($mainPid) } catch { Write-Log ('FindMainWindow 失败：' + $_.Exception.Message) }
  if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [IntPtr]$mainProc.MainWindowHandle }
  if ($hwnd -eq [IntPtr]::Zero) {
    Write-Log '找不到主窗口句柄 ⇒ 无法伪造会话结束，直接进入强制结束。'
  } else {
    Write-Log ('按 -GracefulMode session：向主窗口 0x{0:X} 伪造 WM_QUERYENDSESSION + WM_ENDSESSION…' -f [int64]$hwnd)
    $WM_QUERYENDSESSION = 0x0011
    $WM_ENDSESSION = 0x0016
    $out = [IntPtr]::Zero
    try { [void][DshRestartWin]::SendMessageTimeout($hwnd, $WM_QUERYENDSESSION, [IntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$out) } catch { Write-Log ('WM_QUERYENDSESSION 发送失败：' + $_.Exception.Message) }
    Start-Sleep -Milliseconds 400
    try { [void][DshRestartWin]::PostMessage($hwnd, $WM_ENDSESSION, [IntPtr]1, [IntPtr]::Zero) } catch { Write-Log ('WM_ENDSESSION 发送失败：' + $_.Exception.Message) }
    try { $exited = $mainProc.WaitForExit($GracefulSeconds * 1000) } catch { $exited = $false }
  }
}
if ($exited) {
  Write-Log ('主进程已优雅退出（模式 {0}）✅' -f $GracefulMode)
} else {
  Write-Log ('{0} 秒内没退出 ⇒ 强制结束 PID {1}（常见原因：当时有任务在跑，Electron 弹了退出确认框而无人点击；这属预期退化路径，DSH 的会话是逐步落盘的，实测未丢状态）' -f $GracefulSeconds, $mainPid)
  try { Stop-Process -Id $mainPid -Force -ErrorAction Stop; Write-Log '已强制结束主进程。' }
  catch { Exit-With 8 'failed' ('强制结束主进程 PID {0} 失败：{1} —— 中止，不再拉起新实例（否则会双开）' -f $mainPid, $_.Exception.Message) }
}
# 后端 host 是子进程，父进程退出不会带走它
Start-Sleep -Milliseconds 800
if (Get-Process -Id $backendPid -ErrorAction SilentlyContinue) {
  try { Stop-Process -Id $backendPid -Force -ErrorAction Stop; Write-Log ('已结束后端 host PID {0}。' -f $backendPid) }
  catch { Exit-With 9 'failed' ('结束后端 host PID {0} 失败：{1} —— 中止，不再拉起新实例（否则会双开）' -f $backendPid, $_.Exception.Message) }
}

# 5) 等端口释放
$left = Wait-Port $Port $false 30
if ($left -ne 0) { Exit-With 10 'failed' ('端口 {0} 30 秒内仍被 PID {1} 占用 —— 中止，不再拉起新实例（否则会双开）' -f $Port, $left) }
Write-Log ('端口 {0} 已释放。' -f $Port)

# 6) 重新拉起（WMI ⇒ 脱离本进程树）
$launchExe = if ($mainPath -ne '') { $mainPath } else { $backendExe }
Write-Log ('重新启动：{0}' -f $launchExe)
try {
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $launchExe + '"') }
  Write-Log ('Win32_Process.Create 返回码 {0}，新 PID {1}' -f $created.ReturnValue, $created.ProcessId)
} catch {
  Write-Log ('WMI 启动失败：' + $_.Exception.Message + '，退回 Start-Process')
  try { Start-Process -FilePath $launchExe | Out-Null } catch { Write-Log ('Start-Process 也失败：' + $_.Exception.Message) }
}

# 7) 等它回来
$ready = Wait-Port $Port $true $WaitReadySeconds
if ($ready -eq 0) { Exit-With 11 'failed' ('重启后 {0} 秒内端口 {1} 仍未监听 —— 请手动打开 DSH 并查看日志' -f $WaitReadySeconds, $Port) }
if ($ready -eq $backendPid) {
  # 端口上还是原来那个进程 ⇒ 它根本没退，这不是「重启成功」。
  Exit-With 12 'failed' ('端口 {0} 仍由原进程 PID {1} 监听 ⇒ 重启未生效（旧进程没退）' -f $Port, $ready)
}
Write-Log ('重启成功：端口 {0} 已由新 PID {1} 监听（原 PID {2}）。' -f $Port, $ready, $backendPid)
Write-Result -Outcome 'ok' -Message ('重启成功：新 PID ' + $ready) -Code 0
Write-Log '--- restart-desktop 结束 ---'
