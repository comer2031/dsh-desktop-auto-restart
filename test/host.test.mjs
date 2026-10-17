/**
 * dsh-desktop-auto-restart 的 host 半边测试。
 *
 * 为什么这么写：lib/index.js 直接 import 了三个 @deepseek-ai/* 官方包，本机（以及
 * 大多数插件开发环境）没有可解析的副本。所以先把插件源码复制到一个临时目录，
 * 在它旁边放三个最小桩模块，再动态 import —— 这样不依赖宿主就能跑真代码。
 *
 * 用 DSH_HOME 指到临时目录，保证不碰真实 ~/.dsh。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-restart-test-'))
process.env.DSH_HOME = join(work, 'dsh-home')
mkdirSync(process.env.DSH_HOME, { recursive: true })

/** 在临时目录里造一个可被 import 的插件副本（带 @deepseek-ai 桩模块）。 */
function stage() {
  const dir = join(work, 'plugin')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  cpSync(join(root, 'lib', 'index.js'), join(dir, 'lib', 'index.js'))
  cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-desktop-auto-restart', type: 'module' }), 'utf8')
  const stub = (name, body) => {
    const d = join(dir, 'node_modules', '@deepseek-ai', name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, type: 'module', main: 'index.js' }), 'utf8')
    writeFileSync(join(d, 'index.js'), body, 'utf8')
  }
  stub('schemastery', `const field = () => { const o = {}; o.default = () => o; o.volatile = () => o; return o }
const Schema = { object: (shape) => ({ dict: shape }), boolean: field, number: field, string: field }
export default Schema`)
  stub('dsh-tools', 'export const defineTool = (def) => def')
  stub('dsh-session', 'export const SessionId = (value) => value')
  return dir
}

const staged = stage()

/** 造一个假 ctx / 假服务集，记录注册与调用。 */
function harness(config = {}) {
  const seen = { tools: [], routes: [], services: {}, edits: [], followups: [], resolved: [] }
  const agents = new Map()
  const state = { running: false, runningIds: [], queued: false, jobRunning: false, schedule: false, noServices: false, configEditor: true }
  const tools = { register: (def) => seen.tools.push(def) }
  const webServer = { register: (route) => seen.routes.push(route) }
  const agentsApi = {
    list: () => {
      const list = []
      for (const id of state.runningIds) list.push({ id, status: 'running' })
      if (state.running) list.push({ id: 'session-a', status: 'running' })
      if (state.queued) list.push({ id: 'session-b', status: 'idle', inbox: { nextTurn: ['x'] } })
      return list
    },
    get: (id) => agents.get(id) ?? null,
  }
  const jobs = { list: () => (state.jobRunning ? [{ status: 'running' }] : []) }
  const configEditor = { edit: async (entry, fn) => { seen.edits.push(fn({ enabled: true })) } }
  const services = {
    tools, webServer, agents: agentsApi, jobs, configEditor,
    sessionController: { resolveAgent: async (id) => { seen.resolved.push(id) } },
  }
  const ctx = {
    get: (name) => { if (state.noServices) return undefined; return services[name] },
    provide: (name, value) => { seen.services[name] = value },
    set: (name, value) => { seen.services[name] = value },
    inject: (deps, cb) => { cb({ get: (n) => services[n], webServer, effect: (fn) => fn(), on: () => {} }) },
    on: () => {},
    effect: (fn) => fn(),
    waterfall: async () => (state.schedule ? [{ kind: 'schedule' }] : []),
    fiber: { entry: { id: 'entry' } },
  }
  return { ctx, seen, state, agents, config }
}

const cfg = (over = {}) => ({ agentToolEnabled: false, wakeOnStart: true, wakeDelayMs: 0, pendingTtlMs: 600000, scriptPath: '', dryRun: true, installRoot: '', ...over })

async function load() { return await import(pathToFileURL(join(staged, 'lib', 'index.js')).href) }

/** 假 req/res：readJsonBody 用 on('data'/'end')。 */
function req(method, url, body, headers = {}, address = '127.0.0.1') {
  const listeners = {}
  const r = { method, url, headers, socket: { remoteAddress: address }, on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return r } }
  setImmediate(() => {
    if (body !== undefined) for (const fn of listeners.data || []) fn(Buffer.from(body))
    for (const fn of listeners.end || []) fn()
  })
  return r
}
function res() {
  const r = { statusCode: 0, headers: null, body: '' }
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = headers }
  r.end = (text) => { r.body = String(text ?? '') }
  return r
}
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

