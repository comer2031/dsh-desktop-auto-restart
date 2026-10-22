/**
 * dsh-desktop-auto-restart（重启插件）—— DSH host 插件
 *
 * ① agent 可调工具：重启宿主，重启后**自动唤醒**指定会话；
 * ② 侧边栏「重启」按钮（浏览器半边见 lib/client.js）；
 * ③ 防自杀：脚本按「宿主自身 PID（插件内 process.pid）+ 进程树」定位进程，
 *    不按进程名批量杀；不改任何配置与工具面。
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  allSettled,
  attemptOf,
  canonicalSessionId,
  dueWakes,
  isSettled,
  markDone,
  markFailed,
  migratePending,
  newPendingState,
  nextWakeAt,
  WAKE_MAX_ATTEMPTS,
  WAKE_MAX_CONCURRENT,
  WAKE_SCHEMA_VERSION,
} from './wake-state.js'

export const name = 'dsh-desktop-auto-restart'
export const inject = []

const vol = (schema) => (typeof schema?.volatile === 'function' ? schema.volatile() : schema)
const unvolatile = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)

export const Config = Schema.object({
  /**
   * agent 能不能调用 dsh_restart：**默认关**（安全默认），在设置页「重启」里打开。
   * 关着时**根本不注册**这个工具（模型看不到它）⇒ 打开后要重启 DSH 才生效；
   * 运行时把它关掉，已注册的工具会立刻改为一律拒绝（下次启动起就不再注册）。
   */
  agentToolEnabled: vol(Schema.boolean().default(false)),
  wakeOnStart: vol(Schema.boolean().default(true)),
  wakeDelayMs: vol(Schema.number().default(3000)),
  pendingTtlMs: vol(Schema.number().default(1800000)),
  scriptPath: vol(Schema.string().default('')),
  dryRun: vol(Schema.boolean().default(false)),
  /**
   * @deprecated 0.1.1 起不再使用：宿主 0.2.1 起端口随机，定位改用 process.pid。
   * 仍保留声明（**非 volatile** ⇒ 不进设置表单）只为兼容旧 profile patch 里已有的
   * desktopPort 键：未知键在部分配置路径上会被当成错误，留着比删掉安全。
   */
  desktopPort: Schema.number().default(19387),
  /** 重启时是否显式弹出 PowerShell 脚本窗口（**默认弹**：能看见脚本每一步日志，重启结束自动关闭；关掉则加 -WindowStyle Hidden）。 */
  showScriptWindow: vol(Schema.boolean().default(true)),
  /** 宿主安装目录；留空 = 用脚本内置默认（%LOCALAPPDATA%\Programs\DeepSeek Harness）。 */
  installRoot: vol(Schema.string().default('')),
})

const DEFAULTS = { agentToolEnabled: false, wakeOnStart: true, wakeDelayMs: 3000, pendingTtlMs: 1800000, scriptPath: '', dryRun: false, showScriptWindow: true, installRoot: '' }

/**
 * 唤醒循环的 single-flight 令牌：**每次 apply 都 ++** ⇒ 上一次 apply 起的循环
 * 在下一拍看到令牌不一致就退出。插件 reload / 设置保存会再跑一次 apply，
 * 没有这道闸门时两份循环会并排跑同一份清单 ⇒ 同一会话被 followup 两次。
 */
let wakeEpoch = 0

/**
 * 组装重启脚本的参数（抽成纯函数便于测试）。
 * 只传宿主自身 PID 与安装目录；**不再传 -Port**（宿主 0.2.1 起端口每次随机）。
 */
export function restartShellCommand({ script, args, showWindow }) {
  const list = Array.isArray(args) ? args : []
  return 'powershell -NoProfile' + (showWindow === true ? '' : ' -WindowStyle Hidden')
    + ' -File "' + String(script ?? '') + '"'
    + (list.length > 0 ? ' ' + list.join(' ') : '')
}

