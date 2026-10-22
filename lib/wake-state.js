/**
 * 重启后唤醒的「落盘状态 + 调度规则」—— 全是纯函数，便于单测。
 *
 * 为什么单独拆出来：唤醒要跨重启可续（重启写到一半又被重启一次也得接得上），
 * 状态在磁盘上，调度规则（谁该醒、退避多久、算不算完成）必须可复现地测。
 * 宿主半边只负责 I/O（读/写 restart-pending.json）与真正调 resolveAgent。
 *
 * 清单格式（schemaVersion 2，向后兼容旧格式的 sessions 字符串数组）：
 *   { schemaVersion: 2, requestedAt, reason, launcherPid,
 *     sessions: [id], attempts: {id: n}, nextAttemptAt: {id: ms}, done: [id] }
 * 旧格式（无 schemaVersion / 无 per-session 字段）由 migratePending 平滑迁移：
 * sessions 原样保留，attempts 从 0 起算、nextAttemptAt 缺省＝立刻可试。
 */

/** 当前清单格式版本。 */
export const WAKE_SCHEMA_VERSION = 2
/** 首次失败后的等待（毫秒）。 */
export const WAKE_BACKOFF_BASE_MS = 5 * 1000
/** 每次失败后的倍增系数。 */
export const WAKE_BACKOFF_FACTOR = 2
/** 单次等待封顶（5 分钟）。 */
export const WAKE_BACKOFF_MAX_MS = 5 * 60 * 1000
/** 抖动比例：±20%，避免多个会话同一秒一起醒。 */
export const WAKE_BACKOFF_JITTER = 0.2
/**
 * 连续失败上限：到顶就放弃该会话并记诊断（不清掉别人的机会）。
 * 取 10 而不是更大：退避累计 5+10+20+40+80+160+300×4 = 1515 秒，
 * 默认 TTL 1800 秒内**可达**；20 次累计会超过 TTL ⇒ 放弃分支永远走不到。
 */
export const WAKE_MAX_ATTEMPTS = 10
/** 同时唤醒的会话数上限。 */
export const WAKE_MAX_CONCURRENT = 3

/**
 * 会话 id 归一化：运行期键是 session-<uuid>，清单里可能只写了裸 uuid。
 * 空白或只有 'session-' 视为非法，返回空串。
 */
export function canonicalSessionId(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  const id = text.startsWith('session-') ? text : 'session-' + text
  return id.length > 'session-'.length ? id : ''
}

/**
 * 第 attempt 次连续失败后，下一次唤醒该等多久。
 * 5s → 10s → 20s → 40s → 80s → 160s → 300s（封顶），每档再叠 ±20% 随机抖动。
 * @param attempt 连续失败次数（从 1 开始）
 * @param rand 随机源（0~1），单测可注入
 */
export function wakeBackoffDelay(attempt, rand = Math.random) {
  const n = Number.isFinite(Number(attempt)) && Number(attempt) >= 1 ? Math.floor(Number(attempt)) : 1
  const base = Math.min(WAKE_BACKOFF_MAX_MS, WAKE_BACKOFF_BASE_MS * Math.pow(WAKE_BACKOFF_FACTOR, n - 1))
  const raw = typeof rand === 'function' ? Number(rand()) : 0.5
  const clamped = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0.5))
  const jitter = 1 + (clamped * 2 - 1) * WAKE_BACKOFF_JITTER
  return Math.min(WAKE_BACKOFF_MAX_MS, Math.max(0, Math.round(base * jitter)))
}

/** 非负整数收敛（脏字段一律当 0，别让 NaN 进调度）。 */
function intOr(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) !== true
}

