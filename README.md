# dsh-desktop-auto-restart（重启插件）

给 DSH 加一个「重启宿主」的工具和一个侧边栏按钮；**重启后自动把指定会话唤醒**，让它接着干。

它解决的是一个具体麻烦：改了 DSH 宿主侧插件（host 半边）必须重启 DSH 才生效，可重启又会把正在跑的回合、连同发起这次改动的 agent 自己一起杀掉。本插件把「重启」做成一次工具调用，并在新进程起来后把 agent 唤醒回来。

## 兼容性

**只支持 Windows 上的 DSH 桌面端**（那个 Electron App），宿主版本 ≥ 0.2.0-rc.1（peerDependencies 声明；0.2.1-rc.1 实测）。

- 重启脚本靠 PowerShell + WMI 分离进程、靠 user32 伪造系统会话结束 —— 非 Windows 平台没有这套东西。
- 非桌面形态（例如浏览器版）没有可重启的 App：脚本要么报「找不到宿主进程」，要么因 exe 不在安装目录而**拒绝操作**（退出码 4），不会误杀。
- 插件自己在非 Windows 平台会直接拒绝重启，不会半途而废、也不会静默失败。
- **脚本能不能跑，取决于本机 PowerShell 执行策略**：需要允许本地脚本（`RemoteSigned` 即可）。Windows 客户端的默认策略可能是 `Restricted`，那种机器上脚本**根本不会被执行**，而 WMI 照样返回 rc=0 ⇒ 工具会报「脚本已拉起」却什么都没发生。修法：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`（不需要管理员）。
- **装了火绒等安全软件**时，重启会在它的「系统加固」里记一条 `WmiPrvSE.exe 触犯敏感动作防护规则`：用 WMI 建进程正是为了让重启器脱离 DSH 进程树，属于预期行为；对方的软件若设成询问模式会弹窗，放行即可。

## 功能

- **工具 `dsh_restart`**（⚠️ **测试性质，谨慎使用**）：`{ reason, sessionIds, delaySeconds? }` —— 先写「待唤醒清单」，再调重启脚本（`delaySeconds` 不传＝10 秒，留给回执落盘；`0`＝立刻重启）。
  该工具**默认不注册**（「设置 → 重启」里的开关默认关）；打开后模型能自己重启宿主，这会**中断正在跑的回合**，请确认清楚再让它用。宿主繁忙时**直接拒绝**，且没有 `force` 之类的绕过参数（繁忙判定见下；**调用方自己那个会话不算繁忙**）。
- **侧边栏按钮**（`sidebar.footer.action`）：空闲时点一下直接重启、不弹框；繁忙时先弹一个确认层（确认键红底），确认后带 `force` 放行。端点只认**本机回环地址 + 带自定义请求头的同源请求**，别的网页调不动它。
- **重启后自动唤醒（跨重启可续）**：新进程启动时读清单，对每个会话走**官方通道**、按它**原有的预设**唤醒，并注入一条「已重启完成，请继续」的 notice。唤醒进度（谁试过几次、下次什么时候再试、谁已完成）**写在清单里**，每变一次就原子落盘 ⇒ 唤醒到一半宿主又被重启，下次启动接着等退避，不重复喊；失败按 5s→10s→20s→40s→80s→160s→300s（封顶，±20% 抖动）退避；**TTL 到点或连续失败 10 次先到先停**（放弃该会话），没人成功就**保留清单**给下次启动。
- **防自杀**：脚本优先用「宿主 PID（插件自己的 process.pid）+ 进程树」定位进程，绝不按进程名批量杀；只有旧调用（没传 -HostPid/-Port）才按命令行自动认宿主。不改任何配置与工具面。

## 安装

包在 npm 上，名字就是 `dsh-desktop-auto-restart`。

> **桌面端用户请在应用内「设置 → 插件」里安装。** 插件市场卡片上那条 `dsh plugin --profile web add …` 会装到一个独立的 web profile，桌面端启动的是 `desktop` profile，装了也不会加载。手动安装时把下面的 `<profile 名>` 换成 `desktop`，并且需要先完全退出桌面端再执行（普通 CLI 直接操作 desktop profile 会被拒）。

用 DSH 自带的 CLI（装完重启 DSH 生效）：

```sh
dsh plugin --profile <profile 名> add dsh-desktop-auto-restart
```

（`npm i dsh-desktop-auto-restart` 只是把包装进当前目录，**DSH 插件要按上面那条 CLI 装**才生效。）

手动装（等同上面这条做的事）：

1. 让 profile 能找到这个包：把本目录放进 `<profile>/node_modules/`，或在 `<profile>/package.json` 的 `dependencies` 里用 `file:` 路径／包名指向它。
2. 在 `<profile>/package.json` 的 `dsh.profile.bundles` 数组里加上 `dsh-desktop-auto-restart`。
3. 重启 DSH。

（`<profile>` 默认在 `~/.dsh/profiles/<profile 名>`。）

## 配置

字段定义在 `lib/index.js` 的 `Config`，默认值如下；要改就在 profile 的 `cordis.patch.yml` 里写一条 id 定向 patch。

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `agentToolEnabled` | `false` | **默认关**：关着时**不注册** `dsh_restart`（模型看不到这个工具）；打开后需重启 DSH 才生效 |
| `wakeOnStart` | `true` | 启动时是否读清单执行唤醒 |
| `wakeDelayMs` | `3000` | 启动后等多久再开始唤醒（太早还拿不到会话） |
| `pendingTtlMs` | `1800000` | 清单过期时间（默认 30 分钟） |
| `scriptPath` | `''` | 覆盖重启脚本路径；留空＝用插件自带脚本（自定义脚本要认 `-HostPid`/`-DelaySeconds`/`-InstallRoot`/`-ResultFile`；旧脚本只认 `-Port` 的需迁移到 `-HostPid`） |
| `dryRun` | `false` | 只落清单、不真重启（演练用） |
| `showScriptWindow` | `true` | 重启时**默认弹出** PowerShell 脚本窗口：能看到脚本每一步（定位 PID/优雅关闭/等待 host 自行退出/重启），结束自动关闭；关掉则加 `-WindowStyle Hidden` 隐藏运行 |
| （无） | — | UI 端点门禁与 60 秒并发冷却**没有开关**：为安全起见不可配置 |
| `installRoot` | `''` | 宿主安装目录；留空＝**自动探测**（插件自己就跑在这个 App 里，直接取当前进程 exe 所在目录，实测准确）；探测不到才回落到脚本内置默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness` |