export function restartScriptArgs({ pid, delaySeconds, installRoot, resultFile }) {
  const args = []
  if (Number.isFinite(delaySeconds) && delaySeconds > 0) args.push('-DelaySeconds ' + Math.floor(delaySeconds))
  args.push('-HostPid ' + Math.floor(Number(pid)))
  const root = String(installRoot ?? '')
  if (root !== '') args.push('-InstallRoot "' + root.replace(/"/g, '') + '"')
  args.push('-ResultFile "' + String(resultFile ?? '').replace(/"/g, '') + '"')
  return args
}

export function apply(ctx, config) {
  const here = dirname(fileURLToPath(import.meta.url))
  const startedAt = Date.now()
  /** 本次 apply 领的唤醒令牌（见文件顶部 wakeEpoch 的说明）。 */
  const wakeToken = ++wakeEpoch
  /** DSH 数据目录：优先用宿主给的环境变量（DSH_HOME），没有才退回 ~/.dsh。 */
  const home = () => {
    const fromEnv = String(process.env.DSH_HOME ?? '').trim()
    return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
  }
  const pendingFile = () => join(home(), 'restart-pending.json')
  const resultFile = () => join(home(), 'restart-last-result.json')
  /**
   * 读配置：**逐字段解包**。
   * 2026-10-06 实测：整包 unvolatile 后字段仍是对象 ✗ ⇒ `wakeOnStart === true` 永不成立
   * ⇒ 唤醒根本不会触发（诊断里表现为 apply done wakeOnStart=[object Object]）。
   */
  const current = () => {
    const raw = unvolatile(config)
    const value = raw !== null && typeof raw === 'object' ? raw : {}
    const pick = (key) => {
      const got = unvolatile(value[key])
      return got === undefined || got === null ? DEFAULTS[key] : got
    }
    return {
      agentToolEnabled: pick('agentToolEnabled') === true,
      wakeOnStart: pick('wakeOnStart') === true,
      wakeDelayMs: msOr(pick('wakeDelayMs'), DEFAULTS.wakeDelayMs),
      pendingTtlMs: Number(pick('pendingTtlMs')) || DEFAULTS.pendingTtlMs,
      scriptPath: String(pick('scriptPath') ?? ''),
      dryRun: pick('dryRun') === true,
      showScriptWindow: pick('showScriptWindow') === true,
      installRoot: String(pick('installRoot') ?? ''),
    }
  }
  /**
   * 自动探测宿主安装目录。
   * 插件就跑在这个 App 里 —— 实测本进程 process.execPath 就是
   * 「...\DeepSeek Harness\DeepSeek Harness.exe」，取所在目录即安装根，零配置且准确。
   * 只认这个 exe 名：若宿主跑在 node.exe 上（例如非桌面形态），就不猜、交回脚本内置默认。
   */
  function detectInstallRoot() {
    try {
      const exe = String(process.execPath ?? '')
      if (basename(exe).toLowerCase() !== 'deepseek harness.exe') return ''
      return dirname(exe)
    } catch { return '' }
  }
  /** 生效的安装目录：手动配置优先，留空用自动探测。 */
  function effectiveInstallRoot() {
    const configured = String(current().installRoot || '').trim()
    return configured !== '' ? configured : detectInstallRoot()
  }
  /** 脚本内置的默认安装目录（与 restart-desktop.ps1 的 -InstallRoot 默认值保持一致）。 */
  function scriptDefaultInstallRoot() {
    const localAppData = String(process.env.LOCALAPPDATA ?? '').trim()
    return localAppData === '' ? '' : join(localAppData, 'Programs', 'DeepSeek Harness')
  }
  /** 路径比较（仅用于文案）：忽略大小写与尾部分隔符。 */
  function samePath(a, b) {
    const norm = (value) => String(value ?? '').trim().replace(/[\\/]+$/, '').toLowerCase()
    const left = norm(a)
    return left !== '' && left === norm(b)
  }
  /** 实际交给脚本的安装目录：手动配置 > 自动探测 > 脚本内置默认（用于拉起前的 exe 存在性检查）。 */
  function launchInstallRoot() {
    const configured = String(current().installRoot || '').trim()
    if (configured !== '') return configured
    const detected = detectInstallRoot()
    return detected !== '' ? detected : scriptDefaultInstallRoot()
  }
  function diag(line) {
    try {
      mkdirSync(home(), { recursive: true })
      appendFileSync(join(home(), 'restart-debug.log'), new Date().toISOString() + ' pid=' + process.pid + ' ' + line + String.fromCharCode(10), 'utf8')
    } catch {}
  }
  /** 错误转文本。全文有 4 处 msg(...)，之前**没有定义** ⇒ 注册失败路径会抛 ReferenceError。 */
  const msg = (error) => String(error?.message ?? error)
  /** 毫秒字段：**0 是合法值**（立刻执行），所以不能用 || 兜底 —— 否则用户设 0 会被静默改成默认值。 */
  const msOr = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) === true && n >= 0 ? n : fallback
  }
  /**
   * 令牌的 disposer：插件 reload / 卸载时作废本次令牌，旧循环下一拍退出。
   * 若期间已经有新 apply 领了更新的令牌，就不动它（否则会顺手杀掉新循环）。
   */
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => () => { if (wakeEpoch === wakeToken) wakeEpoch++ })
  } catch (error) { diag('注册唤醒令牌 disposer 失败：' + msg(error)) }
  /**
   * 空闲判定：语义对齐 DSH 自己的退出检查（dsh-desktop-host 的 hasDesktopActiveTasks），
   * 不自己另立一套标准：
   *   ① 没有 status==='running' 的会话；
   *   ② 没有排队消息（agent.inbox.nextTurn / nextStep 为空）；
   *   ③ 没有 running / stopping 的 job（含无会话归属的那一档，用 jobs.list(undefined) 查）；
   *   ④ 没有已武装的定时提醒（workspace/session-activity 瀑布里 kind==='schedule'）。
   * 取不到 agents / jobs 服务、或判定过程抛错 ⇒ **返回 {known:false}**：
   * 调用方按「判定不出来 ＝ 不许重启」处理（宁可不重启）。
   *
   * ignoreSessionId：**调用方自己那个会话**。工具存在的意义就是让 agent 重启宿主
   * （连带打断它自己那一轮），所以它自己的 running / 排队不算「别人在干活」——
   * 否则这个工具永远调不动（2026-10-07 用户实测反馈）。排除只作用于「会话自身」这两项；
   * 后台任务与定时提醒照旧全算，含调用方自己的。
   */
  async function desktopIdleState(ignoreSessionId) {
    try {
      const agents = ctx.get('agents')
      const jobs = ctx.get('jobs')
      if (agents === undefined || agents === null || jobs === undefined || jobs === null) {
        return { known: false, idle: false, reason: 'agents/jobs 服务不可用' }
      }
      if (typeof agents.list !== 'function') return { known: false, idle: false, reason: 'agents.list 不可用' }
      const live = agents.list()
      const ignore = normalizeSessionId(ignoreSessionId)
      const others = ignore === '' ? live : live.filter((agent) => normalizeSessionId(agent?.id) !== ignore)
      const running = others.filter((agent) => agent?.status === 'running')
      if (running.length > 0) return { known: true, idle: false, reason: running.length + ' 个会话正在跑' }
      const queued = others.filter((agent) => {
        const inbox = agent?.inbox ?? {}
        return (inbox.nextTurn?.length ?? 0) > 0 || (inbox.nextStep?.length ?? 0) > 0
      })
      if (queued.length > 0) return { known: true, idle: false, reason: '有排队消息待处理' }
      let busyJob = false
      for (const agent of [undefined, ...live]) {
        try {
          if (jobs.list(agent?.id).some((job) => job?.status === 'running' || job?.status === 'stopping')) { busyJob = true; break }
        } catch {}
      }
      if (busyJob) return { known: true, idle: false, reason: '有后台任务在跑' }
      for (const agent of live) {
        try {
          const entries = await ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([]))
          if (Array.isArray(entries) && entries.some((entry) => entry?.kind === 'schedule')) {
            return { known: true, idle: false, reason: '有已武装的定时提醒' }
          }
        } catch {}
      }
      return { known: true, idle: true, reason: '' }
    } catch (error) {
      return { known: false, idle: false, reason: msg(error) }
    }
  }
  /**
   * 读 POST 请求体并当 JSON 解析（解析不了就当空对象）。
   * UI 用 {force:true} 表示「用户已在界面确认过，可以强行重启」。
   */
  function readJsonBody(req) {
    return new Promise((resolve) => {
      let text = ''
      try {
        req.on('data', (chunk) => { if (text.length < 65536) text += String(chunk) })
        req.on('end', () => { try { resolve(text.trim() === '' ? {} : JSON.parse(text)) } catch { resolve({}) } })
        req.on('error', () => resolve({}))
      } catch { resolve({}) }
    })
  }
  function scriptFor() {
    const override = String(current().scriptPath || '').trim()
    if (override !== '') return override
    return join(here, '..', 'scripts', 'restart-desktop.bat')
  }
  function stampOf(ms) {
    const d = new Date(Number(ms) || Date.now())
    const pad = (n) => String(n).padStart(2, '0')
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }
  function rid() { return 'restart-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) }
  function noticeMessage(text) {
    return {
      role: 'user',
      id: rid(),
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-restart', form: 'notice', summary: '[restart] ' + String(text).slice(0, 80) },
    }
  }
  function readPending() {
    try {
      if (existsSync(pendingFile()) === false) return null
      const parsed = JSON.parse(readFileSync(pendingFile(), 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch (error) { diag('读清单失败：' + String(error?.message ?? error)); return null }
  }
  /**
   * 原子写清单：先写同目录临时文件再 rename。
   * 唤醒状态是「跨重启续跑」的唯一凭据 —— 直接覆盖写时若在中间被杀，
   * 会留下半截 JSON，下次启动整份状态就丢了。
   */
  function writePending(value) {
    const file = pendingFile()
    const tmp = file + '.tmp-' + process.pid
    try {
      mkdirSync(home(), { recursive: true })
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, file)
      return true
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch {}
      diag('写清单失败：' + String(error?.message ?? error))
      return false
    }
  }
  function clearPending() {
    writePending({ schemaVersion: WAKE_SCHEMA_VERSION, sessions: [], done: true, doneAt: Date.now() })
  }
  /**
   * 清理原子写留下的陈旧临时文件（writePending 在 rename 前被杀 ⇒ *.tmp-<pid>）。
   * 只认 restart-pending.json.tmp- 前缀，别的文件一律不碰；失败只记诊断。
   */
  function cleanupStalePendingTmp() {
    try {
      const dir = home()
      if (existsSync(dir) !== true) return
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('restart-pending.json.tmp-') !== true) continue
        try { rmSync(join(dir, entry), { force: true }) }
        catch (error) { diag('清理陈旧临时清单失败：' + entry + '：' + msg(error)) }
      }
    } catch (error) { diag('扫描陈旧临时清单失败：' + msg(error)) }
  }
  /**
   * 会话 id 归一化：运行期键是 session-<uuid>，调用方常传裸 uuid ⇒ 统一补前缀。
   * 校验：空白或只有 'session-' 视为非法，返回空串（唤醒方据此判失败）。
   */
  function normalizeSessionId(value) {
    return canonicalSessionId(value)
  }
  async function wakeSession(sessionId, reason, token) {
    const id = normalizeSessionId(sessionId)
    if (id === '') { diag('会话 id 非法，跳过唤醒：' + JSON.stringify(String(sessionId ?? ''))); return false }
    let controller = null
    try { controller = ctx.get('sessionController') } catch { controller = null }
    if (controller !== null && controller !== undefined && typeof controller.resolveAgent === 'function') {
      try { await controller.resolveAgent(SessionId(id)) }
      catch (error) { diag('官方唤醒失败 ' + id + '：' + String(error?.message ?? error)) }
    }
    // reload/设置保存可能已换掉令牌：这时**不能再 followup**，否则同一会话收到两条「已重启完成」。
    if (typeof token === 'number' && token !== wakeEpoch) {
      diag('唤醒已过时（新的 apply 接管），跳过 session=' + id)
      return false
    }
    let agent = null
    try {
      const agents = ctx.get('agents')
      agent = agents !== undefined && agents !== null && typeof agents.get === 'function' ? (agents.get(SessionId(id)) || null) : null
    } catch { agent = null }
    if (agent === null || typeof agent.followup !== 'function') { diag('拿不到可唤醒的 agent：' + id); return false }
    try {
      agent.followup(noticeMessage('【已重启完成 · ' + stampOf(Date.now()) + '】宿主已按请求重启。' + (reason === '' ? '' : '原因：' + reason + '。') + '请继续未完成的工作。'))
      diag('已唤醒会话 ' + id)
      return true
    } catch (error) { diag('followup 唤醒失败 ' + id + '：' + String(error?.message ?? error)); return false }
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
  /** 没有会话到期时的轮询节流：最长睡 5 秒，保证 TTL 检查与外部改动都能及时看到。 */
  const WAKE_MAX_SLEEP_MS = 5000
  /**
   * 唤醒调度：跨重启可续、有计数与退避、不重复唤醒。
   *
   * 状态全在清单里（attempts / nextAttemptAt / done），每次变化都原子落盘 ⇒
   * 唤醒到一半宿主又被重启一次，下一次启动接着等退避，而不是从头再来。
   *   · 只有 now >= nextAttemptAt 的会话才尝试；
   *   · 成功立刻记 done 并落盘；失败 attempts+1、退避 5s→…→300s 封顶 ±20% 抖动；
   *   · 同一会话在途时不重复唤醒（inFlight）；并发 ≤ WAKE_MAX_CONCURRENT，逐项失败隔离；
   *   · 连续失败到 WAKE_MAX_ATTEMPTS 放弃该会话并记诊断；
   *   · pendingTtlMs 仍是总过期：到点就停、保留清单给下次启动。
   */
  async function runWakeLoop(initial, ttl, token) {
    let state = initial
    const deadline = Number(state.requestedAt || 0) + Number(ttl)
    const inFlight = new Set()
    const flush = () => {
      if (allSettled(state)) { clearPending(); return }
      writePending(state)
    }
    for (;;) {
      // single-flight：令牌变了 = 已经有更新的 apply 接手，本循环立刻退出。
      if (token !== wakeEpoch) { diag('唤醒循环已被新的 apply 取代，退出'); return }
      const now = Date.now()
      if (now >= deadline) {
        diag('唤醒清单已过 TTL，停止本轮唤醒并保留清单：' + JSON.stringify(state.sessions.filter((id) => isSettled(state, id) !== true)))
        return
      }
      if (allSettled(state)) {
        clearPending()
        diag('唤醒全部完成（成功或已放弃），清单已清')
        return
      }
      const due = dueWakes(state, now).filter((id) => inFlight.has(id) !== true)
      if (due.length === 0) {
        const next = nextWakeAt(state)
        const untilNext = next === null ? WAKE_MAX_SLEEP_MS : Math.min(WAKE_MAX_SLEEP_MS, Math.max(250, next - now))
        await sleep(Math.min(untilNext, Math.max(0, deadline - now)))
        continue
      }
      // 并发上限：分批跑；同一批里某个会话失败/抛错不影响别人。
      for (let i = 0; i < due.length; i += WAKE_MAX_CONCURRENT) {
        const batch = due.slice(i, i + WAKE_MAX_CONCURRENT)
        await Promise.all(batch.map(async (id) => {
          if (token !== wakeEpoch) return
          inFlight.add(id)
          try {
            const ok = await wakeSession(id, state.reason, token)
            // await 期间可能已经换令牌：旧循环不得再改状态/落盘，否则会把新循环已清的清单写回。
            if (token !== wakeEpoch) { diag('唤醒结果已过时（新的 apply 接管），丢弃 session=' + id); return }
            if (ok === true) {
              state = markDone(state, id)
              diag('唤醒成功：' + id)
            } else {
              state = markFailed(state, id, Date.now())
              const attempt = attemptOf(state, id)
              const nextAt = Number(state.nextAttemptAt?.[id] ?? 0)
              diag('唤醒失败 ' + id + '：第 ' + attempt + ' 次'
                + (attempt >= WAKE_MAX_ATTEMPTS
                  ? '（已达 ' + WAKE_MAX_ATTEMPTS + ' 次上限，放弃该会话）'
                  : '，下次 ' + new Date(nextAt).toISOString()))
            }
            flush()
          } catch (error) {
            if (token !== wakeEpoch) { diag('唤醒抛错但已换令牌，丢弃 session=' + id); return }
            // 抛错同样是「本次失败」：不记 attempts 的话下一拍立刻重试 ⇒ 热循环。
            state = markFailed(state, id, Date.now())
            const attempt = attemptOf(state, id)
            diag('唤醒抛错 ' + id + '：' + String(error?.message ?? error)
              + '（第 ' + attempt + ' 次' + (attempt >= WAKE_MAX_ATTEMPTS
                ? '，已达 ' + WAKE_MAX_ATTEMPTS + ' 次上限，放弃该会话）'
                : '，下次 ' + new Date(Number(state.nextAttemptAt?.[id] ?? 0)).toISOString()) + '）')
            flush()
          } finally { inFlight.delete(id) }
        }))
      }
    }
  }
  /** 读脚本结果文件：脚本每次运行都会写 running → ok/failed；读不到或格式不对返回 null。 */
  function readResult() {
    try {
      if (existsSync(resultFile()) === false) return null
      const parsed = JSON.parse(readFileSync(resultFile(), 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch { return null }
  }
  /**
   * 等脚本回报结果。
   * 脚本在失败路径上几秒内就会写 failed（宿主进程不在 / exe 不在安装目录 / 强杀失败…），
   * 成功路径要几十秒 ⇒ 等不到是正常的，不能当成失败。
   */
  async function waitResult(ms) {
    const deadline = Date.now() + ms
    for (;;) {
      const value = readResult()
      if (value !== null && value.outcome !== 'running') return value
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  /** 拉起脚本后等它回报的时长：够它跑完「认宿主进程 + 校验 exe」这几步（实测约 3~4 秒）。 */
  const RESULT_WAIT_MS = 6000
  /** 一次重启被拉起后的冷却：这段时间内不受理第二次请求（连点两下会拉出两个脚本互相杀）。 */
  const RESTART_COOLDOWN_MS = 60000
  /** 不传 delaySeconds 时的默认延迟：够宿主把工具回执落盘，又不至于让人干等（用户 2026-10-07 定）。 */
  const DEFAULT_DELAY_SECONDS = 10
  let inFlight = false
  let lastLaunchedAt = 0
  /**
   * 三个入口（工具 / UI 端点 / dshRestart 服务）共用的闸门：
   * 已有一次在进行中 / 上一次刚拉起 ⇒ 拒绝，避免并发双实例。
   */
  async function restartGuarded(payload) {
    if (inFlight === true) return { ok: false, error: '已有一次重启正在进行中，本次请求已忽略' }
    if (Date.now() - lastLaunchedAt < RESTART_COOLDOWN_MS) {
      return { ok: false, error: '上一次重启刚拉起（' + Math.round((Date.now() - lastLaunchedAt) / 1000) + ' 秒前），本次请求已忽略' }
    }
    inFlight = true
    try {
      const result = await runRestart(payload)
      if (result.ok === true && result.dryRun !== true) lastLaunchedAt = Date.now()
      return result
    } finally { inFlight = false }
  }
  async function runRestart(payload) {
    // 只支持 Windows 桌面端：脚本是 PowerShell + WMI，别的平台没有这套东西。
    // 在这里直接拒绝，比让 powershell 起不来再报错更清楚（也不会静默失败）。
    if (process.platform !== 'win32') return { ok: false, error: '本插件只支持 Windows 桌面端（当前平台：' + process.platform + '）' }
    const script = scriptFor()
    if (existsSync(script) === false) return { ok: false, error: '重启脚本不存在：' + script }
    const dryRun = current().dryRun === true
    const record = {
      ...newPendingState({
        requestedAt: Date.now(),
        // 谁写的清单：同一个进程不该认自己写的清单（它还活着 ⇒ 那次重启没发生）。
        launcherPid: process.pid,
        reason: String(payload.reason || '').slice(0, 200),
        // 演练不重启，却会把 id 留在清单里 ⇒ 30 分钟内被别的启动唤醒成「已重启完成」✗
        sessions: dryRun === true
          ? []
          : (Array.isArray(payload.sessionIds) ? payload.sessionIds.map((v) => String(v)).filter((v) => v !== '') : []),
      }),
      requestedBy: String(payload.requestedBy || ''),
      dryRun,
    }
    if (writePending(record) === false) return { ok: false, error: '无法写入待唤醒清单：' + pendingFile() }
    diag('重启请求：' + JSON.stringify(record))
    if (record.dryRun === true) return { ok: true, dryRun: true, script, record }
    // 延迟：**不传＝10 秒**（留给回执落盘）；显式传值照用，0 就是立刻重启。
    const rawDelay = payload.delaySeconds
    const delay = rawDelay === undefined || rawDelay === null || rawDelay === '' ? DEFAULT_DELAY_SECONDS : Number(rawDelay)
    // 结果文件：先删掉上一轮留下的，免得把旧结果当成本次结果。
    try { rmSync(resultFile(), { force: true }) } catch {}
    // 拉起前 fail-fast：安装目录下没有宿主 exe ⇒ 直接报错，**不拉起脚本**
    // （否则要等脚本跑几秒才拒绝，用户白等一轮；而且 WMI 照样 rc=0 更容易误判）。
    const installRoot = launchInstallRoot()
    const hostExe = installRoot === '' ? '' : join(installRoot, 'DeepSeek Harness.exe')
    if (hostExe === '' || existsSync(hostExe) === false) {
      clearPending()
      diag('拒绝重启：找不到宿主可执行文件（安装目录 ' + (installRoot === '' ? '(未确定)' : installRoot) + '）')
      return {
        ok: false,
        error: hostExe === ''
          ? '找不到宿主可执行文件：安装目录未确定（请在 设置 → 重启 里填「宿主安装目录」）'
          : '找不到宿主可执行文件：' + hostExe + '（安装目录配置：' + (samePath(installRoot, scriptDefaultInstallRoot()) ? '脚本内置默认' : '手动配置/自动探测') + '）',
      }
    }
    // 宿主进程就是本进程：脚本按 PID + 进程树定位，**不再依赖端口**（0.2.1 起宿主端口
    // 改为每次启动随机，端口已无法用来认进程）；安装目录仍用于「别杀错进程」的安全校验。
    const args = restartScriptArgs({
      pid: process.pid,
      delaySeconds: delay,
      installRoot,
      resultFile: resultFile(),
    })
    // 实测踩坑与最终做法：
    //   ① spawnSync ⇒ 被 bat 末尾的 pause 卡死（工具调用超时）✗
    //   ② 普通 spawn ⇒ 从 DSH 起的子进程会被 subprocess 服务**连带清理** ✗
    //   ⇒ 必须用 **WMI Win32_Process.Create** 创建（父进程是 WmiPrvSE ⇒ 脱离本进程树），
    //     并读子进程 stdout 拿到 rc/pid（确定性，不靠固定等待）。
    // powershell -File 只吃 .ps1：以前缺 .ps1 时会拿 .bat 去喂它，报错难懂、等于没有兜底。
    const ps1 = script.replace(/\.bat$/i, '.ps1')
    if (existsSync(ps1) === false) {
      // 重启不会发生 ⇒ 必须撤掉清单，否则下次启动会把它当成本次重启的待唤醒项。
      clearPending()
      return { ok: false, error: '找不到重启脚本（.ps1）：' + ps1 }
    }
    const useScript = ps1
    const inner = restartShellCommand({
      script: useScript,
      args,
      showWindow: current().showScriptWindow === true,
    })
    const psCommand = "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"
      + inner.replace(/'/g, "''") + "' }; 'rc=' + $r.ReturnValue + ' pid=' + $r.ProcessId"
    return await new Promise((resolve) => {
      let settled = false
      const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
      let child = null
      try {
        child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) { finish({ ok: false, error: String(error?.message ?? error) }); return }
      let out = ''
      let err = ''
      try { child.stdout?.on('data', (chunk) => { out += String(chunk) }) } catch {}
      try { child.stderr?.on('data', (chunk) => { err += String(chunk) }) } catch {}
      child.on('error', (error) => {
        diag('拉起重启器失败：' + String(error?.message ?? error))
        finish({ ok: false, error: '启动 powershell 失败：' + String(error?.message ?? error) })
      })
      const timer = setTimeout(() => finish({ ok: true, confirmed: false, script: useScript }), 20000)
      child.on('close', () => {
        clearTimeout(timer)
        const text = (out.trim() + (err.trim() === '' ? '' : ' err=' + err.trim())).trim()
        diag('WMI 拉起重启器：' + text)
        if (/rc=0/.test(text) === false) {
          // 连进程都没创建出来 ⇒ 重启不会发生，把清单撤掉（否则下次启动会误唤醒成「已重启完成」）。
          clearPending()
          finish({ ok: false, error: '创建重启进程失败：' + (text === '' ? '（无输出）' : text) })
          return
        }
        // rc=0 只说明「脚本进程创建成功」，不等于脚本会干活：它可能在头几秒就拒绝
        // （宿主进程已不在 / exe 不在安装目录…）。那时若回 ok:true，agent 会以为
        // 重启在路上而一直干等 ⇒ 回读脚本写的结果文件，当场把拒绝报出来。
        void (async () => {
          const reported = await waitResult(RESULT_WAIT_MS)
          if (reported !== null && reported.outcome === 'failed') {
            clearPending()
            diag('脚本拒绝重启：' + JSON.stringify(reported))
            finish({
              ok: false,
              error: '重启脚本拒绝执行：' + String(reported.message ?? '未说明原因') + (reported.code === undefined ? '' : '（退出码 ' + String(reported.code) + '）'),
              script: useScript,
              wmi: text,
            })
            return
          }
          finish({ ok: true, confirmed: true, script: useScript, wmi: text, scriptReport: reported === null ? 'unknown' : String(reported.outcome ?? 'unknown') })
        })()
      })
    })
  }
  const restartService = {
    async run(payload) {
      const value = payload !== null && typeof payload === 'object' ? payload : {}
      return await restartGuarded(value)
    },
    status() { return { agentToolEnabled: current().agentToolEnabled === true, startedAt, pending: readPending(), script: scriptFor() } },
  }
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('dshRestart', restartService)
      diag('已 provide 服务 dshRestart')
    } else {
      ctx.set('dshRestart', restartService)
      diag('服务 dshRestart 用 ctx.set 暴露（无 ctx.provide）')
    }
  } catch (error) { diag('注册服务失败：' + String(error?.message ?? error)) }
  try {
    ctx.inject(['tools'], (toolsCtx) => {
      // 2026-10-06：整个回调包 try/catch + 每一步写诊断 ——
      // 上一版这里**静默失败**了（日志里既没有「工具就绪」也没有「tools 不可用」⇒ 回调里抛错被吞 ✗），
      // 害得排查了半天「工具到底注册上没有」。
      try {
        const holder = toolsCtx !== null && toolsCtx !== undefined ? toolsCtx : ctx
        let tools = null
        try { tools = holder.get('tools') } catch { tools = null }
        if (tools === null || tools === undefined || typeof tools.register !== 'function') {
          diag('tools 不可用，工具未注册'); return
        }
        // 开关关着 ⇒ 干脆不注册（模型连这个工具都看不到）。
        if (current().agentToolEnabled !== true) {
          diag('agent 工具开关是关的 ⇒ 不注册 dsh_restart（在设置 → 重启 里打开后需重启 DSH 生效）')
          return
        }
        diag('tools 就绪，开始注册 dsh_restart')
        tools.register(defineTool({
          name: 'dsh_restart',
          description: "重启 DSH 宿主（桌面端）。⚠️ 这会**中断 harness 本进程与正在跑的回合**：调用前请确认**这次改动不会导致 DSH 崩溃或起不来**（改宿主核心算，改任意插件的 host 半边、改 profile 配置也算）；没有把握就先向用户确认，不要自己赌。**宿主繁忙时本工具直接拒绝重启，且没有任何绕过参数**——繁忙判定＝有正在跑的会话／有排队消息／有在跑或正在停的后台任务／有已武装的定时提醒（**调用方自己那一轮不算**，本工具就是给你重启自己用的）；判定不出来（服务取不到）也按拒绝处理。本工具没有任何强制/绕过参数。重启后插件会按 sessionIds 自动唤醒这些会话，并提示「已重启完成，请继续」——用于自主重启调试（改了 host 插件需要重载时）。工具会先把唤醒清单落盘再交给重启脚本；脚本缺失会直接拒绝重启；脚本若在头几秒就拒绝（宿主进程已不在、exe 不在安装目录…），工具会**如实报失败并撤掉唤醒清单**。同一次重启被拉起后的 60 秒内不接受第二次请求（防连点造成双实例）。**本工具由用户在「设置 → 重启」里的开关控制**（默认关）：你能看到它，说明用户已经打开；用户运行时关掉，它会立刻改为一律拒绝，并在下次启动起不再注册。",
          parameters: {
            reason: { type: 'string', required: true, description: '为什么要重启（写进清单与唤醒提示）' },
            sessionIds: { type: 'string', required: true, description: '重启后要自动唤醒的会话 id；多个用英文逗号分隔（通常写你自己的会话 id）' },
            delaySeconds: { type: 'number', description: '延迟多少秒再重启（不传＝10 秒：留给回执落盘；0＝立刻）' },
          },
          // 2026-10-06 实测：defineTool 必须给 output（含 render）——
          // 少了它会抛 Cannot read properties of undefined (reading 'render') ✗
          output: {
            schema: {
              type: 'object',
              additionalProperties: true,
              properties: {
                ok: { type: 'boolean', required: true },
                error: { type: 'string' },
                script: { type: 'string' },
                dryRun: { type: 'boolean' },
                scriptReport: { type: 'string' },
              },
            },
            render: (_args, value) => {
              let text = ''
              if (value.ok === true) {
                text = '重启请求已受理'
                if (value.dryRun === true) text += '（演练，未真重启）'
                else if (value.scriptReport === 'unknown') text += '（脚本已拉起，尚未回报结果）'
                else text += '（脚本已开始执行）'
                if (value.script !== undefined && value.script !== null) text += ' · 脚本：' + value.script
              } else {
                text = '重启失败：' + String(value.error ?? '未知原因')
              }
              return [{ type: 'text', text }]
            },
          },
          async execute(args, exec) {
            // 双保险：开关关着时本来就不注册这个工具；但「运行时把它关掉」这一下要立刻生效，
            // 所以调用时再查一次（故意不给工具参数绕过）。
            if (current().agentToolEnabled !== true) {
              return { ok: false, error: 'agent 调用重启工具的能力当前是关闭的（默认关）：请在 设置 → 重启 里打开「允许 agent 调用重启工具」' }
            }
            const reason = String(args?.reason ?? '').trim()
            if (reason === '') return { ok: false, error: 'reason 必填' }
            const ids = String(args?.sessionIds ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '')
            if (ids.length === 0) return { ok: false, error: 'sessionIds 必填（重启后要唤醒谁）' }
            // 2026-10-06 用户要求：AI **禁止在繁忙时重启**，且**不给任何绕过开关**（工具没有 force 参数）。
            // 判定不出来（known!==true）同样拒绝：宁可不重启。
            // 2026-10-07 用户实测反馈：**调用方自己那个会话不算繁忙** —— agent 调这个工具时，
            // 它自己那一轮就是 running，若把它算进去则判定恒为繁忙、工具永远调不动。
            // exec.agent 由宿主传入（dsh-tools 的 tool.execute(args, exec)；dsh-agent-loop 构造
            // { callId, name, arguments, agent, signal }），其 id 与会话 id 同一个。
            const idle = await desktopIdleState(String(exec?.agent?.id ?? ''))
            if (idle.known !== true || idle.idle !== true) {
              diag('工具重启被繁忙拒绝：' + JSON.stringify(idle))
              return { ok: false, error: '宿主繁忙（' + idle.reason + '），AI 不得重启' }
            }
            return await restartGuarded({ reason, sessionIds: ids, requestedBy: 'tool', delaySeconds: args?.delaySeconds })
          },
        }))
        diag('工具就绪：注册 dsh_restart 完成')
      } catch (error) {
        diag('注册工具抛错：' + String(error?.message ?? error))
      }
    })
  } catch (error) { diag('注册工具失败：' + String(error?.message ?? error)) }
  try {
    // 先扫掉上一次被杀的原子写残留（只删本清单的 tmp 前缀）。
    cleanupStalePendingTmp()
    const rawPending = readPending()
    const value = current()
    const pending = migratePending(rawPending)
    if (pending !== null && pending.sessions.length > 0 && Number(rawPending?.schemaVersion) !== WAKE_SCHEMA_VERSION) {
      // 旧格式（只有 sessions 字符串数组）→ schemaVersion 2：立刻落盘一次，
      // 让「计数/退避/完成」从这次启动起就有据可查（写失败也不影响本轮唤醒）。
      writePending(pending)
      diag('启动：待唤醒清单已从旧格式迁移到 schemaVersion ' + WAKE_SCHEMA_VERSION)
    }
    if (pending !== null && value.wakeOnStart === true) {
      const has = pending.sessions.length > 0
      // TTL 统一口径：<=0 一律回落到默认值；fresh 判断与唤醒循环用**同一个** ttl。
      const ttl = value.pendingTtlMs > 0 ? value.pendingTtlMs : DEFAULTS.pendingTtlMs
      const fresh = has && Date.now() - Number(pending.requestedAt || 0) < ttl
      // 清单是「当前这个进程」写的 ⇒ 那个进程还活着 ⇒ 那次重启根本没发生，不该唤醒（也清掉）。
      const ownRecord = has && Number(pending.launcherPid || 0) === process.pid
      if (ownRecord) {
        diag('启动：清单是当前进程自己写的（重启没发生），忽略并清掉')
        clearPending()
      } else if (fresh) {
        diag('启动：发现待唤醒清单 ' + JSON.stringify(pending.sessions) + ' done=' + JSON.stringify(pending.done) + ' attempts=' + JSON.stringify(pending.attempts))
        // 2026-10-06 实测：启动后 3 秒去唤醒，`agents.get()` 还取不到 agent（会话尚未就绪）
        // ⇒ 唤醒丢失、清单还被清掉 ✗。所以先等 wakeDelayMs，再按「到期才试」循环：
        // 失败进退避（5s→300s 封顶），成功即记 done；只有全部有结论才清清单。
        setTimeout(() => {
          // 等 wakeDelayMs 期间又被 apply 了一次 ⇒ 这份调度已作废。
          if (wakeToken !== wakeEpoch) { diag('唤醒调度已被新的 apply 取代，跳过'); return }
          void runWakeLoop(pending, ttl, wakeToken).catch((error) => diag('唤醒流程抛错：' + String(error?.message ?? error)))
        }, Math.max(0, Number(value.wakeDelayMs) || 0))
      } else if (has) { diag('启动：清单已过期，丢弃'); clearPending() }
    }
  } catch (error) { diag('启动唤醒流程抛错：' + String(error?.message ?? error)) }
  // ── 同源 web 端点：给 UI 按钮用（ctx.webServer.register）──
  /**
   * UI 端点的门禁。宿主那层 webServer **不做** Origin/鉴权检查（实测：带外源 Origin 的 POST
   * 也会照常进到插件里），所以门禁只能自己加：
   *   ⓪ 非 Windows 一律拒绝（脚本是 PowerShell + WMI，别的平台没有这套东西）；带代理头
   *      （x-forwarded-for / x-real-ip / forwarded）的请求同样拒绝：来源已不可信；
   *   ① 只认回环地址 —— 宿主若绑到 0.0.0.0，局域网里任何人都能打，这一步把局域网挡掉；
   *   ② 必须带自定义请求头 x-dsh-restart —— 跨源请求会因此先触发浏览器预检，而宿主不放行 CORS ⇒ 别的网页打不进来；
   *   ③ 带了 Origin 就必须与 Host 同源（同源 fetch 不一定带 Origin，所以是「带了才查」）。
   * 注意：自定义头不是密码，挡的是浏览器，不是本机上的其它程序。
   */
  function requestAllowed(req) {
    // ⓪ 平台闸门：本插件只支持 Windows 桌面端 —— 所有 UI 端点（含改配置）一律 403，
    // 免得别的平台点按钮时得到「看似受理、其实脚本根本起不来」的结果。
    if (process.platform !== 'win32') {
      return { ok: false, reason: '本插件只支持 Windows 桌面端（当前平台：' + process.platform + '）' }
    }
    // ① 反向代理头闸门：带 x-forwarded-for / x-real-ip / forwarded 的请求一定经过了代理，
    // 它的 socket 地址不再代表真实来源 ⇒ 一律拒绝（宁可不重启）。
    const headers = req?.headers ?? {}
    for (const key of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
      const raw = headers[key]
      if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        return { ok: false, reason: '请求带代理头 ' + key + '（来源不可信），拒绝' }
      }
    }
    const addr = String(req?.socket?.remoteAddress ?? '')
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    if (loopback !== true) return { ok: false, reason: '来源不是本机回环地址（' + addr + '）' }
    if (String(headers['x-dsh-restart'] ?? '') !== '1') return { ok: false, reason: '缺少 x-dsh-restart 请求头' }
    const origin = String(headers.origin ?? '').trim()
    if (origin !== '') {
      let sameOrigin = false
      try { sameOrigin = new URL(origin).host === String(headers.host ?? '').trim() } catch { sameOrigin = false }
      if (sameOrigin !== true) return { ok: false, reason: 'Origin 与 Host 不同源（' + origin + '）' }
    }
    return { ok: true, reason: '' }
  }
  /** 统一的 JSON 响应（设置面板与重启端点共用）。 */
  function sendJson(res, status, payload) {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    } catch {}
  }
  /** 设置面板上可读写的字段（再拿 Config 声明核一遍：写进未知键会让插件下次启动静默不挂载）。 */
  const PANEL_FIELDS = ['agentToolEnabled', 'installRoot', 'showScriptWindow', 'wakeOnStart', 'wakeDelayMs', 'pendingTtlMs', 'scriptPath', 'dryRun']
  /**
   * 面板字段的类型与取值范围。**必须按类型收敛**：写进 profile patch 的值与 Config 声明的类型不符时，
   * 插件下次启动会**静默不挂载**（本仓 .opencodereview/rule.json 记过这条坑）。
   * 所以这里不信任浏览器发来的任何值：类型/范围不对就跳过该字段，不写脏值。
   */
  const PANEL_TYPES = {
    agentToolEnabled: 'boolean',
    wakeOnStart: 'boolean',
    dryRun: 'boolean',
    showScriptWindow: 'boolean',
    wakeDelayMs: 'ms',
    pendingTtlMs: 'ms',
    installRoot: 'string',
    scriptPath: 'string',
  }
  /** 把外部值收敛成 Config 认的类型；类型/范围不对返回 undefined。 */
  function coerceConfigValue(kind, value) {
    if (kind === 'boolean') return value === true || value === false ? value : undefined
    if (kind === 'ms') {
      const n = Number(value)
      return Number.isFinite(n) === true && n >= 0 ? Math.floor(n) : undefined
    }
    if (kind === 'string') return typeof value === 'string' ? value : undefined
    return undefined
  }
  /** 面板数据 = 字段值 + 只读状态（探测到的安装目录、待唤醒清单、上一次脚本结果）。 */
  function panelPayload() {
    const values = current()
    const fields = {}
    for (const key of PANEL_FIELDS) fields[key] = { value: values[key] === undefined ? null : values[key] }
    const pending = readPending()
    return {
      fields,
      status: {
        agentToolEnabled: values.agentToolEnabled === true,
        platform: process.platform,
        hostPid: process.pid,
        installRootConfigured: values.installRoot,
        installRootDetected: detectInstallRoot(),
        installRootEffective: effectiveInstallRoot(),
        busy: inFlight === true,
        lastLaunchedAt,
        pendingCount: pending === null || Array.isArray(pending.sessions) !== true ? 0 : pending.sessions.length,
        pendingRequestedAt: pending === null ? null : (pending.requestedAt ?? null),
        lastResult: readResult(),
        script: scriptFor(),
      },
    }
  }
  function webHandler(req, res) {
    try {
      const path = String(req?.url ?? '').split('?')[0]
      // 门禁对**所有** /dsh-restart/api/* 生效 —— 设置端点能改配置，同样是敏感操作。
      if (path.startsWith('/dsh-restart/api/')) {
        const allowed = requestAllowed(req)
        if (allowed.ok !== true) {
          diag('UI 请求被门禁拒绝：' + allowed.reason + '（' + path + '）')
          sendJson(res, 403, { ok: false, error: '拒绝：' + allowed.reason })
          return true
        }
      }
      // ── 设置面板 ──
      if (req?.method === 'GET' && path === '/dsh-restart/api/panel') {
        sendJson(res, 200, { ok: true, ...panelPayload() })
        return true
      }
      if (req?.method === 'POST' && path === '/dsh-restart/api/config') {
        void (async () => {
          try {
            const body = await readJsonBody(req)
            const patch = body !== null && typeof body === 'object' && body.patch !== null && typeof body.patch === 'object' ? body.patch : {}
            const declared = new Set(Object.keys(Config.dict ?? {}))
            const clean = {}
            const rejected = []
            for (const [key, value] of Object.entries(patch)) {
              if (declared.has(key) !== true) continue
              const kind = PANEL_TYPES[key]
              if (kind === undefined) continue
              const typed = coerceConfigValue(kind, value)
              if (typed === undefined) {
                rejected.push(key)
                diag('设置页拒绝写入（类型/范围不符）：' + key + '=' + JSON.stringify(value))
                continue
              }
              clean[key] = typed
            }
            if (Object.keys(clean).length === 0) {
              sendJson(res, 400, {
                ok: false,
                error: rejected.length === 0 ? '没有可写入的字段' : ('字段值不合法，没有写入任何改动：' + rejected.join('、')),
              })
              return
            }
            // 持久化走官方 configEditor（写进 profile 的 patch 层）。
            const editor = ctx.get('configEditor')
            const entry = ctx.fiber?.entry
            if (editor === undefined || editor === null || typeof editor.edit !== 'function' || entry === undefined || entry === null) {
              sendJson(res, 503, { ok: false, error: 'configEditor 不可用，改动无法持久化' })
              return
            }
            await editor.edit(entry, (raw) => ({ ...(raw ?? {}), ...clean }))
            diag('设置页改配置：' + Object.keys(clean).join(','))
            sendJson(res, 200, { ok: true, ...panelPayload() })
          } catch (error) { sendJson(res, 500, { ok: false, error: msg(error) }) }
        })().catch((error) => diag('设置端点未捕获：' + msg(error)))
        return true
      }
      // ── 重启按钮 ──
      if (req?.method === 'POST' && path === '/dsh-restart/api/restart') {
        void (async () => {
          let result = null
          try {
            const body = await readJsonBody(req)
            const force = body !== null && typeof body === 'object' && body.force === true
            const idle = await desktopIdleState()
            const busy = idle.known !== true || idle.idle !== true
            if (force !== true && busy === true) {
              // 繁忙 + 用户还没确认 ⇒ **不重启**，把 busy/reason 交回按钮（按钮据此弹红色确认框）。
              result = { ok: false, busy: true, reason: idle.reason }
              diag('UI 重启被繁忙拒绝（等用户确认）：' + idle.reason)
            } else {
              // force 语义＝用户已在界面确认过；空闲时走的就是这一支（不弹框）。
              result = await restartGuarded({
                reason: force === true ? 'UI 按钮（用户已确认）' : 'UI 按钮',
                sessionIds: [], requestedBy: 'ui', delaySeconds: 0,
              })
              result = { ...result, busy, reason: idle.reason }
              diag('UI 重启请求：' + JSON.stringify(result))
            }
          } catch (error) {
            diag('UI 重启端点失败：' + msg(error))
            result = { ok: false, error: msg(error) }
          }
          sendJson(res, 200, result)
        })().catch((error) => diag('UI 重启端点未捕获：' + msg(error)))
        return true
      }
      // host 的 prefix 路由**命中即当已处理**，return false 不会走 fallback ⇒ 请求会挂到超时。
      // 所以不是本插件的路径也要自己结束响应。
      try { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('dsh-restart: not found') } catch {}
      return true
    } catch (error) {
      diag('webHandler 抛错：' + msg(error))
      try { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('dsh-restart: internal error') } catch {}
      return true
    }
  }
  // 注册走两条路（ctx.get + ctx.inject），谁先到算谁 ⇒ 必须幂等：
  // 重复注册会因 webserver: duplicate prefix route 直接抛错。
  let webRegistered = false
  function registerWebApi(ws, via) {
    if (webRegistered === true) { diag('web 端点已注册，跳过重复注册（via ' + via + '）'); return }
    if (ws === null || ws === undefined || typeof ws.register !== 'function') { diag('web 端点注册跳过（via ' + via + '）'); return }
    try {
      ws.register({ kind: 'prefix', path: '/dsh-restart', handler: webHandler })
      webRegistered = true
      diag('web 端点已注册（via ' + via + '）：/dsh-restart/api/restart')
    } catch (error) { diag('web 端点注册失败：' + msg(error)) }
  }
  try { registerWebApi(ctx.get('webServer'), 'get') } catch (error) { diag('ctx.get(webServer) 抛错：' + msg(error)) }
  try {
    ctx.inject(['webServer'], (wctx) => {
      // 用 effect 托管 disposer：重载时把守卫复位，否则下一个生命周期会拒绝注册
      wctx.effect(() => {
        registerWebApi(wctx.webServer, 'inject')
        return () => { webRegistered = false }
      })
    })
  } catch (error) { diag('ctx.inject(webServer) 失败：' + msg(error)) }
  diag('apply done wakeOnStart=' + String(current().wakeOnStart))
}