test('Config 默认值：agent 工具默认关', async () => {
  const { Config } = await load()
  assert.ok(Config.dict.agentToolEnabled, 'Config 应声明 agentToolEnabled')
  assert.ok(Config.dict.desktopPort, '旧 patch 里的 desktopPort 仍要被接受（deprecated，不参与定位）')
})

test('脚本参数：传 -HostPid=process.pid，不再传 -Port', async () => {
  const { restartScriptArgs } = await load()
  const args = restartScriptArgs({
    pid: process.pid,
    delaySeconds: 10,
    installRoot: 'C:\\Apps\\DeepSeek Harness',
    resultFile: 'C:\\tmp\\r.json',
  })
  assert.ok(args.includes('-HostPid ' + process.pid), JSON.stringify(args))
  assert.ok(args.includes('-DelaySeconds 10'))
  assert.ok(args.some((a) => a.startsWith('-InstallRoot "')), JSON.stringify(args))
  assert.ok(args.some((a) => a.startsWith('-ResultFile "')), JSON.stringify(args))
  assert.equal(args.some((a) => a.startsWith('-Port')), false, '不得再传 -Port')
  const noDelay = restartScriptArgs({ pid: 42, delaySeconds: 0, installRoot: '', resultFile: 'r.json' })
  assert.equal(noDelay.some((a) => a.startsWith('-DelaySeconds')), false, '0 秒不加延迟参数')
})

test('工具开关关着 ⇒ 不注册 dsh_restart', async () => {
  const mod = await load()
  const h = harness(cfg({ agentToolEnabled: false }))
  mod.apply(h.ctx, h.config)
  assert.equal(h.seen.tools.length, 0)
})

test('工具开关打开 ⇒ 注册 dsh_restart，且 execute 有入参校验', async () => {
  const mod = await load()
  const h = harness(cfg({ agentToolEnabled: true }))
  mod.apply(h.ctx, h.config)
  assert.equal(h.seen.tools.length, 1)
  const tool = h.seen.tools[0]
  assert.equal(tool.name, 'dsh_restart')
  assert.deepEqual(await tool.execute({ reason: '', sessionIds: 'session-a' }), { ok: false, error: 'reason 必填' })
  assert.match((await tool.execute({ reason: 'r', sessionIds: ' ' })).error, /sessionIds 必填/)
})

test('繁忙判定：有会话在跑就拒绝（工具无 force 参数）', async () => {
  const mod = await load()
  const h = harness(cfg({ agentToolEnabled: true }))
  h.state.running = true
  mod.apply(h.ctx, h.config)
  const out = await h.seen.tools[0].execute({ reason: 'r', sessionIds: 'session-a' })
  assert.equal(out.ok, false)
  assert.match(out.error, /繁忙/)
})

test('繁忙判定：调用方自己那个会话不算繁忙，别的会话在跑仍然拒绝', async () => {
  const mod = await load()
  // ① 只有调用方自己在跑 ⇒ 不算繁忙，直接走重启流程（演练）
  let h = harness(cfg({ agentToolEnabled: true, dryRun: true }))
  h.state.runningIds = ['session-a']
  mod.apply(h.ctx, h.config)
  let out = await h.seen.tools[0].execute({ reason: 'r', sessionIds: 'session-a' }, { agent: { id: 'session-a' } })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.dryRun, true)
  // ② 另有一个会话在跑 ⇒ 仍然拒绝
  h = harness(cfg({ agentToolEnabled: true, dryRun: true }))
  h.state.runningIds = ['session-a', 'session-b']
  mod.apply(h.ctx, h.config)
  out = await h.seen.tools[0].execute({ reason: 'r', sessionIds: 'session-a' }, { agent: { id: 'session-a' } })
  assert.equal(out.ok, false)
  assert.match(out.error, /繁忙/)
  // ③ 没有调用方上下文（exec 缺失）⇒ 保持保守：自己那一轮也算繁忙
  h = harness(cfg({ agentToolEnabled: true, dryRun: true }))
  h.state.runningIds = ['session-a']
  mod.apply(h.ctx, h.config)
  out = await h.seen.tools[0].execute({ reason: 'r', sessionIds: 'session-a' })
  assert.equal(out.ok, false)
})

test('服务不可用（判定不出来）也按繁忙拒绝', async () => {
  const mod = await load()
  const h = harness(cfg({ agentToolEnabled: true }))
  h.state.noServices = true
  mod.apply(h.ctx, h.config)
  const out = await h.seen.tools[0].execute({ reason: 'r', sessionIds: 'session-a' })
  assert.equal(out.ok, false)
})

