/**
 * lib/wake-state.js 的纯函数测试：退避、状态迁移、该不该唤醒、完成与放弃。
 * 不依赖宿主：这个模块只 import 标准库（其实一个都没 import）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allSettled,
  attemptOf,
  canonicalSessionId,
  dueWakes,
  isAbandoned,
  isDone,
  isSettled,
  markDone,
  markFailed,
  migratePending,
  newPendingState,
  nextWakeAt,
  wakeBackoffDelay,
  WAKE_BACKOFF_MAX_MS,
  WAKE_MAX_ATTEMPTS,
  WAKE_SCHEMA_VERSION,
} from '../lib/wake-state.js'

const at = 1_700_000_000_000

test('退避：5s 起指数增长、±20% 抖动、5 分钟封顶', () => {
  assert.equal(wakeBackoffDelay(1, () => 0.5), 5000)
  assert.equal(wakeBackoffDelay(2, () => 0.5), 10000)
  assert.equal(wakeBackoffDelay(3, () => 0.5), 20000)
  assert.equal(wakeBackoffDelay(4, () => 0.5), 40000)
  assert.equal(wakeBackoffDelay(5, () => 0.5), 80000)
  assert.equal(wakeBackoffDelay(6, () => 0.5), 160000)
  assert.equal(wakeBackoffDelay(7, () => 0.5), 300000, '320s 封顶到 5 分钟')
  assert.equal(wakeBackoffDelay(1, () => 0), 4000, '-20%')
  assert.equal(wakeBackoffDelay(1, () => 1), 6000, '+20%')
  assert.equal(wakeBackoffDelay(20, () => 1), WAKE_BACKOFF_MAX_MS, '抖动后仍不超封顶')
  assert.equal(wakeBackoffDelay(0, () => 0.5), 5000, '非法次数按第一次算')
  assert.equal(wakeBackoffDelay('x', () => 0.5), 5000)
  const random = wakeBackoffDelay(3)
  assert.ok(random >= 16000 && random <= 24000, String(random))
})

test('会话 id 归一化：补 session- 前缀、去空白、拒非法', () => {
  assert.equal(canonicalSessionId(' 06a15f6c '), 'session-06a15f6c')
  assert.equal(canonicalSessionId('session-06a15f6c'), 'session-06a15f6c')
  assert.equal(canonicalSessionId(''), '')
  assert.equal(canonicalSessionId('session-'), '')
  assert.equal(canonicalSessionId(null), '')
})

test('迁移：旧格式（无 schemaVersion）平滑升级，sessions 仍是字符串数组', () => {
  const old = { requestedAt: at, launcherPid: 4242, reason: '改 host 插件', sessions: ['session-a', 'b', 'session-a', ''] }
  const state = migratePending(old)
  assert.equal(state.schemaVersion, WAKE_SCHEMA_VERSION)
  assert.deepEqual(state.sessions, ['session-a', 'session-b'], '补前缀 + 去重 + 去空')
  assert.deepEqual(state.attempts, {}, '旧格式没有计数，从 0 起算')
  assert.deepEqual(state.nextAttemptAt, {}, '旧格式没有等待时间 ⇒ 立刻可试')
  assert.deepEqual(state.done, [])
  assert.equal(state.requestedAt, at)
  assert.equal(state.launcherPid, 4242)
  assert.equal(state.reason, '改 host 插件')
})

test('迁移：新版 per-session 状态保留；done 数组只认清单里的 id；旧 done:true 表示全部完成', () => {
  const state = migratePending({
    schemaVersion: 2,
    requestedAt: at,
    launcherPid: 1,
    sessions: ['session-a', 'session-b'],
    attempts: { 'session-a': 3, 'session-b': 'x', 'session-ghost': 9 },
    nextAttemptAt: { 'session-a': at + 5000, 'session-b': -1, 'session-ghost': at + 1 },
    done: ['session-b', 'session-ghost'],
  })
  assert.deepEqual(state.attempts, { 'session-a': 3 }, '脏值/清单外 id 丢弃')
  assert.deepEqual(state.nextAttemptAt, { 'session-a': at + 5000 })
  assert.deepEqual(state.done, ['session-b'])

  const cleared = migratePending({ sessions: ['session-a'], done: true })
  assert.deepEqual(cleared.done, ['session-a'])
  assert.equal(allSettled(cleared), true)

  assert.equal(migratePending(null), null)
  assert.equal(migratePending([]), null)
  assert.equal(migratePending('x'), null)
})

test('newPendingState：字段齐全（写清单不再漏 attempts/nextAttemptAt/done）', () => {
  const state = newPendingState({ sessions: ['a', 'session-b'], reason: 'r', requestedAt: at, launcherPid: 7 })
  assert.deepEqual(state, {
    schemaVersion: 2,
    requestedAt: at,
    reason: 'r',
    launcherPid: 7,
    sessions: ['session-a', 'session-b'],
    attempts: {},
    nextAttemptAt: {},
    done: [],
  })
})

test('该不该唤醒：首次到期即试、失败后等 nextAttemptAt、成功/放弃不再试', () => {
  let state = migratePending({ requestedAt: at, launcherPid: 1, sessions: ['session-a'] })
  assert.deepEqual(dueWakes(state, at), ['session-a'])
  assert.deepEqual(dueWakes(state, at - 1), ['session-a'], '旧格式缺省立刻可试')

  state = markFailed(state, 'session-a', at, () => 0.5)
  assert.equal(attemptOf(state, 'session-a'), 1)
  assert.equal(state.nextAttemptAt['session-a'], at + 5000)
  assert.deepEqual(dueWakes(state, at + 4999), [])
  assert.deepEqual(dueWakes(state, at + 5000), ['session-a'], '到点才试')
  assert.equal(nextWakeAt(state), at + 5000)

  state = markFailed(state, 'session-a', at + 5000, () => 0.5)
  assert.equal(attemptOf(state, 'session-a'), 2)
  assert.equal(state.nextAttemptAt['session-a'], at + 15000, '第二次失败等 10s')

  const done = markDone(state, 'session-a')
  assert.equal(isDone(done, 'session-a'), true)
  assert.equal(isSettled(done, 'session-a'), true)
  assert.deepEqual(dueWakes(done, at + 60000), [])
  assert.equal(nextWakeAt(done), null)
  assert.equal(allSettled(done), true)
})

test('放弃：连续失败到上限后不再唤醒，且不再阻塞清单清理', () => {
  let state = migratePending({ requestedAt: at, launcherPid: 1, sessions: ['session-a', 'session-b'] })
  let now = at
  for (let i = 1; i <= WAKE_MAX_ATTEMPTS; i++) {
    state = markFailed(state, 'session-a', now, () => 0.5)
    now = state.nextAttemptAt['session-a']
  }
  assert.equal(attemptOf(state, 'session-a'), WAKE_MAX_ATTEMPTS)
  assert.equal(isAbandoned(state, 'session-a'), true)
  const due = dueWakes(state, now + 10 * WAKE_BACKOFF_MAX_MS)
  assert.equal(due.includes('session-a'), false, '到上限就不再试（session-a）')
  assert.deepEqual(due, ['session-b'], '同批其它会话照常到期')
  assert.equal(allSettled(state), false, 'session-b 还没结论')
  state = markDone(state, 'session-b')
  assert.equal(allSettled(state), true, '放弃的会话不挡清理')
  assert.equal(nextWakeAt(state), null)
})

test('纯函数：不改输入；重复 markDone 幂等', () => {
  const base = migratePending({ requestedAt: at, launcherPid: 1, sessions: ['session-a'] })
  const snapshot = JSON.stringify(base)
  const failed = markFailed(base, 'session-a', at, () => 0.5)
  assert.equal(JSON.stringify(base), snapshot, 'markFailed 不得改原状态')
  assert.notEqual(failed, base)
  const done = markDone(base, 'session-a')
  assert.equal(isDone(base, 'session-a'), false, 'markDone 不得改原状态')
  assert.equal(markDone(done, 'session-a'), done, '已 done 再记一次原样返回')
  assert.equal(attemptOf(done, 'session-a'), 0)
})