⚠️ `cordis.patch.yml` 里 **id 定向的 patch 会整段替换该插件的 config**，所以要改的字段和想保留的字段都得一并写全。

> 0.1.1 起**移除** `desktopPort`（宿主 0.2.1 起端口每次随机，定位改用宿主 PID）。旧 patch 里残留的 `desktopPort` 仍会被接受但**被忽略**，不必手工清理。

## 设置页

DSH 的「设置」里会多一个**「重启」**分节（DSH 0.2 的标准做法：浏览器半边注册 `settings.section` 槽位，读写走宿主在同一前缀下开的同源 API，写回用官方 `configEditor` ⇒ 除了下面第一条工具开关，其余改完热生效、不用重启）。

- **允许 agent 调用重启工具**（默认**关**）：关着时插件**不注册**这个工具，模型压根看不到它 —— 想让它能自主重启再打开，然后重启一次 DSH 才生效；运行时把它关掉，已注册的工具会**立刻**改为一律拒绝。
- **宿主安装目录**：留空＝自动探测，探测结果直接显示在面板的状态行里（也会显示当前是「手动配置」还是「自动探测」）。
- **唤醒**：是否在重启后自动唤醒会话、唤醒前等多久。
- 面板顶部的只读状态：宿主 PID、平台、当前是否繁忙、待唤醒清单条数、**上一次脚本结果**（`ok`/`failed` + 原因）。

## 工作机制

