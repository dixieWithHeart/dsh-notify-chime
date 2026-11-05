// dsh-notify-chime — 浏览器半 / browser half
//
// 注册一个设置页（settings.section）：静音开关、最小间隔、子会话提醒、提问弹通知。
// 所有写入走宿主路由 /api/dsh-notify-chime/*，改完立即生效（不需要重启）。
//
// 契约：
//   window.__ModuleLoader__.load({ id, factory(require) }) —— id 必须是包名
//   不 require 任何 @deepseek-ai/dsh-client-* 包；React 从 browser module table 取
//   样式只用 --dsw-alias-* 主题 token，且都带 fallback

window.__ModuleLoader__.load({
  id: 'dsh-notify-chime',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/api/dsh-notify-chime'
    const POLL_MS = 3000
    const LOG = '[dsh-notify-chime]'

    let state = {
      loading: true,
      error: null,
      version: '',
      enabledByPatch: true,
      settings: { muted: false, minIntervalMs: 700, includeSubagents: false, toastEnabled: true },
      traceFile: null,
      sounds: {},
      questionTools: [],
    }
    const listeners = new Set()
    const emit = () => { for (const fn of listeners) fn(state) }

    async function refresh () {
      try {
        const r = await fetch(API + '/state', { headers: { accept: 'application/json' } })
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
      state = { ...state, settings: j.settings, error: null }
      emit()
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
      panel: { background: C.surface, borderRadius: C.radiusSm, padding: '12px 14px', display: 'grid', gap: '8px' },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: '12px', color: C.dim },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', wordBreak: 'break-all' },
      row: { display: 'flex', alignItems: 'flex-start', gap: '12px', paddingTop: '4px' },
      rowText: { display: 'grid', gap: '2px', flex: 1, minWidth: 0 },
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
      input: {
        width: '110px', padding: '5px 8px', fontSize: '13px', textAlign: 'right',
        border: '1px solid ' + C.border, borderRadius: C.radiusSm, background: 'transparent', color: C.text,
      },
      btn: (disabled) => ({
        padding: '5px 12px', fontSize: '13px', borderRadius: C.radiusSm,
        border: '1px solid ' + C.border, background: 'transparent', color: C.text,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
      }),
      msg: (bad) => ({ fontSize: '12px', color: bad ? 'var(--dsw-alias-danger, #e5534b)' : C.dim }),
      foot: { fontSize: '12px', color: C.dim, lineHeight: 1.6, margin: 0 },
    }

    function Toggle ({ on, onChange, label }) {
      return h('button', {
        type: 'button',
        'aria-label': label,
        'aria-pressed': on ? 'true' : 'false',
        style: S.toggle(on),
        onClick: () => onChange(!on),
      }, h('span', { style: S.knob(on) }))
    }

    function Row ({ title, desc, control }) {
      return h('div', { style: S.row },
        h('div', { style: S.rowText },
          h('div', { style: S.rowTitle }, title),
          desc ? h('div', { style: S.rowDesc }, desc) : null,
        ),
        control,
      )
    }

    function SettingsCard () {
      const s = useStore()
      const [busy, setBusy] = useState(false)
      const [interval, setIntervalText] = useState(String(s.settings.minIntervalMs))
      const [dirty, setDirty] = useState(false)
      const [msg, setMsg] = useState(null)
      const serverInterval = useRef(s.settings.minIntervalMs)

      useEffect(() => {
        if (s.settings.minIntervalMs !== serverInterval.current) {
          serverInterval.current = s.settings.minIntervalMs
          if (!dirty) setIntervalText(String(s.settings.minIntervalMs))
        }
      }, [s.settings.minIntervalMs, dirty])

      const flash = (text, bad) => {
        setMsg({ text, bad })
        window.setTimeout(() => setMsg(null), 2600)
      }

      const apply = useCallback(async (patch, okText) => {
        setBusy(true)
        try {
          await save(patch)
          if (okText) flash(okText, false)
        } catch (e) {
          flash('保存失败：' + ((e && e.message) || '请确认 DSH 仍在运行'), true)
        } finally {
          setBusy(false)
        }
      }, [])

      const statusText = s.error ? ('连接异常：' + s.error)
        : s.loading ? '正在读取…'
          : !s.enabledByPatch ? '总开关已关闭：不发声（改 bundle patch 的 enabled 后重新加载生效）'
            : s.settings.muted ? '已静音：事件仍记录，但不发声'
              : '正在监听'

      return h('div', { style: S.card },
        h('div', { style: S.head },
          h('h3', { style: S.title }, '提示音'),
          s.version ? h('span', { style: S.badge }, 'v' + s.version) : null,
          h('span', { style: S.status }, statusText),
        ),
        h('p', { style: S.desc },
          '在回合完成、被中断、出错，或 Agent 提问时发声。下面的改动立即生效，不需要重启。'),

        h(Row, {
          title: '静音',
          desc: '打开后不再播放声音与通知，触发记录照常写入轨迹文件。适合临时不想被打扰时用。',
          control: h(Toggle, {
            on: s.settings.muted,
            label: '静音',
            onChange: (v) => apply({ muted: v }, v ? '已静音' : '已取消静音'),
          }),
        }),
        h(Row, {
          title: '子会话也提醒',
          desc: '默认只在你自己的会话提醒；打开后 subagent 子会话结束也会发声。',
          control: h(Toggle, {
            on: s.settings.includeSubagents,
            label: '子会话也提醒',
            onChange: (v) => apply({ includeSubagents: v }),
          }),
        }),
        h(Row, {
          title: 'Agent 提问时弹系统通知',
          desc: '声音之外再弹一个 Windows 通知，提醒你回来回答。触发工具：'
            + (s.questionTools && s.questionTools.length ? s.questionTools.join(' / ') : 'ask_user_question'),
          control: h(Toggle, {
            on: s.settings.toastEnabled,
            label: 'Agent 提问时弹系统通知',
            onChange: (v) => apply({ toastEnabled: v }),
          }),
        }),
        h(Row, {
          title: '同类事件最小间隔',
          desc: '去抖：同一类事件在这个间隔内只响一次，单位毫秒。',
          control: h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('input', {
              style: S.input,
              inputMode: 'numeric',
              value: interval,
              'aria-label': '同类事件最小间隔（毫秒）',
              onChange: (e) => { setIntervalText(e.target.value); setDirty(true) },
            }),
            h('button', {
              type: 'button',
              style: S.btn(busy || !dirty),
              disabled: busy || !dirty,
              onClick: async () => {
                const n = Number(interval)
                if (!isFinite(n) || n < 0) { flash('间隔必须是非负数', true); return }
                if (n > 600000) { flash('上限 10 分钟（600000 毫秒）：再大会让提示音事实上再也响不了', true); return }
                await apply({ minIntervalMs: Math.floor(n) }, '已保存')
                setDirty(false)
              },
            }, '保存'),
          ),
        }),

        h('div', { style: S.panel },
          h('div', { style: S.kv },
            h('span', null, '轨迹文件'),
            h('span', { style: S.mono }, s.traceFile || '（未配置）'),
            h('span', null, '音效目录'),
            h('span', { style: S.mono }, (s.sounds && s.sounds.finished) ? s.sounds.finished.replace(/[\\/][^\\/]+$/, '') : '—'),
          ),
        ),

        msg ? h('div', { style: S.msg(msg.bad) }, msg.text) : null,
        h('p', { style: S.foot },
          '总开关在 bundle 的 cordis.patch.yml 里（enabled），改它需要重启 DSH；'
          + '本页的开关保存在 ~/.dsh/dsh-notify-chime.json，立即生效。'),
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