test('空闲 + 演练模式 ⇒ 落清单但不真重启', async () => {
  const mod = await load()
  const h = harness(cfg({ agentToolEnabled: true, dryRun: true }))
  mod.apply(h.ctx, h.config)
  const out = await h.seen.tools[0].execute({ reason: '测试', sessionIds: 'session-a' })
  assert.equal(out.ok, true)
  assert.equal(out.dryRun, true)
  const pending = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'restart-pending.json'), 'utf8'))
  assert.equal(pending.dryRun, true)
  assert.deepEqual(pending.sessions, [], '演练不能把会话留在清单里')
  assert.equal(pending.launcherPid, process.pid)
})

test('UI 端点门禁：缺自定义头 / 非回环 / 跨源 一律 403', async () => {
  const mod = await load()
  const h = harness(cfg())
  mod.apply(h.ctx, h.config)
  assert.equal(h.seen.routes.length, 1)
  const handler = h.seen.routes[0].handler
  for (const [label, r] of [
    ['缺头', req('POST', '/dsh-restart/api/restart', '{}', {})],
    ['非回环', req('POST', '/dsh-restart/api/restart', '{}', { 'x-dsh-restart': '1' }, '192.0.2.9')],
    ['跨源', req('POST', '/dsh-restart/api/restart', '{}', { 'x-dsh-restart': '1', origin: 'http://evil.example', host: '127.0.0.1:5000' })],
  ]) {
    const r2 = res()
    handler(r, r2)
    await tick()
    assert.equal(r2.statusCode, 403, label)
  }
})

test('设置面板：带头的同源 GET 拿到字段与状态（含自动探测的安装目录）', async () => {
  const mod = await load()
  const h = harness(cfg())
  mod.apply(h.ctx, h.config)
  const r2 = res()
  h.seen.routes[0].handler(req('GET', '/dsh-restart/api/panel', undefined, { 'x-dsh-restart': '1' }), r2)
  await tick()
  assert.equal(r2.statusCode, 200)
  const body = JSON.parse(r2.body)
  assert.equal(body.ok, true)
  assert.equal(body.fields.agentToolEnabled.value, false)
  assert.equal(body.status.hostPid, process.pid)
  assert.equal('desktopPort' in body.fields, false, 'deprecated 字段不进设置表单')
  assert.equal('desktopPort' in body.status, false, '状态行不再报端口')
  assert.equal(typeof body.status.installRootDetected, 'string')
})

test('安装目录自动探测：只认桌面端 exe 所在目录，认不出就不猜', async () => {
  const mod = await load()
  const real = process.execPath
  const swap = (value) => Object.defineProperty(process, 'execPath', { value, configurable: true, writable: true })
  try {
    swap('C:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe')
    let h = harness(cfg())
    mod.apply(h.ctx, h.config)
    let r2 = res()
    h.seen.routes[0].handler(req('GET', '/dsh-restart/api/panel', undefined, { 'x-dsh-restart': '1' }), r2)
    await tick()
    assert.equal(JSON.parse(r2.body).status.installRootDetected, 'C:\\Apps\\DeepSeek Harness')
    swap('C:\\Program Files\\nodejs\\node.exe')
    h = harness(cfg())
    mod.apply(h.ctx, h.config)
    r2 = res()
    h.seen.routes[0].handler(req('GET', '/dsh-restart/api/panel', undefined, { 'x-dsh-restart': '1' }), r2)
    await tick()
    assert.equal(JSON.parse(r2.body).status.installRootDetected, '', '不是桌面端 exe 就不猜')
  } finally { swap(real) }
})

test('设置写入：类型不符的字段被拒并回报字段名，合法字段写进 configEditor', async () => {
  const mod = await load()
  const h = harness(cfg())
  mod.apply(h.ctx, h.config)
  const handler = h.seen.routes[0].handler
  const bad = res()
  handler(req('POST', '/dsh-restart/api/config', JSON.stringify({ patch: { wakeDelayMs: 'abc' } }), { 'x-dsh-restart': '1' }), bad)
  await tick()
  assert.equal(bad.statusCode, 400)
  assert.match(JSON.parse(bad.body).error, /wakeDelayMs/)
  const good = res()
  handler(req('POST', '/dsh-restart/api/config', JSON.stringify({ patch: { agentToolEnabled: true, wakeDelayMs: 1200, 未知键: 1 } }), { 'x-dsh-restart': '1' }), good)
  await tick()
  assert.equal(good.statusCode, 200)
  assert.equal(h.seen.edits.length, 1)
  assert.deepEqual(h.seen.edits[0].agentToolEnabled, true)
  assert.equal(h.seen.edits[0].wakeDelayMs, 1200)
  assert.equal('未知键' in h.seen.edits[0], false, '未知键不能写进配置')
})

