<#
  restart-desktop.ps1 —— 安全重启 DSH 桌面端（Windows / Electron）

  设计要点（2026-10-02；2026-10-17 改按宿主 PID 定位）：
    1. 只用「宿主 PID（-HostPid，插件传 process.pid）」+「谁有主窗口」精确定位目标，
       **绝不按进程名批量杀**。宿主从 DSH 0.2.1 起以随机端口启动（--port 0），
       **端口不能再用来认进程**；兼容旧调用：没传 -HostPid 时先按 -Port，再回落到
       按命令行自动找 dsh-desktop-host 子进程；
    2. 先请求主窗口优雅关闭（等价于点 UI 的退出按钮，走同一套 before-quit）；
    3. 超过 -GracefulSeconds 还没退，才强制结束（只针对已确认的那两个 PID）；
    4. 关掉主进程后**先等后端 host 自己退出**（最多 30 秒，留给它落盘会话日志）；
       自己退了只记日志；超时才强杀，并显式警告「会话日志可能不完整」
       （2026-10-22 改：以前固定等 800ms 就硬杀，可能丢掉尚未落盘的会话日志）；
    5. 等后端 host 真正退出，再用 WMI Win32_Process.Create 重新拉起
       （父进程是 WmiPrvSE ⇒ 脱离调用方进程树，DSH 自己被杀也不影响重启）；
    6. 新实例就绪的判据＝出现**新的 host 子进程**（不再看端口）；
    7. 全过程写日志，事后可核对。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File restart-desktop.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File restart-desktop.ps1 -HostPid <宿主 PID>
    powershell -NoProfile -ExecutionPolicy Bypass -File restart-desktop.ps1 -DelaySeconds 3 -GracefulSeconds 8
    powershell -NoProfile -ExecutionPolicy Bypass -File restart-desktop.ps1 -StartIfDown   # 没在跑就直接启动
    ... -HostPid <PID>                # 插件传 process.pid；不传则自动认（见设计要点 1）
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
  [int]$HostPid = 0,
  [int]$Port = 0,
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
  [string]$ResultFile = '',
  [int]$GracefulSeconds = 8,
  [int]$DelaySeconds = 0,
  [int]$WaitReadySeconds = 90,
  [string]$LogFile = (Join-Path $env:TEMP 'dsh-restart-desktop.log')
)

$ErrorActionPreference = 'Continue'

# 关闭主进程后先等后端 host **自己退出**的上限（秒）：留给它把会话日志落盘，超时才强杀。
$HostWaitSeconds = 30

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

# 认宿主的命令行特征：必须命中宿主入口 dsh-desktop-hostlibindex.js，
# 且带 --expose-internals。本机实测 tool runner 的命令行里也会出现该串
# （powershell -Command "... dsh-desktop-host ..."），只 match 子串会认错。
function Test-IsHostCommandLine([string]$cmd) {
  if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }
  return ($cmd -match 'dsh-desktop-host[\\/]lib[\\/]index\.js') -and ($cmd -match '--expose-internals')
}

# 找「当前宿主」：优先 -HostPid（插件自己就是宿主），其次 -Port（旧调用），
# 最后按命令行自动认。
function Find-HostProcess {
  if ($HostPid -gt 0) {
    return Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $HostPid) -ErrorAction SilentlyContinue
  }
  if ($Port -gt 0) {
    $owner = Get-PortOwnerPid $Port
    if ($owner -gt 0) {
      return Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $owner) -ErrorAction SilentlyContinue
    }
    # 旧调用仍传 -Port（宿主 0.2.1 起端口随机）⇒ 端口上没人就回落到按命令行认。
    Write-Log ('端口 {0} 上没有监听进程，改为按命令行自动认宿主。' -f $Port)
  }
  return Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { Test-IsHostCommandLine ([string]$_.CommandLine) } | Select-Object -First 1
}

function Test-ProcessAlive([int]$p) {
  return $null -ne (Get-Process -Id $p -ErrorAction SilentlyContinue)
}

