/**
 * dsh-restart 的**浏览器半边**：侧边栏底部（sidebar.footer.action）一个「重启」按钮。
 *
 * 交互（2026-10-06 用户定的四条）：
 *   ① 空闲：点一下**直接重启**，不弹任何对话框；
 *   ② 繁忙：host 先拒（返回 busy:true）⇒ 按钮自绘确认层（确认键**红色**），
 *      确认后带 {force:true} 再 POST（force 是 UI 用户确认后的通道，只在这个端点上有）；
 *   ③ 用 window.confirm 做不出红色按钮 ⇒ 自绘极简 overlay，不引入新依赖；
 *   ④ 尺寸逐条对齐**它下面那个控件**。
 *
 * 尺寸对齐的对象（2026-10-06 从 app.asar 里读出来的实测值）：
 *   sidebar.footer.action 的**下邻**＝ sidebar.settings 席位里的「设置触发行」，
 *   由 @deepseek-ai/dsh-client-ui-settings-general 渲染（.wCInkW_triggerRow / .wCInkW_trigger）：
 *     行：width calc(100% + 4px)、margin 4px -2px、gap 8px、display flex；
 *     按钮：height 42px、border-radius var(--dsw-radius-md)（＝12px）、
 *            padding 0 10px 0 8px、font-size 14px / line-height 22px、
 *            color var(--dsw-alias-label-primary)、透明底、无边框、flex 1、
 *            hover 背景 var(--dsw-alias-interactive-bg-hover)；
 *     收起态（rail）：36×36、margin 8px 0 10px、居中。
 *   （sidebar 包自己只给了容器 .footerActions{display:flex} / .settingsArea，没有按钮样式，
 *     所以数值取自下邻控件的实际来源包。）
 *
 * 为什么走同源 HTTP：DSH 0.2 的浏览器半边拿不到宿主服务句柄，
 * 只能由 host 侧开一个同源端点，浏览器这边同源 fetch。
 */
