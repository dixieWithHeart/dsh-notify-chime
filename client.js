// dsh-notify-chime — 浏览器半 / browser half
//
// 注册一个设置页（settings.section），三组折叠分区：
//   声音 —— 总开关、四类事件各自开关与试听、最小间隔、子会话
//   通知 —— 通知总开关、哪些事件弹、标题前缀、是否带会话名
//   高级 —— 只读路径与 patch 初值、恢复默认
// 所有写入走宿主路由 /api/dsh-notify-chime/*，改完立即生效（不需要重启）。
//
// 契约：
//   window.__ModuleLoader__.load({ id, factory(require) }) —— id 必须是包名
//   不 require 任何 @deepseek-ai/dsh-client-* 包；React 从 browser module table 取
//   样式只用 --dsw-alias-* 主题 token，且都带 fallback
//
// 实现取舍：除了顶层 SettingsCard，页面里的分区、行、开关都用普通函数拼元素，
// 不用自定义组件——渲染测试（tools/test-client-render.mjs）只执行顶层函数体，
// 子组件里的样式引用漏定义在测试里看不见，真实浏览器会整页空白（踩坑第 15 条）。

window.__ModuleLoader__.load({
  id: 'dsh-notify-chime',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/api/dsh-notify-chime'
    const POLL_MS = 3000
    const LOG = '[dsh-notify-chime]'

    /** 宿主没返回元数据时的兜底（字段缺失也要能渲染）。 */
    const KIND_FALLBACK = [
      { key: 'finished', label: '工作完成', sound: null, soundExists: true },
      { key: 'interrupted', label: '工作中断', sound: null, soundExists: true },
      { key: 'error', label: '工作出错', sound: null, soundExists: true },
      { key: 'question', label: 'Agent 提问', sound: null, soundExists: true },
      { key: 'approval', label: '等待审批', sound: null, soundExists: true },
      { key: 'plan-review', label: '计划评审', sound: null, soundExists: true },
      { key: 'goal-blocked', label: '目标受阻', sound: null, soundExists: true },
      { key: 'job-failed', label: '后台任务失败', sound: null, soundExists: true },
    ]

    /** 宿主没返回音色套清单时的兜底。 */
    const SOUNDSET_FALLBACK = [
      { key: 'default', label: '默认' },
      { key: 'soft', label: '柔和' },
      { key: 'chime', label: '钟声' },
      { key: 'retro', label: '复古' },
      { key: 'digital', label: '电子' },
      { key: 'wood', label: '木质' },
      { key: 'custom', label: '自定义' },
    ]

    const EMPTY_SETTINGS = {
      enabled: true,
      soundset: 'default',
      quietCurrent: false,
      perKindSoundset: {},
      customSounds: {},
      kinds: { finished: true, interrupted: true, error: true, question: true },
      minIntervalMs: 700,
      includeSubagents: false,
      toast: { enabled: false, kinds: ['question'], title: 'DeepSeek Harness', includeSession: true },
    }

    let state = {
      loading: true,
      error: null,
      version: '',
      enabledByPatch: true,
      settings: EMPTY_SETTINGS,
      kinds: KIND_FALLBACK,
      soundsets: SOUNDSET_FALLBACK,
      customSounds: {},
      soundsDir: '',
      traceFile: null,
      settingsFile: '',
      questionTools: [],
      toastAppId: '',
    }
    const listeners = new Set()
    const emit = () => { for (const fn of listeners) fn(state) }
    /** apply 时保存的客户端上下文，供 refresh 读取「当前会话」。 */
    let pluginCtx = null

    /** 读客户端当前打开的会话 id；拿不到就返回 null（该功能温和失效，不影响其它能力）。 */
    function currentSessionId () {
      try {
        const sessions = pluginCtx && typeof pluginCtx.get === 'function' ? pluginCtx.get('sessions') : undefined
        const list = sessions && sessions.list
        const snap = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
        const id = snap ? snap.current : undefined
        return typeof id === 'string' && id.length > 0 ? id : null
      } catch {
        return null
      }
    }

    async function refresh () {
      try {
        const current = currentSessionId()
        const url = API + '/state' + (current ? '?current=' + encodeURIComponent(current) : '')
        const r = await fetch(url, { headers: { accept: 'application/json' } })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        state = { ...state, loading: false, error: null, ...j }
      } catch (e) {
        state = { ...state, loading: false, error: (e && e.message) || '无法连接宿主路由' }
      }
      emit()
    }

    async function save (patch) {
      const r = await fetch(API + '/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      let j = null
      try { j = await r.json() } catch { /* 非 JSON 响应按失败处理 */ }
      if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status))
      state = { ...state, settings: j.settings || state.settings, error: null }
      emit()
      // 设置变了，各事件生效的音色与文件路径（kind 元数据）也要立刻跟上，不等下一轮询
      await refresh()
      return j
    }

    async function playPreview (kind) {
      const r = await fetch(API + '/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
      })
      let j = null
      try { j = await r.json() } catch { /* 非 JSON 响应按失败处理 */ }
      if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status))
      return j
    }

    function useStore () {
      const [snap, setSnap] = useState(state)
      useEffect(() => {
        listeners.add(setSnap)
        setSnap(state)
        return () => { listeners.delete(setSnap) }
      }, [])
      return snap
    }

    const C = {
      border: 'var(--dsw-alias-border-subtle, rgba(130,130,140,0.28))',
      text: 'var(--dsw-alias-text-primary, inherit)',
      dim: 'var(--dsw-alias-text-secondary, rgba(140,140,150,1))',
      accent: 'var(--dsw-alias-accent, #4f7cff)',
      surface: 'var(--dsw-alias-surface-raised, rgba(130,130,140,0.06))',
      danger: 'var(--dsw-alias-danger, #e5534b)',
      radius: 'var(--dsw-radius-lg, 12px)',
      radiusSm: 'var(--dsw-radius-sm, 8px)',
    }

    const S = {
      card: { border: '1px solid ' + C.border, borderRadius: C.radius, padding: '16px 18px', display: 'grid', gap: '14px', color: C.text },
      head: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, margin: 0 },
      badge: { fontSize: '12px', color: C.dim, border: '1px solid ' + C.border, borderRadius: '999px', padding: '1px 8px' },
      status: { marginLeft: 'auto', fontSize: '12px', color: C.dim },
      desc: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: C.dim },
      section: { border: '1px solid ' + C.border, borderRadius: C.radiusSm, overflow: 'hidden' },
      sectionHead: {
        width: '100%', display: 'flex', alignItems: 'baseline', gap: '8px', padding: '9px 12px',
        background: C.surface, border: 'none', color: C.text, cursor: 'pointer', textAlign: 'left',
        font: 'inherit',
      },
      sectionTitle: { fontSize: '13px', fontWeight: 600 },
      sectionHint: { fontSize: '12px', color: C.dim, flex: 1, minWidth: 0 },
      chevron: { fontSize: '11px', color: C.dim, marginLeft: 'auto', flex: 'none' },
      sectionBody: { padding: '12px 14px', display: 'grid', gap: '12px' },
      // 行布局自适应：空间不够时控件整体换到下一行，而不是把标题挤成一字一列
      row: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' },
      rowText: { display: 'grid', gap: '2px', flex: '1 1 200px', minWidth: '180px' },
      rowTitle: { fontSize: '13px', fontWeight: 550 },
      rowDesc: { fontSize: '12px', color: C.dim, lineHeight: 1.5 },
      toggle: (on) => ({
        width: '38px', height: '22px', borderRadius: '999px', border: '1px solid ' + C.border,
        background: on ? C.accent : 'rgba(130,130,140,0.25)', position: 'relative', cursor: 'pointer',
        flex: 'none', marginTop: '2px', transition: 'background 160ms ease',
      }),
      knob: (on) => ({
        position: 'absolute', top: '2px', left: on ? '18px' : '2px', width: '16px', height: '16px',
        borderRadius: '50%', background: '#fff', transition: 'left 160ms ease',
      }),
      inline: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 1 auto', flexWrap: 'wrap', justifyContent: 'flex-end' },
      input: {
        width: '110px', padding: '5px 8px', fontSize: '13px', textAlign: 'right',
        border: '1px solid ' + C.border, borderRadius: C.radiusSm, background: 'transparent', color: C.text,
      },
      inputWide: {
        flex: '1 1 160px', minWidth: '160px', padding: '5px 8px', fontSize: '13px',
        border: '1px solid ' + C.border, borderRadius: C.radiusSm, background: 'transparent', color: C.text,
      },
      btn: (disabled) => ({
        padding: '5px 12px', fontSize: '13px', borderRadius: C.radiusSm,
        border: '1px solid ' + C.border, background: 'transparent', color: C.text,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, flex: 'none',
      }),
      chips: { display: 'flex', gap: '6px', flexWrap: 'wrap', minWidth: 0 },
      /** 行内 chips：允许收缩换行，右对齐 */
      chipsRow: { display: 'flex', gap: '6px', flexWrap: 'wrap', flex: '0 1 auto', minWidth: 0, maxWidth: '100%', justifyContent: 'flex-end' },
      fileBtn: {
        padding: '5px 10px', fontSize: '12px', borderRadius: C.radiusSm, border: '1px dashed ' + C.border,
        color: C.dim, cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap',
      },
      fileInput: { display: 'none' },
      pickerBtn: (on) => ({
        padding: '4px 9px', fontSize: '12px', borderRadius: C.radiusSm,
        border: '1px solid ' + (on ? C.accent : C.border),
        background: 'transparent', color: on ? C.accent : C.dim,
        cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap',
      }),
      kindBlock: { display: 'grid', gap: '6px' },
      panelTitle: { fontSize: '12px', color: C.dim },
      chip: (on) => ({
        padding: '3px 10px', fontSize: '12px', borderRadius: '999px', cursor: 'pointer',
        border: '1px solid ' + (on ? C.accent : C.border),
        background: on ? C.accent : 'transparent',
        color: on ? '#fff' : C.dim,
      }),
      panel: { background: C.surface, borderRadius: C.radiusSm, padding: '12px 14px', display: 'grid', gap: '8px' },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: '12px', color: C.dim },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', wordBreak: 'break-all' },
      msg: (bad) => ({ fontSize: '12px', color: bad ? C.danger : C.dim }),
      foot: { fontSize: '12px', color: C.dim, lineHeight: 1.6, margin: 0 },
      warn: { fontSize: '12px', color: C.danger },
    }

    /** 开关按钮（普通函数，非组件：保证渲染测试能执行到 S.xxx）。 */
    const toggleNode = ({ on, onChange, label }) => h('button', {
      type: 'button',
      'aria-label': label,
      'aria-pressed': on ? 'true' : 'false',
      style: S.toggle(on),
      onClick: () => onChange(!on),
    }, h('span', { style: S.knob(on) }))

    /** 一行设置：左标题与说明，右控件。 */
    const rowNode = ({ title, desc, control }) => h('div', { style: S.row },
      h('div', { style: S.rowText },
        h('div', { style: S.rowTitle }, title),
        desc ? h('div', { style: S.rowDesc }, desc) : null,
      ),
      control,
    )

    function SettingsCard () {
      const s = useStore()
      const [busy, setBusy] = useState(false)
      // 试听 / 上传各自独立：共用一个 busy 会让别的行的按钮一起变灰（看起来像被点了）
      const [previewing, setPreviewing] = useState(null)
      const [uploading, setUploading] = useState(null)
      const [openPanel, setOpenPanel] = useState(null)
      const [msg, setMsg] = useState(null)
      const [openSound, setOpenSound] = useState(true)
      const [openToast, setOpenToast] = useState(true)
      const [openAdvanced, setOpenAdvanced] = useState(false)
      const [confirmReset, setConfirmReset] = useState(false)

      // 兜底：宿主载荷缺字段时也不能让整页空白（踩坑第 15 条）
      const settings = s.settings || EMPTY_SETTINGS
      const toast = settings.toast || EMPTY_SETTINGS.toast
      const kindMap = settings.kinds || {}
      const toastKinds = Array.isArray(toast.kinds) ? toast.kinds : []
      const kindMeta = (Array.isArray(s.kinds) && s.kinds.length > 0) ? s.kinds : KIND_FALLBACK
      const soundsets = (Array.isArray(s.soundsets) && s.soundsets.length > 0) ? s.soundsets : SOUNDSET_FALLBACK
      const soundset = typeof settings.soundset === 'string' ? settings.soundset : 'default'
      const customSounds = settings.customSounds || {}

      const [interval, setIntervalText] = useState(String(settings.minIntervalMs))
      const [intervalDirty, setIntervalDirty] = useState(false)
      const [titleText, setTitleText] = useState(String(toast.title || ''))
      const [titleDirty, setTitleDirty] = useState(false)
      // 宿主值变了（恢复默认、别处改过）就同步输入框；用户正在编辑时不覆盖
      useEffect(() => {
        if (!intervalDirty) setIntervalText(String(settings.minIntervalMs))
      }, [settings.minIntervalMs, intervalDirty])
      useEffect(() => {
        if (!titleDirty) setTitleText(String(toast.title || ''))
      }, [toast.title, titleDirty])

      const flashTimer = useRef(null)
      const flash = (text, bad) => {
        setMsg({ text, bad })
        // 连续提示时先清掉上一个定时器，否则旧定时器会把新消息提前抹掉
        if (flashTimer.current) window.clearTimeout(flashTimer.current)
        flashTimer.current = window.setTimeout(() => { flashTimer.current = null; setMsg(null) }, 2600)
      }

      const commit = useCallback(async (patch, okText) => {
        setBusy(true)
        try {
          await save(patch)
          if (okText) flash(okText, false)
          return true
        } catch (e) {
          flash('保存失败：' + ((e && e.message) || '请确认 DSH 仍在运行'), true)
          return false
        } finally {
          setBusy(false)
        }
      }, [])

      const preview = async (meta) => {
        setPreviewing(meta.key)
        try {
          await playPreview(meta.key)
          flash('正在试听：' + meta.label, false)
        } catch (e) {
          flash('试听失败：' + ((e && e.message) || '宿主未响应'), true)
        } finally {
          setPreviewing(null)
        }
      }

      const statusText = s.error ? ('连接异常：' + s.error)
        : s.loading ? '正在读取…'
          : !settings.enabled ? '已停用：不发声、不弹通知'
            : '正在监听'

      /** 折叠分区。children 在调用处就已构造，内容始终渲染，只用 display 收起。 */
      const sectionNode = (key, title, hint, open, onToggle, children) => h('section', { style: S.section, key },
        h('button', {
          type: 'button',
          style: S.sectionHead,
          'aria-expanded': open ? 'true' : 'false',
          onClick: onToggle,
        },
        h('span', { style: S.sectionTitle }, title),
        h('span', { style: S.sectionHint }, hint),
        h('span', { style: S.chevron }, open ? '▾' : '▸')),
        h('div', { style: open ? S.sectionBody : { ...S.sectionBody, display: 'none' } }, children),
      )

      /** 上传自定义音效：文件选择器拿到的 WAV 直接传给宿主，宿主只写固定目录与固定文件名。 */
      const upload = async (e, meta) => {
        const input = e && e.target
        const file = input && input.files && input.files[0]
        if (!file) return
        if (file.size > 5 * 1024 * 1024) {
          flash('音频文件超过 5 MB', true)
          if (input) input.value = ''
          return
        }
        setUploading(meta.key)
        try {
          const buffer = await file.arrayBuffer()
          const r = await fetch(API + '/sound', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-chime-kind': meta.key },
            body: buffer,
          })
          let j = null
          try { j = await r.json() } catch { /* 非 JSON 响应按失败处理 */ }
          if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status))
          await refresh()
          flash('已上传：' + meta.label + '（该行改用自定义）', false)
        } catch (err) {
          flash('上传失败：' + ((err && err.message) || '未知错误'), true)
        } finally {
          setUploading(null)
          if (input) input.value = ''
        }
      }

      const baseName = (p) => String(p || '').replace(/^.*[\\/]/, '')
      const setLabelOf = (key) => {
        const found = soundsets.find((set) => set.key === key)
        return found ? found.label : key
      }
      /** 该事件最终生效的音色套（宿主已解析好；字段缺失时用全局值兜底）。 */
      const effectiveSet = (meta) => meta.soundset || soundset

      const kindDesc = (meta) => {
        if (meta.soundExists === false) return '音效文件缺失：' + (meta.sound || '（未配置文件路径）')
        if (effectiveSet(meta) === 'custom') {
          const own = customSounds[meta.key]
          return own ? ('自定义文件：' + baseName(own)) : '未上传，这类仍用内置音效'
        }
        return meta.body || ''
      }

      /** 每类事件的音色面板：常驻 DOM、只用 display 收起，渲染测试才覆盖得到。 */
      const soundsetPanel = (meta) => h('div', {
        key: meta.key + '-panel',
        style: openPanel === meta.key ? S.panel : { ...S.panel, display: 'none' },
      },
      h('div', { style: S.panelTitle }, meta.label + ' 用哪套音色'),
      h('div', { style: S.chips },
        h('button', {
          type: 'button',
          key: 'inherit',
          'aria-pressed': meta.soundsetPinned ? 'false' : 'true',
          style: S.chip(!meta.soundsetPinned),
          onClick: () => {
            setOpenPanel(null)
            commit({ perKindSoundset: { [meta.key]: null } }, meta.label + '：跟随全局（' + setLabelOf(soundset) + '）')
          },
        }, '跟随全局'),
        soundsets.map((set) => h('button', {
          type: 'button',
          key: set.key,
          'aria-pressed': (meta.soundsetPinned && meta.soundset === set.key) ? 'true' : 'false',
          style: S.chip(meta.soundsetPinned && meta.soundset === set.key),
          onClick: () => {
            setOpenPanel(null)
            commit({ perKindSoundset: { [meta.key]: set.key } }, meta.label + '：' + set.label)
          },
        }, set.label)),
      ))

      const kindRows = kindMeta.map((meta) => h('div', { key: meta.key, style: S.kindBlock },
        rowNode({
          title: meta.label,
          desc: kindDesc(meta),
          control: h('div', { style: S.inline },
            h('button', {
              type: 'button',
              key: 'preview',
              style: S.btn(previewing === meta.key || meta.soundExists === false),
              disabled: previewing === meta.key || meta.soundExists === false,
              onClick: () => preview(meta),
            }, previewing === meta.key ? '播放中' : '试听'),
            h('button', {
              type: 'button',
              key: 'soundset',
              'aria-expanded': openPanel === meta.key ? 'true' : 'false',
              style: S.pickerBtn(openPanel === meta.key),
              onClick: () => setOpenPanel(openPanel === meta.key ? null : meta.key),
            }, (meta.soundsetPinned ? setLabelOf(meta.soundset) : '跟随全局') + ' ▾'),
            effectiveSet(meta) === 'custom'
              ? h('label', { key: 'upload', style: S.fileBtn, title: '上传 WAV（不超过 5 MB）' },
                uploading === meta.key ? '上传中' : (customSounds[meta.key] ? '重新上传' : '上传'),
                h('input', {
                  type: 'file',
                  accept: '.wav,.mp3,.m4a,.aac',
                  style: S.fileInput,
                  onChange: (e) => upload(e, meta),
                }))
              : null,
            toggleNode({
              on: kindMap[meta.key] !== false,
              label: meta.label + ' 发声',
              onChange: (v) => commit({ kinds: { [meta.key]: v } }, (v ? '已开启：' : '已关闭：') + meta.label),
            }),
          ),
        }),
        soundsetPanel(meta),
      ))

      /** 音色套选择：选中即写设置，试听按钮随即用新音色。 */
      const soundsetChips = h('div', { style: S.chipsRow }, soundsets.map((set) => {
        const on = soundset === set.key
        return h('button', {
          type: 'button',
          key: set.key,
          'aria-pressed': on ? 'true' : 'false',
          style: S.chip(on),
          onClick: () => commit({ soundset: set.key }, '音色已切到「' + set.label + '」'),
        }, set.label)
      }))

      const toastChips = h('div', { style: S.chipsRow }, kindMeta.map((meta) => {
        const on = toastKinds.includes(meta.key)
        return h('button', {
          type: 'button',
          key: meta.key,
          'aria-pressed': on ? 'true' : 'false',
          style: S.chip(on),
          onClick: () => commit(
            { toast: { kinds: on ? toastKinds.filter((k) => k !== meta.key) : [...toastKinds, meta.key] } },
            '通知事件已更新',
          ),
        }, meta.label)
      }))

      return h('div', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.title }, '提示音'),
          s.version ? h('span', { style: S.badge }, 'v' + s.version) : null,
          h('span', { style: S.status }, statusText),
        ),
        h('p', { style: S.desc },
          '回合完成、中断、出错或提问时发声，可另弹通知。改动立即生效。'),

        sectionNode('sound', '声音', settings.enabled ? '四类事件各自开关' : '总开关已关', openSound, () => setOpenSound(!openSound), [
          rowNode({
            key: 'enabled',
            title: '启用提示音',
            desc: settings.enabled
              ? '关闭后不发声也不弹通知，事件照常记录。'
              : '已关闭' + (s.enabledByPatch === false ? '（patch 初值即 false）' : '') + '。',
            control: toggleNode({
              on: settings.enabled !== false,
              label: '启用提示音',
              onChange: (v) => commit({ enabled: v }, v ? '提示音已启用' : '提示音已停用'),
            }),
          }),
          rowNode({
            key: 'soundset',
            title: '音色',
            desc: '全局默认；某类要单独配，点该行右侧的音色名。',
            control: soundsetChips,
          }),
          ...kindRows,
          rowNode({
            key: 'interval',
            title: '同类事件最小间隔',
            desc: '同一类事件在该间隔内只响一次，单位毫秒。',
            control: h('div', { style: S.inline },
              h('input', {
                style: S.input,
                inputMode: 'numeric',
                value: interval,
                'aria-label': '同类事件最小间隔（毫秒）',
                onChange: (e) => { setIntervalText(e.target.value); setIntervalDirty(true) },
              }),
              h('button', {
                type: 'button',
                style: S.btn(busy || !intervalDirty),
                disabled: busy || !intervalDirty,
                onClick: async () => {
                  const n = Number(interval)
                  if (!isFinite(n) || n < 0) { flash('间隔必须是非负数', true); return }
                  if (n > 600000) { flash('上限 600000 毫秒（10 分钟）', true); return }
                  const ok = await commit({ minIntervalMs: Math.floor(n) }, '间隔已保存')
                  if (ok) setIntervalDirty(false)
                },
              }, '保存'),
            ),
          }),
          rowNode({
            key: 'quietCurrent',
            title: '正在看的会话完成时不响',
            desc: '只对「工作完成」生效；审批、提问、出错照常响。默认关闭。',
            control: toggleNode({
              on: settings.quietCurrent === true,
              label: '正在看的会话完成时不响',
              onChange: (v) => commit({ quietCurrent: v }, v ? '正在看的会话完成时不再响' : '完成时照常响'),
            }),
          }),
          rowNode({
            key: 'subagents',
            title: '子会话也提醒',
            desc: '打开后 subagent 子会话结束也发声。',
            control: toggleNode({
              on: settings.includeSubagents === true,
              label: '子会话也提醒',
              onChange: (v) => commit({ includeSubagents: v }, v ? '子会话也会提醒' : '子会话不再提醒'),
            }),
          }),
        ]),

        sectionNode('toast', '通知', '系统 Toast，默认只对提问', openToast, () => setOpenToast(!openToast), [
          rowNode({
            key: 'toast-enabled',
            title: '启用系统通知',
            desc: '声音之外再弹系统通知，适合切到别的窗口。',
            control: toggleNode({
              on: toast.enabled === true,
              label: '启用系统通知',
              onChange: (v) => commit({ toast: { enabled: v } }, v ? '通知已启用' : '通知已关闭'),
            }),
          }),
          rowNode({
            key: 'toast-kinds',
            title: '哪些事件弹通知',
            desc: toastKinds.length === 0
              ? '当前一个都没选：不会弹任何通知。'
              : '已选 ' + toastKinds.length + ' 类；点选切换。',
            control: toastChips,
          }),
          rowNode({
            key: 'toast-title',
            title: '通知标题前缀',
            desc: '实际标题是「前缀 · 事件名」，最长 60 字符。',
            control: h('div', { style: S.inline },
              h('input', {
                style: S.inputWide,
                value: titleText,
                maxLength: 60,
                'aria-label': '通知标题前缀',
                onChange: (e) => { setTitleText(e.target.value); setTitleDirty(true) },
              }),
              h('button', {
                type: 'button',
                style: S.btn(busy || !titleDirty),
                disabled: busy || !titleDirty,
                onClick: async () => {
                  if (String(titleText).trim().length === 0) { flash('通知标题不能为空', true); return }
                  const ok = await commit({ toast: { title: String(titleText).trim() } }, '标题已保存')
                  if (ok) setTitleDirty(false)
                },
              }, '保存'),
            ),
          }),
          rowNode({
            key: 'toast-session',
            title: '正文附带会话名',
            desc: '正文后接「 · 会话标题」，多会话并行时分得清。',
            control: toggleNode({
              on: toast.includeSession === true,
              label: '正文附带会话名',
              onChange: (v) => commit({ toast: { includeSession: v } }),
            }),
          }),
        ]),

        sectionNode('advanced', '高级', '路径与调试信息', openAdvanced, () => setOpenAdvanced(!openAdvanced), [
          h('div', { style: S.panel },
            h('div', { style: S.kv },
              h('span', null, '设置文件'),
              h('span', { style: S.mono }, s.settingsFile || '~/.dsh/dsh-notify-chime.json'),
              h('span', null, '音效目录'),
              h('span', { style: S.mono }, (kindMeta[0] && kindMeta[0].sound) ? kindMeta[0].sound.replace(/[\\/][^\\/]+$/, '') : '—'),
              h('span', null, '自定义目录'),
              h('span', { style: S.mono }, s.soundsDir || '~/.dsh/dsh-notify-chime-sounds'),
              h('span', null, '轨迹文件'),
              h('span', { style: S.mono }, s.traceFile || '（未配置，patch 里设 traceFile 才写）'),
              h('span', null, '提问工具'),
              h('span', { style: S.mono }, (s.questionTools && s.questionTools.length) ? s.questionTools.join(' / ') : 'ask_user_question'),
              h('span', null, 'Toast AppID'),
              h('span', { style: S.mono }, s.toastAppId || 'com.deepseek.dsh'),
              h('span', null, 'patch 初始值'),
              h('span', { style: S.mono }, 'enabled=' + String(s.enabledByPatch) + '（改它需重启 DSH）'),
            ),
          ),
          h('div', { style: S.inline },
            h('button', {
              type: 'button',
              style: S.btn(busy),
              disabled: busy,
              onClick: async () => {
                if (!confirmReset) {
                  setConfirmReset(true)
                  flash('再点一次确认：会清掉本页所有自定义，回到 patch 初值', true)
                  return
                }
                const ok = await commit({ reset: true }, '已恢复默认设置')
                if (ok) setConfirmReset(false)
              },
            }, confirmReset ? '确认恢复默认' : '恢复默认设置'),
          ),
          h('p', { style: S.foot },
            '音效文件、播放器、Toast AppID、提问工具在 cordis.patch.yml 里，改动需重启 DSH。'),
        ]),

        msg ? h('div', { style: S.msg(msg.bad) }, msg.text) : null,
        h('p', { style: S.foot },
          '设置存 ~/.dsh/dsh-notify-chime.json，保存即生效；patch 值仅在设置文件缺该项时生效。'),
      )
    }

    function contribute (ctx, key, options, Component, what) {
      const fail = (e) => console.error(LOG, 'could not register ' + what + ':', e)
      try {
        return ctx.slots.inject(key, () => {
          try {
            return ctx.slots.register(options, Component)
          } catch (e) {
            fail(e)
            return () => {}
          }
        })
      } catch (e) {
        fail(e)
        return () => {}
      }
    }

    const inject = ['slots']

    function apply (ctx) {
      pluginCtx = ctx
      ctx.effect(() => {
        refresh()
        const timer = setInterval(() => { if (!document.hidden) refresh() }, POLL_MS)
        const onVisible = () => { if (!document.hidden) refresh() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, 'notify-sound-poll')

      ctx.effect(
        () => contribute(
          ctx,
          'settings.section',
          { name: 'settings.section', id: 'notify-sound', order: 210, label: '提示音' },
          SettingsCard,
          'settings.section',
        ),
        'notify-sound-settings-section',
      )
    }

    return { inject, apply }
  },
})