function Wait-ProcessGone([int]$p, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-ProcessAlive $p)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return (-not (Test-ProcessAlive $p))
}

# 拉起前快照：机器上已有的 host 进程一律不算「新实例」（防多实例/残留造成假成功）。
function Get-HostPidSnapshot {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
      Where-Object { Test-IsHostCommandLine ([string]$_.CommandLine) } |
      ForEach-Object { [int]$_.ProcessId })
  } catch { return @() }
}

# 新实例的宿主子进程：PID 不在快照、创建时间不早于本次拉起。
# 首选「LaunchedMainPid 的子进程」；LaunchedMainPid 未知时也只认新创建 + 安装目录内的 host，
# **不再无条件吃「任意 host」**（否则多实例/残留 host 会假成功）。
function Find-NewHostPid([int]$OldPid, [int]$LaunchedMainPid, [int[]]$ExcludePids, [datetime]$Since) {
  try {
    $all = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessId -ne $OldPid -and
        ($ExcludePids -notcontains [int]$_.ProcessId) -and
        (Test-IsHostCommandLine ([string]$_.CommandLine))
      }
    if ($LaunchedMainPid -gt 0) {
      $child = $all | Where-Object { $_.ParentProcessId -eq $LaunchedMainPid } | Select-Object -First 1
      if ($child -and ([datetime]$child.CreationDate) -ge $Since.AddSeconds(-2)) { return [int]$child.ProcessId }
    }
    $any = $all |
      Where-Object { (Test-UnderRoot ([string]$_.ExecutablePath)) -and ([datetime]$_.CreationDate) -ge $Since.AddSeconds(-2) } |
      Select-Object -First 1
    if ($any) { return [int]$any.ProcessId }
  } catch {}
  return 0
}

function Wait-NewHost([int]$OldPid, [int]$LaunchedMainPid, [int[]]$ExcludePids, [datetime]$Since, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $found = Find-NewHostPid $OldPid $LaunchedMainPid $ExcludePids $Since
    if ($found -ne 0) { return $found }
    Start-Sleep -Milliseconds 500
  }
  return 0
}

Write-Log ('--- restart-desktop 开始（DryRun={0} HostPid={1} Port={2}）---' -f $DryRun, $HostPid, $Port)
Write-Result -Outcome 'running' -Message '脚本已启动' -Code 0
# 拉起前的 host 快照：后面判「新实例」时排除它们（防多实例/残留造成假成功）。
$hostSnapshot = Get-HostPidSnapshot
if ($hostSnapshot.Count -gt 0) { Write-Log ('拉起前已有 host 进程：{0}（判新实例时排除）' -f ($hostSnapshot -join ',')) }

# 1) 找出后端 host（优先 -HostPid；兼容 -Port；都没有就按命令行认）
$backend = Find-HostProcess
$backendPid = if ($null -ne $backend) { [int]$backend.ProcessId } else { 0 }
if ($backendPid -eq 0) {
  Write-Log '找不到宿主进程：DSH 似乎没在运行。'
  if (-not $StartIfDown) {
    Write-Log '（加 -StartIfDown 可以在这种情况直接把它启动起来）'
    Exit-With 2 'failed' '找不到宿主进程：DSH 似乎没在运行'
  }
  $exe = Join-Path $InstallRoot 'DeepSeek Harness.exe'
  if (-not (Test-Path -LiteralPath $exe)) { Exit-With 6 'failed' ('找不到可执行文件：{0}' -f $exe) }
  Write-Log ('按 -StartIfDown 直接启动：{0}' -f $exe)
  if ($DryRun) { Write-Log 'DryRun：不实际启动。'; Exit-With 0 'ok' 'DryRun：不实际启动' }
  $launchStartedAt = Get-Date
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $exe + '"') }
  Write-Log ('Win32_Process.Create 返回码 {0}，新 PID {1}' -f $created.ReturnValue, $created.ProcessId)
  if ($created.ReturnValue -ne 0) { Exit-With 13 'failed' ('启动失败：Win32_Process.Create 返回码 {0}' -f $created.ReturnValue) }
  $startedMainPid = [int]$created.ProcessId
  $up = Wait-NewHost 0 $startedMainPid $hostSnapshot $launchStartedAt $WaitReadySeconds
  if ($up -eq 0) { Exit-With 7 'failed' ('启动后 {0} 秒内没看到新的宿主进程，请手动打开' -f $WaitReadySeconds) }
  Start-Sleep -Milliseconds 1200
  if (-not (Test-ProcessAlive $up)) { Exit-With 7 'failed' ('启动后新的宿主 PID {0} 立刻退出了，请手动打开并查看日志' -f $up) }
  Write-Log ('已启动：新宿主 PID {0}。' -f $up)
  Exit-With 0 'ok' ('已启动：新宿主 PID ' + $up)
}
$backendExe = [string]$backend.ExecutablePath
Write-Log ('后端 host：PID {0}，exe {1}' -f $backendPid, $backendExe)