/** 去重后保留顺序的会话 id 列表。 */
function uniqueIds(value) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(value) ? value : []) {
    const id = canonicalSessionId(item)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 把磁盘上的任意格式（旧版 / 新版 / 半坏）收敛成 schemaVersion 2 状态。
 * 返回 null 表示「没有清单」（不是对象 / 数组）。
 * 注意：不判 TTL、不判 launcherPid —— 那些是调用方的策略。
 */
export function migratePending(raw) {
  if (isPlainObject(raw) !== true) return null
  const sessions = uniqueIds(raw.sessions)
  const sessionSet = new Set(sessions)
  const done = []
  const doneSet = new Set()
  // 旧版 clearPending 写过 { done: true }（布尔「全部完成」标记）；新版是 done 数组。
  for (const item of Array.isArray(raw.done) ? raw.done : []) {
    const id = canonicalSessionId(item)
    if (id === '' || sessionSet.has(id) !== true || doneSet.has(id)) continue
    doneSet.add(id)
    done.push(id)
  }
  if (raw.done === true) {
    for (const id of sessions) {
      if (doneSet.has(id)) continue
      doneSet.add(id)
      done.push(id)
    }
  }
  const rawAttempts = isPlainObject(raw.attempts) ? raw.attempts : {}
  const rawNext = isPlainObject(raw.nextAttemptAt) ? raw.nextAttemptAt : {}
  const attempts = {}
  const nextAttemptAt = {}
  for (const id of sessions) {
    const attempt = intOr(rawAttempts[id], 0)
    if (attempt > 0) attempts[id] = attempt
    const next = intOr(rawNext[id], 0)
    if (next > 0) nextAttemptAt[id] = next
  }
  return {
    schemaVersion: WAKE_SCHEMA_VERSION,
    requestedAt: intOr(raw.requestedAt, 0),
    reason: String(raw.reason ?? ''),
    launcherPid: intOr(raw.launcherPid, 0),
    sessions,
    attempts,
    nextAttemptAt,
    done,
  }
}

/** 新建一份清单状态（写清单时用，保证字段齐全）。 */
export function newPendingState({ sessions = [], reason = '', requestedAt = Date.now(), launcherPid = 0 } = {}) {
  return migratePending({
    schemaVersion: WAKE_SCHEMA_VERSION,
    requestedAt,
    reason,
    launcherPid,
    sessions,
    attempts: {},
    nextAttemptAt: {},
    done: [],
  })
}

/** 该会话已经成功唤醒过。 */
export function isDone(state, id) {
  return Array.isArray(state?.done) && state.done.includes(id)
}

/** 该会话的连续失败次数。 */
export function attemptOf(state, id) {
  return intOr(state?.attempts?.[id], 0)
}

/** 连续失败到上限 ⇒ 放弃（不再重试，也不阻塞清单清理）。 */
export function isAbandoned(state, id) {
  return attemptOf(state, id) >= WAKE_MAX_ATTEMPTS
}

/** 该会话不需要再唤醒了（成功过或已放弃）。 */
export function isSettled(state, id) {
  return isDone(state, id) || isAbandoned(state, id)
}

/** 清单里所有会话都已有结论（成功或放弃）；空清单算完成。 */
export function allSettled(state) {
  const sessions = Array.isArray(state?.sessions) ? state.sessions : []
  return sessions.every((id) => isSettled(state, id))
}

/** now 时刻该尝试的会话：未 settled、未到上限、且已过 nextAttemptAt。 */
export function dueWakes(state, now = Date.now()) {
  const sessions = Array.isArray(state?.sessions) ? state.sessions : []
  const at = intOr(now, Date.now())
  return sessions.filter((id) => {
    if (isSettled(state, id)) return false
    const next = intOr(state?.nextAttemptAt?.[id], 0)
    return at >= next
  })
}

/** 下一个「该醒」的时刻（毫秒）；没有待唤醒的会话返回 null。 */
export function nextWakeAt(state) {
  const sessions = Array.isArray(state?.sessions) ? state.sessions : []
  let next = null
  for (const id of sessions) {
    if (isSettled(state, id)) continue
    const at = intOr(state?.nextAttemptAt?.[id], 0)
    if (next === null || at < next) next = at
  }
  return next
}

/** 记一次成功：立刻进 done（不改 attempts，留作诊断）。 */
export function markDone(state, id) {
  const key = canonicalSessionId(id)
  if (key === '' || isDone(state, key)) return state
  return {
    ...state,
    sessions: [...(state.sessions ?? [])],
    done: [...(state.done ?? []), key],
    attempts: { ...(state.attempts ?? {}) },
    nextAttemptAt: { ...(state.nextAttemptAt ?? {}) },
  }
}

/** 记一次失败：attempts+1，下次唤醒时间 = now + 退避（含 ±20% 抖动）。 */
export function markFailed(state, id, now = Date.now(), rand = Math.random) {
  const key = canonicalSessionId(id)
  if (key === '') return state
  const attempt = attemptOf(state, key) + 1
  const at = intOr(now, Date.now())
  return {
    ...state,
    sessions: [...(state.sessions ?? [])],
    done: [...(state.done ?? [])],
    attempts: { ...(state.attempts ?? {}), [key]: attempt },
    nextAttemptAt: { ...(state.nextAttemptAt ?? {}), [key]: at + wakeBackoffDelay(attempt, rand) },
  }
}