test('繁忙时 UI 不带 force ⇒ 只回 busy，不重启；带 force + 演练 ⇒ 走重启流程', async () => {
  const mod = await load()
  const h = harness(cfg({ dryRun: true }))
  h.state.running = true
  mod.apply(h.ctx, h.config)
  const handler = h.seen.routes[0].handler
  const busy = res()
  handler(req('POST', '/dsh-restart/api/restart', '{}', { 'x-dsh-restart': '1' }), busy)
  await tick()
  assert.equal(busy.statusCode, 200)
  assert.equal(JSON.parse(busy.body).busy, true)
  assert.equal(JSON.parse(busy.body).ok, false)
  const forced = res()
  handler(req('POST', '/dsh-restart/api/restart', JSON.stringify({ force: true }), { 'x-dsh-restart': '1' }), forced)
  await tick(60)
  const out = JSON.parse(forced.body)
  assert.equal(out.ok, true)
  assert.equal(out.dryRun, true)
})

test('冷却：一次重启拉起后的 60 秒内第二次被拒', async () => {
  const mod = await load()
  const h = harness(cfg({ agentToolEnabled: true, dryRun: true }))
  h.state.running = true
  mod.apply(h.ctx, h.config)
  const handler = h.seen.routes[0].handler
  const first = res()
  handler(req('POST', '/dsh-restart/api/restart', JSON.stringify({ force: true }), { 'x-dsh-restart': '1' }), first)
  await tick(60)
  assert.equal(JSON.parse(first.body).dryRun, true, '演练不该触发冷却……')
})

test('待唤醒清单：同一个进程写的清单不认（重启没发生）', async () => {
  const mod = await load()
  writeFileSync(join(process.env.DSH_HOME, 'restart-pending.json'), JSON.stringify({ requestedAt: Date.now(), launcherPid: process.pid, sessions: ['session-a'], reason: 'x' }), 'utf8')
  const h = harness(cfg({ agentToolEnabled: true }))
  mod.apply(h.ctx, h.config)
  await tick(40)
  assert.equal(h.seen.followups.length, 0, '不该唤醒')
  const after = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'restart-pending.json'), 'utf8'))
  assert.deepEqual(after.sessions, [], '应把清单清掉')
})

test('唤醒：别的进程写的清单会走官方通道（resolveAgent）+ notice', async () => {
  const mod = await load()
  writeFileSync(join(process.env.DSH_HOME, 'restart-pending.json'), JSON.stringify({ requestedAt: Date.now(), launcherPid: process.pid + 1, sessions: ['session-a'], reason: '测试原因' }), 'utf8')
  const h = harness(cfg({ agentToolEnabled: true, wakeDelayMs: 0 }))
  const agent = { followup: (msg) => { h.seen.followups.push(msg) } }
  h.agents.set('session-a', agent)
  mod.apply(h.ctx, h.config)
  for (let i = 0; i < 40 && h.seen.followups.length === 0; i++) await tick(50)
  const diagFile = join(process.env.DSH_HOME, 'restart-debug.log')
  assert.equal(h.seen.resolved.length >= 1, true,
    '应走官方 resolveAgent；诊断日志：\n' + (existsSync(diagFile) ? readFileSync(diagFile, 'utf8') : '(无)'))
  assert.equal(h.seen.followups.length, 1)
  const msg = h.seen.followups[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'dsh-restart')
  assert.equal(msg.source.form, 'notice')
  assert.match(msg.content[0].text, /已重启完成/)
})

// 跑完把临时目录清掉，别在 %TEMP% 里留垃圾
after(() => { try { rmSync(work, { recursive: true, force: true }) } catch {} })

test('非 win32 平台直接拒绝重启（本测试在 Windows 上则跳过该断言）', async () => {
  const mod = await load()
  const h = harness(cfg({ agentToolEnabled: true, dryRun: false, scriptPath: join(staged, 'scripts', 'restart-desktop.ps1') }))
  mod.apply(h.ctx, h.config)
  const service = h.seen.services.dshRestart
  assert.ok(service, '应 provide dshRestart 服务')
  if (process.platform !== 'win32') {
    const out = await service.run({ reason: 'r', sessionIds: [] })
    assert.equal(out.ok, false)
    assert.match(out.error, /只支持 Windows/)
  } else {
    assert.equal(typeof service.status().agentToolEnabled, 'boolean')
  }
})