# 2) 安全校验：必须是我们安装目录下的 DeepSeek Harness
if (-not (Test-UnderRoot $backendExe)) {
  Write-Log ('拒绝操作：PID {0} 的可执行文件不在安装目录 {1} 下。' -f $backendPid, $InstallRoot)
  Exit-With 4 'failed' ('拒绝操作：PID {0} 的 exe 不在安装目录 {1} 下' -f $backendPid, $InstallRoot)
}

# 3) 主进程 = 后端 host 的**祖先**里第一个带主窗口的进程（绝不按名字挑别的窗口，防多实例误杀）
$mainPid = 0
$mainProc = $null
$walkPid = [int]$backend.ParentProcessId
$walkGuard = 0
while ($walkPid -gt 0 -and $walkGuard -lt 6) {
  $cand = Get-Process -Id $walkPid -ErrorAction SilentlyContinue
  if ($null -ne $cand -and $cand.MainWindowHandle -ne 0) { $mainPid = $walkPid; $mainProc = $cand; break }
  $walkProc = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $walkPid) -ErrorAction SilentlyContinue
  if ($null -eq $walkProc) { break }
  $walkPid = [int]$walkProc.ParentProcessId
  $walkGuard++
}
if ($null -eq $mainProc) { Exit-With 5 'failed' '找不到 backend 的带主窗口祖先进程，放弃（不按进程名挑窗口）' }
$mainPath = ''
try { $mainPath = [string](Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $mainPid)).ExecutablePath } catch {}
Write-Log ('主进程：PID {0}，窗口标题「{1}」，exe {2}' -f $mainPid, $mainProc.MainWindowTitle, $mainPath)
if ($mainPath -ne '' -and -not (Test-UnderRoot $mainPath)) {
  Write-Log ('拒绝操作：主进程 exe 不在安装目录下（{0}）。' -f $mainPath)
  Exit-With 4 'failed' ('拒绝操作：主进程 exe 不在安装目录下（{0}）' -f $mainPath)
}