1. **工具调用**：校验重启脚本存在（不存在直接拒绝）→ 校验安装目录下有 `DeepSeek Harness.exe`（没有直接报错，**不拉起脚本**）→ 把「要唤醒谁 + 原因 + 时间」写进 DSH 数据目录（环境变量 `DSH_HOME`，默认 `~/.dsh`）下的 `restart-pending.json` → 用 WMI `Win32_Process.Create` 拉起重启脚本（父进程是 WmiPrvSE，脱离 DSH 进程树，DSH 自己被杀也不影响它），并读回 `rc`/`pid`。
2. **重启脚本**：按宿主 PID 找到后端 host（插件把自己的 `process.pid` 传给脚本；没传时按命令行自动认）→ 校验它的 exe 在安装目录下（不在就放弃）→ 先伪造系统会话结束、请它优雅退出，超时（默认 8 秒）才强杀主进程 → **先等后端 host 自己退出**（最多 30 秒，留给它把会话日志落盘）：自己退了只记日志，等满才强杀并显式警告「会话日志可能不完整」→ 等后端 host 退出 → 再用原 exe 经 WMI 拉起来 → 等**新的 host 子进程**出现（不再看端口：DSH 0.2.1 起宿主端口是随机分配的）。
3. **重启后**：插件启动时若清单未过期，先等 `wakeDelayMs`，再按清单里的状态唤醒：只有 `now >= nextAttemptAt` 的会话才尝试（并发 ≤3，同一会话在途不重复喊）；成功立刻记 `done` 并落盘，失败 `attempts+1` 并写入退避后的 `nextAttemptAt`（5s→…→300s 封顶、±20% 抖动）；连续失败 10 次放弃该会话并记诊断。只有所有会话都有结论（成功或放弃）才清清单；`pendingTtlMs` 与「10 次」**先到先停** —— TTL 到点就停、保留清单给下次启动。清单格式 `schemaVersion: 2`，旧格式（只有 `sessions` 字符串数组）启动时自动迁移。
4. **繁忙判定**：有正在跑的会话／有排队消息／有 running 或 stopping 的后台任务／有已武装的定时提醒 ⇒ 算繁忙；**唯独"调用方自己那个会话"不算**——agent 调工具时它自己那一轮必然是 running，算进去这个工具就永远调不动。取不到 `agents`、`jobs` 服务，或判定过程抛错 ⇒ 一律当繁忙（宁可不重启）。
5. **UI 端点门禁**：**非 Windows 一律 403**（所有 `/dsh-restart/api/*`，含改配置）；带 `x-forwarded-for`／`x-real-ip`／`forwarded` 代理头的请求一律 403（来源已不可信）；其余只接受「来自回环地址 + 带自定义请求头 `x-dsh-restart` + `Origin` 与 `Host` 同源」的 POST —— 自定义头让跨源请求先触发浏览器预检，而宿主不给 CORS 放行 ⇒ 外部网页没法偷偷触发重启。（自定义头不是密码，挡的是浏览器，不是本机上的其它程序。）
6. **结果回读与并发闸门**：脚本每次运行都把结果写进数据目录下的 `restart-last-result.json`（先 `running`，再 `ok`/`failed`）；工具拉起脚本后最多等 6 秒 —— 脚本若当场拒绝（宿主进程已不在、exe 不在安装目录……），工具**如实报失败并撤掉待唤醒清单**；等不到结果说明它在正常干活（成功路径要几十秒）。另外，一次重启被拉起后的 60 秒内不接受第二次请求，避免连点造成双实例。

## 目录结构

```
lib/index.js                 host 半边：工具、UI 端点、清单读写、唤醒调度
lib/wake-state.js            唤醒状态与规则（纯函数）：格式迁移、退避、该不该唤醒、完成/放弃
lib/client.js                浏览器半边：侧边栏按钮 + 繁忙确认层
scripts/restart-desktop.ps1  重启脚本（-DryRun 可空跑，不动机器）
scripts/restart-desktop.bat  转发入口（把参数传给 ps1）
.opencodereview/rule.json    本仓库的代码审查清单（错题本）
```

## 开发

```sh
npm test        # （仓库内开发用）host 半边的测试：自己造宿主桩，不需要装 DSH
```

测试把 `lib/` 整个复制到临时目录、在它旁边放三个 `@deepseek-ai/*` 最小桩模块再动态 import，
用假的 ctx 与服务覆盖：工具开关与注册、繁忙拒绝、UI 端点门禁（缺头／非回环／跨源／代理头／非 Windows）、
拉起前 exe 缺失的 fail-fast、设置面板读写（含 `showScriptWindow` 默认值）与类型收敛、演练模式、并发冷却、
待唤醒清单的认领与清除、重启后走官方通道唤醒、退避未到不唤醒、失败后 `attempts/nextAttemptAt` 落盘。
`test/wake-state.test.mjs` 单独覆盖纯函数：退避曲线与抖动、旧格式迁移、该不该唤醒、完成/放弃与清单清理。
全程用临时 `DSH_HOME`，不碰真实 `~/.dsh`，跑完自清。

## 限制

- 重启**必然**中断本进程与正在跑的回合；「继续」由重启后的唤醒负责。
- 安装目录通常**自动探测**（插件取自己进程 exe 所在目录，装在非默认位置也对）；探测不到才回落到脚本内置默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness` —— 那种情况下装在别处会被脚本的安全校验拒绝，把配置项 `installRoot` 指到实际目录即可。
- 重启始终失败时（脚本缺失、权限不足、找不到宿主进程），只能人工启动一次。
- 唤醒依赖宿主既有的会话恢复能力；宿主起不来就谈不上唤醒。
- 工具回执只能覆盖「脚本有没有被拉起」和「脚本头几秒有没有拒绝」；脚本中途失败（例如强杀失败、旧 host 没退出）只会体现在 `restart-last-result.json` 与 `%TEMP%\dsh-restart-desktop.log` 里 —— 那时工具早已返回。

## 许可证

MIT