window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    let reactDom = null
    try { reactDom = require('react-dom') } catch { reactDom = null }
    const API_BASE = '/dsh-restart/api'
    const API = API_BASE + '/restart'
    /** 门禁要求所有 /api/* 请求都带这个自定义头（跨源请求会因此先被浏览器预检挡住）。 */
    const HEADERS = { 'x-dsh-restart': '1' }

    // ── 尺寸常量：逐字对齐下邻的「设置触发行」(.wCInkW_triggerRow / .wCInkW_trigger) ──
    const ROW = {
      flex: 'none', alignItems: 'center', gap: '8px',
      width: 'calc(100% + 4px)', margin: '4px -2px', display: 'flex', position: 'relative',
    }
    const ROW_RAIL = { width: '36px', margin: '8px 0 10px' }
    const BTN = {
      boxSizing: 'border-box', borderRadius: 'var(--dsw-radius-md)', cursor: 'pointer',
      width: 'auto', minWidth: 0, height: '42px', color: 'var(--dsw-alias-label-primary)',
      background: 'transparent', border: 'none', flex: '1', alignItems: 'center', gap: '8px',
      margin: 0, padding: '0 10px 0 8px', fontFamily: 'inherit', fontSize: '14px',
      lineHeight: '22px', display: 'flex', overflow: 'hidden',
    }
    const BTN_RAIL = {
      flex: 'none', justifyContent: 'center', gap: 0,
      width: '36px', height: '36px', margin: 0, padding: 0,
    }
    const HOVER_BG = 'var(--dsw-alias-interactive-bg-hover)'

    /**
     * 繁忙确认层：极简 overlay + 面板 + 「取消 / 仍然重启（红底）」。
     * 点遮罩或按 Esc ＝ 取消。
     */
    function BusyConfirm({ reason, onCancel, onConfirm }) {
      react.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onCancel])
      const layerStyle = {
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .35))',
      }
      const panelStyle = {
        boxSizing: 'border-box', width: '380px', maxWidth: 'calc(100vw - 48px)', padding: '16px',
        borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
        color: 'var(--dsw-alias-label-primary, #1a1a1a)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 32px rgba(0, 0, 0, .28))',
        fontFamily: 'inherit', fontSize: '14px', lineHeight: '22px',
      }
      const cancelStyle = {
        height: '32px', padding: '0 14px', border: '1px solid var(--dsw-alias-border-l3, #d9d9d9)',
        borderRadius: 'var(--dsw-radius-sm)', background: 'transparent', color: 'inherit',
        fontFamily: 'inherit', fontSize: '14px', cursor: 'pointer',
      }
      const confirmStyle = {
        height: '32px', padding: '0 14px', border: 'none',
        borderRadius: 'var(--dsw-radius-sm)', background: '#d4380d', color: '#ffffff',
        fontFamily: 'inherit', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
      }
      const layer = h('div', { style: layerStyle, onClick: onCancel },
        h('div', { style: panelStyle, onClick: (event) => event.stopPropagation() },
          h('div', { style: { fontWeight: 500, marginBottom: '8px' } }, '宿主正在忙，仍要重启吗？'),
          h('div', { style: { color: 'var(--dsw-alias-label-secondary, #666666)', marginBottom: '16px' } },
            reason === '' ? '正在跑的工作会被中断。' : '正在跑的工作会被中断：' + reason),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
            h('button', { type: 'button', onClick: onCancel, style: cancelStyle }, '取消'),
            h('button', { type: 'button', onClick: onConfirm, style: confirmStyle }, '仍然重启'),
          ),
        ),
      )
      if (reactDom !== null && typeof reactDom.createPortal === 'function') return reactDom.createPortal(layer, document.body)
      return layer
    }

    function RestartButton(props) {
      const wide = props === null || props === undefined ? true : props.wide !== false
      const [state, setState] = react.useState('idle')
      const [note, setNote] = react.useState('')
      const [ask, setAsk] = react.useState(null)
      const [hover, setHover] = react.useState(false)

      /** POST 端点：force=true 只在「用户在确认层点过仍然重启」时用。 */
      // 自定义请求头是门槛的一部分：跨源请求必须带它 ⇒ 浏览器会先发预检，而宿主不放行 CORS ⇒ 别的网页调不动。
      const post = (force) => fetch(API, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, HEADERS),
        body: JSON.stringify(force === true ? { force: true } : {}),
      }).then((response) => response.json())

      const run = (force) => {
        setState('busy'); setNote('')
        post(force).then((data) => {
          if (data !== null && data !== undefined && data.ok === true) { setState('done'); setNote('重启中…'); return }
          // 只有「没带 force 的那一次」才可能因为繁忙而弹框；带 force 回来的失败一律按失败报。
          if (force !== true && data !== null && data !== undefined && data.busy === true) {
            setState('idle'); setAsk(String(data.reason ?? '')); return
          }
          setState('failed'); setNote(String(data?.error ?? '失败'))
        }).catch((error) => { setState('failed'); setNote(String(error?.message ?? error)) })
      }

      const onClick = () => {
        if (state === 'busy' || state === 'done') return
        run(false)
      }
      // 用查表代替嵌套三元（系统规则禁止嵌套三元）
      const TONE = {
        idle: 'var(--dsw-alias-label-primary)',
        busy: 'var(--dsw-alias-label-secondary)',
        done: '#237804',
        failed: '#d4380d',
      }
      const TEXT = { idle: '重启', busy: '重启中…', done: '已请求重启', failed: '重启' }
      const color = TONE[state] ?? TONE.idle
      const label = TEXT[state] ?? TEXT.idle
      const row = h('div', { style: wide === true ? ROW : { ...ROW, ...ROW_RAIL } },
        h('button', {
          type: 'button',
          title: '重启 DSH 宿主（会中断正在跑的回合）' + (note === '' ? '' : '：' + note),
          disabled: state === 'busy',
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            ...BTN,
            ...(wide === true ? {} : BTN_RAIL),
            color,
            background: hover === true && state !== 'busy' ? HOVER_BG : 'transparent',
            cursor: state === 'busy' ? 'default' : 'pointer',
          },
        }, label),
      )
      const overlay = ask === null
        ? null
        : h(BusyConfirm, {
          reason: ask,
          onCancel: () => setAsk(null),
          onConfirm: () => { setAsk(null); run(true) },
        })
      return h(react.Fragment, null, row, overlay)
    }

    // ── 设置页「重启」面板（注册 settings.section 槽位 + 同源 API 读写）──
    /** 面板字段：分组 / 键 / 标签 / 类型 / 提示。 */
    const GROUPS = [
      { title: '安全', fields: [
        { key: 'agentToolEnabled', label: '允许 agent 调用重启工具', kind: 'boolean', hint: '默认关。关着时**不注册**这个工具（模型看不到它）；打开后需重启 DSH 才生效（用侧边栏的重启按钮即可）。运行时关掉会立刻改为一律拒绝。' },
      ] },
      { title: '本机', fields: [
        { key: 'desktopPort', label: '宿主监听端口', kind: 'number', hint: '脚本靠它定位宿主进程；不是默认 19387 时必须改这里' },
        { key: 'installRoot', label: '宿主安装目录', kind: 'text', hint: '留空 = 自动探测（探测结果见上方状态行）' },
      ] },
      { title: '唤醒', fields: [
        { key: 'wakeOnStart', label: '重启后自动唤醒会话', kind: 'boolean' },
        { key: 'wakeDelayMs', label: '唤醒前等待（毫秒）', kind: 'number', hint: '等宿主把会话准备好再唤醒，太早会拿不到会话' },
      ] },
    ]
    const S = {
      wrap: { maxWidth: '760px', color: 'var(--dsw-alias-label-primary, inherit)' },
      title: { margin: '0 0 12px', fontSize: '18px', fontWeight: 600 },
      card: { border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', borderRadius: '12px', padding: '12px 14px', marginBottom: '12px' },
      row: { marginBottom: '10px' },
      label: { display: 'inline-block', width: '230px', verticalAlign: 'top', fontSize: '13px' },
      input: { width: '330px', padding: '4px 6px', fontSize: '13px' },
      hint: { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: '12px', marginTop: '2px' },
      groupTitle: { margin: '0 0 8px', fontSize: '14px', fontWeight: 600, opacity: 0.9 },
      btn: { padding: '5px 14px', fontSize: '13px', cursor: 'pointer' },
      status: { fontSize: '13px', marginBottom: '10px', lineHeight: '20px' },
      ok: { color: 'var(--dsw-alias-state-success-primary, #1a7f37)' },
      bad: { color: 'var(--dsw-alias-state-error-primary, #c0392b)' },
    }

    function Panel() {
      const [data, setData] = react.useState(null)
      const [draft, setDraft] = react.useState({})
      const [busy, setBusy] = react.useState(false)
      const [msg, setMsg] = react.useState('')
      const load = react.useCallback(() => {
        fetch(API_BASE + '/panel', { headers: Object.assign({ accept: 'application/json' }, HEADERS) })
          .then((res) => res.json())
          .then((json) => { setData(json); setDraft({}); setMsg('') })
          .catch((error) => setMsg('读取失败：' + String((error && error.message) || error)))
      }, [])
      react.useEffect(() => { load() }, [load])

      const fields = (data && data.fields) || {}
      const status = (data && data.status) || null
      const valueOf = (key) => {
        if (Object.prototype.hasOwnProperty.call(draft, key)) return draft[key]
        const slot = fields[key]
        if (slot === undefined || slot === null) return ''
        return slot.value === undefined || slot.value === null ? '' : slot.value
      }
      const edit = (key, next) => {
        setDraft((current) => { const merged = Object.assign({}, current); merged[key] = next; return merged })
        setMsg('')
      }
      const changed = Object.keys(draft)
      const dirty = changed.length > 0
      const save = () => {
        if (!dirty || busy) return
        setBusy(true); setMsg('')
        const patch = {}
        for (const key of changed) patch[key] = draft[key]
        fetch(API_BASE + '/config', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, HEADERS),
          body: JSON.stringify({ patch }),
        })
          .then((res) => res.json())
          .then((json) => {
            if (json && json.ok) { setData(json); setDraft({}); setMsg('已保存（热生效，不用重启）') }
            else setMsg('保存失败：' + String((json && json.error) || '未知错误'))
          })
          .catch((error) => setMsg('保存失败：' + String((error && error.message) || error)))
          .then(() => setBusy(false))
      }
      const control = (field) => {
        const raw = valueOf(field.key)
        if (field.kind === 'boolean') {
          return h('input', { type: 'checkbox', checked: raw === true, onChange: (event) => edit(field.key, event.target.checked) })
        }
        return h('input', {
          type: field.kind === 'number' ? 'number' : 'text',
          value: raw === undefined || raw === null ? '' : String(raw),
          style: S.input,
          onChange: (event) => edit(field.key, field.kind === 'number' ? Number(event.target.value) : event.target.value),
        })
      }
      const rowOf = (field) => h('div', { key: field.key, style: S.row }, [
        h('label', { key: 'l', style: S.label }, field.label),
        control(field),
        field.hint ? h('div', { key: 'h', style: S.hint }, field.hint) : null,
      ])

      if (data === null) return h('div', { style: S.wrap }, [h('p', { key: 'l' }, '加载中…'), msg ? h('p', { key: 'e', style: S.bad }, msg) : null])
      const last = status === null ? null : status.lastResult
      return h('div', { style: S.wrap }, [
        h('h2', { key: 't', style: S.title }, '重启（dsh-restart）'),
        h('div', { key: 'st', style: S.status }, status === null ? '状态未知' : [
          h('div', { key: 'p' }, '宿主端口 ' + String(status.desktopPort) + '　·　平台 ' + String(status.platform) + '　·　' + (status.busy ? '正在重启' : '空闲')),
          h('div', { key: 'r' }, '安装目录：' + String(status.installRootEffective || '（探测不到）') + (status.installRootConfigured ? '（手动配置）' : '（自动探测）')),
          h('div', { key: 'a' }, 'agent 调用重启工具：', h('span', { key: 'v', style: status.agentToolEnabled ? S.ok : S.bad }, status.agentToolEnabled ? '允许' : '禁止（默认）')),
          h('div', { key: 'w' }, '待唤醒清单：' + String(status.pendingCount) + ' 条'),
          h('div', { key: 'l' }, '上次脚本结果：' + (last === null ? '（还没有）' : String(last.outcome) + ' · ' + String(last.message || '').slice(0, 80))),
        ]),
        GROUPS.map((group) => h('div', { key: group.title, style: S.card }, [
          h('h3', { key: 'gt', style: S.groupTitle }, group.title),
          group.fields.map(rowOf),
        ])),
        h('div', { key: 'actions' }, [
          h('button', { key: 'save', type: 'button', style: S.btn, disabled: !dirty || busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { key: 'reload', type: 'button', style: Object.assign({}, S.btn, { marginLeft: '8px' }), onClick: () => { setMsg(''); load() } }, '刷新'),
          h('button', { key: 'reset', type: 'button', style: Object.assign({}, S.btn, { marginLeft: '8px' }), disabled: !dirty, onClick: () => { setDraft({}); setMsg('') } }, '放弃改动'),
          msg ? h('span', { key: 'msg', style: { marginLeft: '12px', fontSize: '13px' } }, msg) : null,
        ]),
      ])
    }

    function apply(ctx) {
      // 2026-10-06 用户实测选定的位置：sidebar.footer.action（侧边栏底部动作位）。
      ctx.slots.inject('sidebar.footer.action', () => {
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-restart', order: 999 }, RestartButton)
      })
      // 设置页分节：inject 回调不 return disposer（槽位服务自管生命周期）。
      ctx.slots.inject('settings.section', () => {
        ctx.slots.register({ name: 'settings.section', id: 'dsh-restart', order: 27, label: () => '重启' }, Panel)
      })
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = ['slots']
    module.exports.name = 'dsh-restart'
    return module.exports
  },
})