if ($DryRun) {
  Write-Log 'DryRun：只报告计划，不做任何动作。'
  Write-Log ('  计划：优雅策略 {0} → 关闭主进程 {1}（超时 {2}s 后强制）→ 先等后端 host PID {3} 自行退出（最多 {5}s，超时才强杀并警告日志可能不完整）→ 再用 WMI 重新拉起 {4}' -f $GracefulMode, $mainPid, $GracefulSeconds, $backendPid, $mainPath, $HostWaitSeconds)
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
# 后端 host 是子进程，父进程退出不会带走它。
# 先给它时间**自己退出**（会话日志靠退出路径落盘）；等满上限还没退才强杀，并显式警告日志可能不完整。
if (-not (Test-ProcessAlive $backendPid)) {
  Write-Log ('后端 host PID {0} 已随主进程自行退出（落盘完成）。' -f $backendPid)
} else {
  Write-Log ('先等后端 host PID {0} 自行退出（最多 {1} 秒，留给它落盘会话日志）…' -f $backendPid, $HostWaitSeconds)
  if (Wait-ProcessGone $backendPid $hostWaitSeconds) {
    Write-Log ('后端 host PID {0} 已自行退出（落盘完成）。' -f $backendPid)
  } else {
    Write-Log ('⚠️ 警告：后端 host PID {0} 等满 {1} 秒仍未自行退出 ⇒ 强制结束；**会话日志可能不完整**，请以磁盘上已落盘的部分为准。' -f $backendPid, $HostWaitSeconds)
    try { Stop-Process -Id $backendPid -Force -ErrorAction Stop; Write-Log ('已强制结束后端 host PID {0}。' -f $backendPid) }
    catch { Exit-With 9 'failed' ('结束后端 host PID {0} 失败：{1} —— 中止，不再拉起新实例（否则会双开）' -f $backendPid, $_.Exception.Message) }
  }
}

# 5) 等后端 host 真正退出（不看端口：宿主端口是随机分配的）
if (-not (Wait-ProcessGone $backendPid 30)) {
  Exit-With 10 'failed' ('后端 host PID {0} 30 秒内仍没退出 —— 中止，不再拉起新实例（否则会双开）' -f $backendPid)
}
Write-Log ('后端 host PID {0} 已退出。' -f $backendPid)

# 6) 重新拉起（WMI ⇒ 脱离本进程树）
$launchExe = if ($mainPath -ne '') { $mainPath } else { $backendExe }
Write-Log ('重新启动：{0}' -f $launchExe)
$launchedMainPid = 0
$launchStartedAt = Get-Date
try {
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $launchExe + '"') }
  Write-Log ('Win32_Process.Create 返回码 {0}，新 PID {1}' -f $created.ReturnValue, $created.ProcessId)
  if ($created.ReturnValue -ne 0) { Exit-With 13 'failed' ('拉起失败：Win32_Process.Create 返回码 {0} —— 不再拉起新实例' -f $created.ReturnValue) }
  $launchedMainPid = [int]$created.ProcessId
} catch {
  Write-Log ('WMI 启动失败：' + $_.Exception.Message + '，退回 Start-Process')
  try {
    $started = Start-Process -FilePath $launchExe -PassThru
    if ($null -ne $started) { $launchedMainPid = [int]$started.Id }
  } catch { Write-Log ('Start-Process 也失败：' + $_.Exception.Message) }
  if ($launchedMainPid -eq 0) { Exit-With 13 'failed' '拉起失败：WMI 与 Start-Process 都没拿到新进程' }
}

# 7) 等它回来：判据＝出现新的宿主子进程（排除快照 + 校验创建时间，不看端口）
$ready = Wait-NewHost $backendPid $launchedMainPid $hostSnapshot $launchStartedAt $WaitReadySeconds
if ($ready -eq 0) { Exit-With 11 'failed' ('重启后 {0} 秒内没看到新的宿主进程 —— 请手动打开 DSH 并查看日志' -f $WaitReadySeconds) }
# 只看到进程出现还不够：启动即崩的实例会误导结果，等 1.2 秒复检存活。
Start-Sleep -Milliseconds 1200
if (-not (Test-ProcessAlive $launchedMainPid)) { Exit-With 11 'failed' ('新主进程 PID {0} 启动后已退出 —— 请手动打开 DSH 并查看日志' -f $launchedMainPid) }
if (-not (Test-ProcessAlive $ready)) { Exit-With 11 'failed' ('新宿主 PID {0} 启动后已退出 —— 请手动打开 DSH 并查看日志' -f $ready) }
Write-Log ('重启成功：新宿主 PID {0}（原 PID {1}）。' -f $ready, $backendPid)
Write-Result -Outcome 'ok' -Message ('重启成功：新宿主 PID ' + $ready) -Code 0
Write-Log '--- restart-desktop 结束 ---'
