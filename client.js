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

    // 界面文案：走宿主 locale 服务（ctx.locale），随界面语言切换即时更新。
    // locale/*.json 只放插件清单的 meta，不承载界面文案——界面字典必须内联在 client 里。
    // 事件名（kind.*）与音色名（soundset.*）也用字典：宿主元数据里的 label 只有中文，仅作未知键兜底。
    const NS = 'notifyChime'
    const DICTS = {
      zh: {
        nav: '提示音',
        title: '提示音',
        desc: '回合完成、中断、出错或提问时发声，可另弹通知。改动立即生效。',
        'status.error': '连接异常：{error}',
        'status.reading': '正在读取…',
        'status.disabled': '已停用：不发声、不弹通知',
        'status.listening': '正在监听',
        'err.host': '无法连接宿主路由',
        saveFailed: '保存失败：{error}',
        stillRunning: '请确认 DSH 仍在运行',
        hostNoResponse: '宿主未响应',
        unknownError: '未知错误',
        previewing: '正在试听：{kind}',
        previewFailed: '试听失败：{error}',
        fileTooBig: '音频文件超过 5 MB',
        uploaded: '已上传：{kind}（该行改用自定义）',
        uploadFailed: '上传失败：{error}',
        soundMissing: '音效文件缺失：{path}',
        noPathConfigured: '（未配置文件路径）',
        customFile: '自定义文件：{name}',
        notUploaded: '未上传，这类仍用内置音效',
        panelTitle: '{kind} 用哪套音色',
        followGlobal: '跟随全局',
        followedGlobal: '{kind}：跟随全局（{soundset}）',
        kindPinned: '{kind}：{soundset}',
        playing: '播放中',
        preview: '试听',
        uploadTitle: '上传音频（不超过 5 MB）',
        uploading: '上传中',
        reupload: '重新上传',
        upload: '上传',
        kindToggle: '{kind} 发声',
        kindOn: '已开启：{kind}',
        kindOff: '已关闭：{kind}',
        soundsetSwitched: '音色已切到「{soundset}」',
        toastKindsUpdated: '通知事件已更新',
        'section.sound': '声音',
        'section.soundHintOn': '四类事件各自开关',
        'section.soundHintOff': '总开关已关',
        'row.enabled': '启用提示音',
        'row.enabledOn': '关闭后不发声也不弹通知，事件照常记录。',
        'row.enabledOff': '已关闭。',
        'row.enabledOffPatch': '已关闭（patch 初值即 false）。',
        chimesEnabled: '提示音已启用',
        chimesDisabled: '提示音已停用',
        'row.soundset': '音色',
        'row.soundsetDesc': '全局默认；某类要单独配，点该行右侧的音色名。',
        'row.interval': '同类事件最小间隔',
        'row.intervalDesc': '同一类事件在该间隔内只响一次，单位毫秒。',
        intervalAria: '同类事件最小间隔（毫秒）',
        intervalNegative: '间隔必须是非负数',
        intervalTooBig: '上限 600000 毫秒（10 分钟）',
        intervalSaved: '间隔已保存',
        save: '保存',
        'row.quiet': '正在看的会话完成时不响',
        'row.quietDesc': '只对「工作完成」生效；审批、提问、出错照常响。默认关闭。',
        quietOn: '正在看的会话完成时不再响',
        quietOff: '完成时照常响',
        'row.sub': '子会话也提醒',
        'row.subDesc': '打开后 subagent 子会话结束也发声。',
        subOn: '子会话也会提醒',
        subOff: '子会话不再提醒',
        'section.toast': '通知',
        'section.toastHint': '系统 Toast，默认只对提问',
        'row.toastEnabled': '启用系统通知',
        'row.toastEnabledDesc': '声音之外再弹系统通知，适合切到别的窗口。',
        toastOn: '通知已启用',
        toastOff: '通知已关闭',
        'row.toastKinds': '哪些事件弹通知',
        toastKindsNone: '当前一个都没选：不会弹任何通知。',
        toastKindsSome: '已选 {count} 类；点选切换。',
        'row.toastTitle': '通知标题前缀',
        'row.toastTitleDesc': '实际标题是「前缀 · 事件名」，最长 60 字符。',
        toastTitleAria: '通知标题前缀',
        toastTitleEmpty: '通知标题不能为空',
        toastTitleSaved: '标题已保存',
        'row.toastSession': '正文附带会话名',
        'row.toastSessionDesc': '正文后接「 · 会话标题」，多会话并行时分得清。',
        'section.advanced': '高级',
        'section.advancedHint': '路径与调试信息',
        'kv.settingsFile': '设置文件',
        'kv.soundDir': '音效目录',
        'kv.customDir': '自定义目录',
        'kv.traceFile': '轨迹文件',
        'kv.traceNone': '（未配置，patch 里设 traceFile 才写）',
        'kv.questionTools': '提问工具',
        'kv.appId': 'Toast AppID',
        'kv.patchInit': 'patch 初始值',
        'kv.patchInitValue': 'enabled={value}（改它需重启 DSH）',
        confirmHint: '再点一次确认：会清掉本页所有自定义，回到 patch 初值',
        resetConfirm: '确认恢复默认',
        reset: '恢复默认设置',
        resetDone: '已恢复默认设置',
        'foot.advanced': '音效文件、播放器、Toast AppID、提问工具在 cordis.patch.yml 里，改动需重启 DSH。',
        'foot.main': '设置存 ~/.dsh/dsh-notify-chime.json，保存即生效；patch 值仅在设置文件缺该项时生效。',
        'kind.finished': '工作完成',
        'kind.interrupted': '工作中断',
        'kind.error': '工作出错',
        'kind.question': 'Agent 提问',
        'kind.approval': '等待审批',
        'kind.plan-review': '计划评审',
        'kind.goal-blocked': '目标受阻',
        'kind.job-failed': '后台任务失败',
        'kind.finished.body': '本轮工作已结束',
        'kind.interrupted.body': '本轮工作已被中断',
        'kind.error.body': '本轮工作因错误结束',
        'kind.question.body': 'Agent 正在等待你的回答',
        'kind.approval.body': '有操作正在等你批准',
        'kind.plan-review.body': 'Agent 提交了计划，等你评审',
        'kind.goal-blocked.body': '当前目标被阻塞，需要你介入',
        'kind.job-failed.body': '一个后台任务执行失败',
        'soundset.default': '默认',
        'soundset.soft': '柔和',
        'soundset.chime': '钟声',
        'soundset.retro': '复古',
        'soundset.digital': '电子',
        'soundset.wood': '木质',
        'soundset.custom': '自定义'
      },
      en: {
        nav: 'Notification Chime',
        title: 'Notification Chime',
        desc: 'Chimes when a turn finishes, is interrupted, fails, or asks a question; can also show a toast. Changes apply immediately.',
        'status.error': 'Connection error: {error}',
        'status.reading': 'Reading…',
        'status.disabled': 'Off: no sound, no toast',
        'status.listening': 'Listening',
        'err.host': 'Cannot reach the host route',
        saveFailed: 'Save failed: {error}',
        stillRunning: 'Make sure DSH is still running',
        hostNoResponse: 'The host did not respond',
        unknownError: 'Unknown error',
        previewing: 'Previewing: {kind}',
        previewFailed: 'Preview failed: {error}',
        fileTooBig: 'Audio file exceeds 5 MB',
        uploaded: 'Uploaded: {kind} (this row now uses the custom sound)',
        uploadFailed: 'Upload failed: {error}',
        soundMissing: 'Sound file missing: {path}',
        noPathConfigured: '(no file path configured)',
        customFile: 'Custom file: {name}',
        notUploaded: 'Not uploaded; this kind still uses the built-in sound',
        panelTitle: 'Which soundset for {kind}',
        followGlobal: 'Follow global',
        followedGlobal: '{kind}: follows global ({soundset})',
        kindPinned: '{kind}: {soundset}',
        playing: 'Playing',
        preview: 'Preview',
        uploadTitle: 'Upload audio (max 5 MB)',
        uploading: 'Uploading',
        reupload: 'Replace',
        upload: 'Upload',
        kindToggle: 'Chime for {kind}',
        kindOn: 'On: {kind}',
        kindOff: 'Off: {kind}',
        soundsetSwitched: 'Soundset switched to {soundset}',
        toastKindsUpdated: 'Toast events updated',
        'section.sound': 'Sound',
        'section.soundHintOn': 'Per-event switches',
        'section.soundHintOff': 'Master switch off',
        'row.enabled': 'Enable chimes',
        'row.enabledOn': 'When off, nothing plays and no toast shows; events are still recorded.',
        'row.enabledOff': 'Off.',
        'row.enabledOffPatch': 'Off (the patch sets it to false).',
        chimesEnabled: 'Chimes enabled',
        chimesDisabled: 'Chimes disabled',
        'row.soundset': 'Soundset',
        'row.soundsetDesc': 'Global default. To configure one kind, click its soundset name on the right.',
        'row.interval': 'Minimum interval per event kind',
        'row.intervalDesc': 'The same kind chimes once within this interval, in milliseconds.',
        intervalAria: 'Minimum interval per event kind (ms)',
        intervalNegative: 'The interval must be a non-negative number',
        intervalTooBig: 'Maximum is 600000 ms (10 minutes)',
        intervalSaved: 'Interval saved',
        save: 'Save',
        'row.quiet': 'Stay silent when the session you are viewing finishes',
        'row.quietDesc': 'Applies only to turn finished; approvals, questions and errors still chime. Off by default.',
        quietOn: 'Stays silent when the viewed session finishes',
        quietOff: 'Chimes as usual on finish',
        'row.sub': 'Also chime for sub-sessions',
        'row.subDesc': 'When on, subagent sessions chime too.',
        subOn: 'Sub-sessions chime too',
        subOff: 'Sub-sessions stay silent',
        'section.toast': 'Notifications',
        'section.toastHint': 'System toast; questions only by default',
        'row.toastEnabled': 'Enable system notifications',
        'row.toastEnabledDesc': 'Shows a system notification besides the chime, for when you switch to another window.',
        toastOn: 'Notifications enabled',
        toastOff: 'Notifications disabled',
        'row.toastKinds': 'Which events show a toast',
        toastKindsNone: 'None selected: no toast will show.',
        toastKindsSome: '{count} selected; click to toggle.',
        'row.toastTitle': 'Toast title prefix',
        'row.toastTitleDesc': 'The actual title reads "prefix · event"; up to 60 characters.',
        toastTitleAria: 'Toast title prefix',
        toastTitleEmpty: 'The toast title cannot be empty',
        toastTitleSaved: 'Title saved',
        'row.toastSession': 'Include the session name in the body',
        'row.toastSessionDesc': 'Appends " · session title" so parallel sessions stay distinguishable.',
        'section.advanced': 'Advanced',
        'section.advancedHint': 'Paths and debug info',
        'kv.settingsFile': 'Settings file',
        'kv.soundDir': 'Sound directory',
        'kv.customDir': 'Custom sounds directory',
        'kv.traceFile': 'Trace file',
        'kv.traceNone': '(not configured; set traceFile in the patch to write one)',
        'kv.questionTools': 'Question tool',
        'kv.appId': 'Toast AppID',
        'kv.patchInit': 'Patch initial value',
        'kv.patchInitValue': 'enabled={value} (changing it requires a DSH restart)',
        confirmHint: 'Click again to confirm: this clears every customization on this page and restores patch defaults',
        resetConfirm: 'Confirm reset',
        reset: 'Restore defaults',
        resetDone: 'Defaults restored',
        'foot.advanced': 'Sound files, player, Toast AppID and question tools live in cordis.patch.yml; changes need a DSH restart.',
        'foot.main': 'Settings live in ~/.dsh/dsh-notify-chime.json and apply on save; patch values only apply when the settings file lacks that field.',
        'kind.finished': 'Turn finished',
        'kind.interrupted': 'Turn interrupted',
        'kind.error': 'Turn failed',
        'kind.question': 'Agent question',
        'kind.approval': 'Waiting for approval',
        'kind.plan-review': 'Plan review',
        'kind.goal-blocked': 'Goal blocked',
        'kind.job-failed': 'Job failed',
        'kind.finished.body': 'The turn has finished',
        'kind.interrupted.body': 'The turn was interrupted',
        'kind.error.body': 'The turn ended with an error',
        'kind.question.body': 'The agent is waiting for your answer',
        'kind.approval.body': 'An action needs your approval',
        'kind.plan-review.body': 'The agent submitted a plan for review',
        'kind.goal-blocked.body': 'The current goal is blocked and needs you',
        'kind.job-failed.body': 'A background job failed',
        'soundset.default': 'Default',
        'soundset.soft': 'Soft',
        'soundset.chime': 'Chime',
        'soundset.retro': 'Retro',
        'soundset.digital': 'Digital',
        'soundset.wood': 'Wood',
        'soundset.custom': 'Custom'
      }
    }

    /** 占位符替换，语义与宿主 locale 的 translate 一致（`{name}` → params.name）。 */
    function fill (template, params) {
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
    }

    // apply 前只有兜底值（内置中文）；宿主 locale 可用时替换为 bind(NS)。
    let t = (key, params) => fill(DICTS.zh[key] === undefined ? key : DICTS.zh[key], params)

    /** 字典优先、宿主元数据兜底：宿主新增的事件名/音色名不会因字典没跟上而显示成键名。 */
    function tr (key, fallback) {
      const v = t(key)
      return v === key ? fallback : v
    }
    const kindLabel = (meta) => tr('kind.' + meta.key, meta.label || meta.key)
    const kindBody = (meta) => tr('kind.' + meta.key + '.body', meta.body || '')
    const soundsetLabel = (set) => tr('soundset.' + set.key, set.label || set.key)

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
        state = { ...state, loading: false, error: (e && e.message) || t('err.host') }
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
          flash(t('saveFailed', { error: (e && e.message) || t('stillRunning') }), true)
          return false
        } finally {
          setBusy(false)
        }
      }, [])

      const preview = async (meta) => {
        setPreviewing(meta.key)
        try {
          await playPreview(meta.key)
          flash(t('previewing', { kind: kindLabel(meta) }), false)
        } catch (e) {
          flash(t('previewFailed', { error: (e && e.message) || t('hostNoResponse') }), true)
        } finally {
          setPreviewing(null)
        }
      }

      const statusText = s.error ? t('status.error', { error: s.error })
        : s.loading ? t('status.reading')
          : !settings.enabled ? t('status.disabled')
            : t('status.listening')

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
          flash(t('fileTooBig'), true)
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
          flash(t('uploaded', { kind: kindLabel(meta) }), false)
        } catch (err) {
          flash(t('uploadFailed', { error: (err && err.message) || t('unknownError') }), true)
        } finally {
          setUploading(null)
          if (input) input.value = ''
        }
      }

      const baseName = (p) => String(p || '').replace(/^.*[\\/]/, '')
      const setLabelOf = (key) => soundsetLabel({ key, label: (soundsets.find((set) => set.key === key) || {}).label })
      /** 该事件最终生效的音色套（宿主已解析好；字段缺失时用全局值兜底）。 */
      const effectiveSet = (meta) => meta.soundset || soundset

      const kindDesc = (meta) => {
        if (meta.soundExists === false) return t('soundMissing', { path: meta.sound || t('noPathConfigured') })
        if (effectiveSet(meta) === 'custom') {
          const own = customSounds[meta.key]
          return own ? t('customFile', { name: baseName(own) }) : t('notUploaded')
        }
        return kindBody(meta)
      }

      /** 每类事件的音色面板：常驻 DOM、只用 display 收起，渲染测试才覆盖得到。 */
      const soundsetPanel = (meta) => h('div', {
        key: meta.key + '-panel',
        style: openPanel === meta.key ? S.panel : { ...S.panel, display: 'none' },
      },
      h('div', { style: S.panelTitle }, t('panelTitle', { kind: kindLabel(meta) })),
      h('div', { style: S.chips },
        h('button', {
          type: 'button',
          key: 'inherit',
          'aria-pressed': meta.soundsetPinned ? 'false' : 'true',
          style: S.chip(!meta.soundsetPinned),
          onClick: () => {
            setOpenPanel(null)
            commit({ perKindSoundset: { [meta.key]: null } }, t('followedGlobal', { kind: kindLabel(meta), soundset: setLabelOf(soundset) }))
          },
        }, t('followGlobal')),
        soundsets.map((set) => h('button', {
          type: 'button',
          key: set.key,
          'aria-pressed': (meta.soundsetPinned && meta.soundset === set.key) ? 'true' : 'false',
          style: S.chip(meta.soundsetPinned && meta.soundset === set.key),
          onClick: () => {
            setOpenPanel(null)
            commit({ perKindSoundset: { [meta.key]: set.key } }, t('kindPinned', { kind: kindLabel(meta), soundset: soundsetLabel(set) }))
          },
        }, soundsetLabel(set))),
      ))

      const kindRows = kindMeta.map((meta) => h('div', { key: meta.key, style: S.kindBlock },
        rowNode({
          title: kindLabel(meta),
          desc: kindDesc(meta),
          control: h('div', { style: S.inline },
            h('button', {
              type: 'button',
              key: 'preview',
              style: S.btn(previewing === meta.key || meta.soundExists === false),
              disabled: previewing === meta.key || meta.soundExists === false,
              onClick: () => preview(meta),
            }, previewing === meta.key ? t('playing') : t('preview')),
            h('button', {
              type: 'button',
              key: 'soundset',
              'aria-expanded': openPanel === meta.key ? 'true' : 'false',
              style: S.pickerBtn(openPanel === meta.key),
              onClick: () => setOpenPanel(openPanel === meta.key ? null : meta.key),
            }, (meta.soundsetPinned ? setLabelOf(meta.soundset) : t('followGlobal')) + ' ▾'),
            effectiveSet(meta) === 'custom'
              ? h('label', { key: 'upload', style: S.fileBtn, title: t('uploadTitle') },
                uploading === meta.key ? t('uploading') : (customSounds[meta.key] ? t('reupload') : t('upload')),
                h('input', {
                  type: 'file',
                  accept: '.wav,.mp3,.m4a,.aac',
                  style: S.fileInput,
                  onChange: (e) => upload(e, meta),
                }))
              : null,
            toggleNode({
              on: kindMap[meta.key] !== false,
              label: t('kindToggle', { kind: kindLabel(meta) }),
              onChange: (v) => commit({ kinds: { [meta.key]: v } }, t(v ? 'kindOn' : 'kindOff', { kind: kindLabel(meta) })),
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
          onClick: () => commit({ soundset: set.key }, t('soundsetSwitched', { soundset: soundsetLabel(set) })),
        }, soundsetLabel(set))
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
            t('toastKindsUpdated'),
          ),
        }, kindLabel(meta))
      }))

      return h('div', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.title }, t('title')),
          s.version ? h('span', { style: S.badge }, 'v' + s.version) : null,
          h('span', { style: S.status }, statusText),
        ),
        h('p', { style: S.desc }, t('desc')),

        sectionNode('sound', t('section.sound'), settings.enabled ? t('section.soundHintOn') : t('section.soundHintOff'), openSound, () => setOpenSound(!openSound), [
          rowNode({
            key: 'enabled',
            title: t('row.enabled'),
            desc: settings.enabled
              ? t('row.enabledOn')
              : t(s.enabledByPatch === false ? 'row.enabledOffPatch' : 'row.enabledOff'),
            control: toggleNode({
              on: settings.enabled !== false,
              label: t('row.enabled'),
              onChange: (v) => commit({ enabled: v }, v ? t('chimesEnabled') : t('chimesDisabled')),
            }),
          }),
          rowNode({
            key: 'soundset',
            title: t('row.soundset'),
            desc: t('row.soundsetDesc'),
            control: soundsetChips,
          }),
          ...kindRows,
          rowNode({
            key: 'interval',
            title: t('row.interval'),
            desc: t('row.intervalDesc'),
            control: h('div', { style: S.inline },
              h('input', {
                style: S.input,
                inputMode: 'numeric',
                value: interval,
                'aria-label': t('intervalAria'),
                onChange: (e) => { setIntervalText(e.target.value); setIntervalDirty(true) },
              }),
              h('button', {
                type: 'button',
                style: S.btn(busy || !intervalDirty),
                disabled: busy || !intervalDirty,
                onClick: async () => {
                  const n = Number(interval)
                  if (!isFinite(n) || n < 0) { flash(t('intervalNegative'), true); return }
                  if (n > 600000) { flash(t('intervalTooBig'), true); return }
                  const ok = await commit({ minIntervalMs: Math.floor(n) }, t('intervalSaved'))
                  if (ok) setIntervalDirty(false)
                },
              }, t('save')),
            ),
          }),
          rowNode({
            key: 'quietCurrent',
            title: t('row.quiet'),
            desc: t('row.quietDesc'),
            control: toggleNode({
              on: settings.quietCurrent === true,
              label: t('row.quiet'),
              onChange: (v) => commit({ quietCurrent: v }, v ? t('quietOn') : t('quietOff')),
            }),
          }),
          rowNode({
            key: 'subagents',
            title: t('row.sub'),
            desc: t('row.subDesc'),
            control: toggleNode({
              on: settings.includeSubagents === true,
              label: t('row.sub'),
              onChange: (v) => commit({ includeSubagents: v }, v ? t('subOn') : t('subOff')),
            }),
          }),
        ]),

        sectionNode('toast', t('section.toast'), t('section.toastHint'), openToast, () => setOpenToast(!openToast), [
          rowNode({
            key: 'toast-enabled',
            title: t('row.toastEnabled'),
            desc: t('row.toastEnabledDesc'),
            control: toggleNode({
              on: toast.enabled === true,
              label: t('row.toastEnabled'),
              onChange: (v) => commit({ toast: { enabled: v } }, v ? t('toastOn') : t('toastOff')),
            }),
          }),
          rowNode({
            key: 'toast-kinds',
            title: t('row.toastKinds'),
            desc: toastKinds.length === 0
              ? t('toastKindsNone')
              : t('toastKindsSome', { count: toastKinds.length }),
            control: toastChips,
          }),
          rowNode({
            key: 'toast-title',
            title: t('row.toastTitle'),
            desc: t('row.toastTitleDesc'),
            control: h('div', { style: S.inline },
              h('input', {
                style: S.inputWide,
                value: titleText,
                maxLength: 60,
                'aria-label': t('toastTitleAria'),
                onChange: (e) => { setTitleText(e.target.value); setTitleDirty(true) },
              }),
              h('button', {
                type: 'button',
                style: S.btn(busy || !titleDirty),
                disabled: busy || !titleDirty,
                onClick: async () => {
                  if (String(titleText).trim().length === 0) { flash(t('toastTitleEmpty'), true); return }
                  const ok = await commit({ toast: { title: String(titleText).trim() } }, t('toastTitleSaved'))
                  if (ok) setTitleDirty(false)
                },
              }, t('save')),
            ),
          }),
          rowNode({
            key: 'toast-session',
            title: t('row.toastSession'),
            desc: t('row.toastSessionDesc'),
            control: toggleNode({
              on: toast.includeSession === true,
              label: t('row.toastSession'),
              onChange: (v) => commit({ toast: { includeSession: v } }),
            }),
          }),
        ]),

        sectionNode('advanced', t('section.advanced'), t('section.advancedHint'), openAdvanced, () => setOpenAdvanced(!openAdvanced), [
          h('div', { style: S.panel },
            h('div', { style: S.kv },
              h('span', null, t('kv.settingsFile')),
              h('span', { style: S.mono }, s.settingsFile || '~/.dsh/dsh-notify-chime.json'),
              h('span', null, t('kv.soundDir')),
              h('span', { style: S.mono }, (kindMeta[0] && kindMeta[0].sound) ? kindMeta[0].sound.replace(/[\\/][^\\/]+$/, '') : '—'),
              h('span', null, t('kv.customDir')),
              h('span', { style: S.mono }, s.soundsDir || '~/.dsh/dsh-notify-chime-sounds'),
              h('span', null, t('kv.traceFile')),
              h('span', { style: S.mono }, s.traceFile || t('kv.traceNone')),
              h('span', null, t('kv.questionTools')),
              h('span', { style: S.mono }, (s.questionTools && s.questionTools.length) ? s.questionTools.join(' / ') : 'ask_user_question'),
              h('span', null, t('kv.appId')),
              h('span', { style: S.mono }, s.toastAppId || 'com.deepseek.dsh'),
              h('span', null, t('kv.patchInit')),
              h('span', { style: S.mono }, t('kv.patchInitValue', { value: String(s.enabledByPatch) })),
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
                  flash(t('confirmHint'), true)
                  return
                }
                const ok = await commit({ reset: true }, t('resetDone'))
                if (ok) setConfirmReset(false)
              },
            }, confirmReset ? t('resetConfirm') : t('reset')),
          ),
          h('p', { style: S.foot }, t('foot.advanced')),
        ]),

        msg ? h('div', { style: S.msg(msg.bad) }, msg.text) : null,
        h('p', { style: S.foot }, t('foot.main')),
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

    const inject = ['slots', 'locale']

    function apply (ctx) {
      pluginCtx = ctx
      // 界面文案接入宿主 locale：注册字典后 t 指向 bind(NS)，切换语言即时生效。
      // 精简组合或测试替身可能没有 locale 服务——判存在后退回内置中文，不让整块 UI 崩掉。
      if (ctx.locale && typeof ctx.locale.register === 'function' && typeof ctx.locale.bind === 'function') {
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'notify-chime-dicts')
        t = ctx.locale.bind(NS)
      } else {
        console.warn(LOG, 'locale 服务不可用：界面文案固定中文')
      }

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
          { name: 'settings.section', id: 'notify-sound', order: 210, locale: NS, label: () => t('nav') },
          SettingsCard,
          'settings.section',
        ),
        'notify-sound-settings-section',
      )
    }

    return { inject, apply }
  },
})
