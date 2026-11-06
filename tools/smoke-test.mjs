/**
 * dsh-notify-chime 宿主侧契约冒烟测试。
 *
 * 在临时 DSH_HOME 里跑：不碰真实设置文件、不真的播放声音（player: none）、不弹通知
 * （通知事件种类设成空数组）。覆盖：
 *   1. 旧版设置字段迁移（muted → enabled: false、toastEnabled → toast.enabled）
 *   2. 三种跳过原因：disabled（总开关）、kind-disabled（事件级）、debounce（去抖）
 *   3. /state、/set（含非法值）、/preview、reset 的响应契约
 *
 * 用法：node tools/smoke-test.mjs [--verbose]
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../lib/host.js'

const VERBOSE = process.argv.includes('--verbose')
const results = []
const check = (label, pass, detail) => results.push({ label, pass: Boolean(pass), detail: detail || '' })

// 隔离：设置文件与轨迹都落在临时目录
const home = mkdtempSync(join(tmpdir(), 'chime-smoke-'))
process.env.DSH_HOME = home
const settingsFile = join(home, 'dsh-notify-chime.json')
const traceFile = join(home, 'trace.jsonl')
writeFileSync(traceFile, '')

/** 旧版设置文件：1.1.x 的平铺字段，故意带 BOM（模拟记事本保存过的文件） */
writeFileSync(settingsFile, '\uFEFF' + JSON.stringify({
  muted: true,
  minIntervalMs: 0,
  includeSubagents: false,
  toastEnabled: false,
}))

const listeners = new Map()
const routes = new Map()
const logs = []
const fakeCtx = {
  logger: (scope) => ({
    info: () => {},
    warn: (...args) => logs.push(['warn', scope, args]),
  }),
  on (event, listener) {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return () => {}
  },
  inject (_services, cb) {
    cb({
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      webServer: {
        register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
      },
    })
  },
}

apply(fakeCtx, {
  player: 'none',
  minIntervalMs: 0,
  traceFile,
  toast: { enabled: true, kinds: [] },
})

const emit = (event, session = { id: 'session-test', header: {} }) => {
  for (const listener of listeners.get('session/event') ?? []) listener(session, event)
}
const turnEnd = (reason) => emit({ type: 'turn/end', data: { turn: 1, reason } })
const readTrace = () => readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
const clearTrace = () => writeFileSync(traceFile, '')

/** 调一个宿主路由，返回 { status, body }。payload 可以是对象或 Buffer，headers 模拟请求头。 */
const call = async (path, method = 'GET', payload, headers = {}) => {
  const handler = routes.get(path)
  if (!handler) throw new Error(`路由未注册：${path}`)
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator] () {
      if (payload === undefined) return
      yield Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))
    },
  }
  const res = {
    statusCode: 0,
    payload: '',
    writeHead (status) { this.statusCode = status },
    end (text) { this.payload = text ?? '' },
  }
  await handler(req, res)
  let body = null
  try { body = JSON.parse(res.payload) } catch { body = res.payload }
  return { status: res.statusCode, body }
}

// ── 1. 迁移与初始状态 ────────────────────────────────────────────────────
check('导出了 loader name', name === 'notify-sound', String(name))
check('注册了四条路由', routes.size === 4, [...routes.keys()].join(', '))

const startup = readTrace().find((entry) => entry.kind === 'startup')
check('startup 轨迹写入 effective', Boolean(startup && startup.effective))
check('旧 muted:true 迁移成 enabled:false（带 BOM 也能读）', startup?.effective?.enabled === false, String(startup?.effective?.enabled))
check('旧 toastEnabled:false 迁移成 toast.enabled:false', startup?.effective?.toast?.enabled === false, String(startup?.effective?.toast?.enabled))
check('事件级开关默认全开', startup?.effective?.kinds?.finished === true, JSON.stringify(startup?.effective?.kinds))

// ── 2. 总开关：disabled ─────────────────────────────────────────────────
clearTrace()
turnEnd({ kind: 'completed' })
const disabledRun = readTrace()
check('总开关关闭时记录 disabled', disabledRun.some((e) => e.kind === 'finished' && e.skipped === 'disabled'), JSON.stringify(disabledRun))

// ── 3. /set 打开总开关 + 关掉 finished ───────────────────────────────────
const opened = await call('/api/dsh-notify-chime/set', 'POST', { enabled: true, kinds: { finished: false } })
check('/set 返回 200', opened.status === 200, JSON.stringify(opened.body))
check('/set 后 enabled=true', opened.body?.settings?.enabled === true, JSON.stringify(opened.body?.settings))
check('/set 后 kinds.finished=false', opened.body?.settings?.kinds?.finished === false, JSON.stringify(opened.body?.settings?.kinds))
check('设置已落盘', JSON.parse(readFileSync(settingsFile, 'utf8')).kinds?.finished === false, readFileSync(settingsFile, 'utf8').slice(0, 200))

clearTrace()
turnEnd({ kind: 'completed' })
const kindOffRun = readTrace()
check('事件级关闭时记录 kind-disabled', kindOffRun.some((e) => e.kind === 'finished' && e.skipped === 'kind-disabled'), JSON.stringify(kindOffRun))

// ── 4. 打开的事件照常触发（player: none，所以 sound 为 null）─────────────
clearTrace()
turnEnd({ kind: 'error' })
const firedRun = readTrace()
const fired = firedRun.find((e) => e.kind === 'error')
check('开启的事件照常记录', Boolean(fired) && fired.skipped === undefined, JSON.stringify(fired))
check('toast.kinds 为空时不弹通知', fired?.toast === false, String(fired?.toast))

// ── 5. 去抖 ────────────────────────────────────────────────────────────
// 用还没触发过的 interrupted：error 在上一步刚响过，去抖窗口会把它一起压住。
await call('/api/dsh-notify-chime/set', 'POST', { minIntervalMs: 5000 })
clearTrace()
turnEnd({ kind: 'interrupted' })
turnEnd({ kind: 'interrupted' })
const debounceRun = readTrace().filter((e) => e.kind === 'interrupted')
check('第一次照常触发', debounceRun.filter((e) => e.skipped === undefined).length === 1, JSON.stringify(debounceRun))
check('第二次同类事件被去抖', debounceRun.filter((e) => e.skipped === 'debounce').length === 1, JSON.stringify(debounceRun))
await call('/api/dsh-notify-chime/set', 'POST', { minIntervalMs: 0 })

// ── 6. /state 契约 ─────────────────────────────────────────────────────
const stateRes = await call('/api/dsh-notify-chime/state')
check('/state 返回 200', stateRes.status === 200, String(stateRes.status))
check('/state 带 version', typeof stateRes.body?.version === 'string', String(stateRes.body?.version))
check('/state 带四类事件元数据', Array.isArray(stateRes.body?.kinds) && stateRes.body.kinds.length === 4, JSON.stringify(stateRes.body?.kinds?.map((k) => k.key)))
check('/state 带设置文件路径', typeof stateRes.body?.settingsFile === 'string' && stateRes.body.settingsFile.endsWith('dsh-notify-chime.json'), String(stateRes.body?.settingsFile))
check('/state 的 settings 无旧字段', stateRes.body?.settings?.muted === undefined && stateRes.body?.settings?.toastEnabled === undefined, JSON.stringify(stateRes.body?.settings))

// ── 7. /set 非法值 ─────────────────────────────────────────────────────
const unknownKey = await call('/api/dsh-notify-chime/set', 'POST', { nope: 1 })
check('未知设置项返回 400', unknownKey.status === 400, JSON.stringify(unknownKey.body))
const badInterval = await call('/api/dsh-notify-chime/set', 'POST', { minIntervalMs: -1 })
check('负间隔返回 400', badInterval.status === 400, JSON.stringify(badInterval.body))
const badKind = await call('/api/dsh-notify-chime/set', 'POST', { kinds: { nope: true } })
check('未知事件种类返回 400', badKind.status === 400, JSON.stringify(badKind.body))
const badTitle = await call('/api/dsh-notify-chime/set', 'POST', { toast: { title: '   ' } })
check('空标题返回 400', badTitle.status === 400, JSON.stringify(badTitle.body))
const badJson = await call('/api/dsh-notify-chime/set', 'POST', 'not-an-object')
check('非对象请求体返回 400', badJson.status === 400, JSON.stringify(badJson.body))

// ── 8. /preview ────────────────────────────────────────────────────────
const previewNone = await call('/api/dsh-notify-chime/preview', 'POST', { kind: 'finished' })
check('player:none 时试听返回 ok:false', previewNone.status === 200 && previewNone.body?.ok === false, JSON.stringify(previewNone.body))
const previewBad = await call('/api/dsh-notify-chime/preview', 'POST', { kind: 'nope' })
check('未知种类试听返回 400', previewBad.status === 400, JSON.stringify(previewBad.body))

// ── 9. reset ───────────────────────────────────────────────────────────
await call('/api/dsh-notify-chime/set', 'POST', { enabled: false, kinds: { error: false }, toast: { title: '自定义' } })
const reset = await call('/api/dsh-notify-chime/set', 'POST', { reset: true })
check('reset 回到 patch 初值：enabled', reset.body?.settings?.enabled === true, JSON.stringify(reset.body?.settings?.enabled))
check('reset 回到 patch 初值：kinds 全开', reset.body?.settings?.kinds?.error === true, JSON.stringify(reset.body?.settings?.kinds))
check('reset 回到 patch 初值：title', reset.body?.settings?.toast?.title === 'DeepSeek Harness', String(reset.body?.settings?.toast?.title))

// ── 10. 音色套 ─────────────────────────────────────────────────────────
const presetState = await call('/api/dsh-notify-chime/state')
check('/state 带 7 个音色套', Array.isArray(presetState.body?.soundsets) && presetState.body.soundsets.length === 7,
  JSON.stringify(presetState.body?.soundsets?.map((set) => set.key)))
check('默认音色套是 default', presetState.body?.settings?.soundset === 'default', String(presetState.body?.settings?.soundset))

const switched = await call('/api/dsh-notify-chime/set', 'POST', { soundset: 'chime' })
check('/set soundset 生效', switched.body?.settings?.soundset === 'chime', String(switched.body?.settings?.soundset))
const chimeState = await call('/api/dsh-notify-chime/state')
const chimeFinished = (chimeState.body?.kinds || []).find((k) => k.key === 'finished')
check('chime 套解析到 chime 目录', typeof chimeFinished?.sound === 'string' && chimeFinished.sound.includes('chime'),
  String(chimeFinished?.sound))
check('chime 套文件确实存在', chimeFinished?.soundExists === true, String(chimeFinished?.soundExists))

const badSet = await call('/api/dsh-notify-chime/set', 'POST', { soundset: 'nope' })
check('未知音色套返回 400', badSet.status === 400, JSON.stringify(badSet.body))

// ── 10.1 事件级音色（perKindSoundset）────────────────────────────────────
const pinned = await call('/api/dsh-notify-chime/set', 'POST', { perKindSoundset: { finished: 'wood' } })
check('perKindSoundset 写入成功', pinned.body?.settings?.perKindSoundset?.finished === 'wood',
  JSON.stringify(pinned.body?.settings?.perKindSoundset))
const pinnedState = await call('/api/dsh-notify-chime/state')
const finishedMeta = (pinnedState.body?.kinds || []).find((k) => k.key === 'finished')
const errorMeta = (pinnedState.body?.kinds || []).find((k) => k.key === 'error')
check('finished 生效套是 wood', finishedMeta?.soundset === 'wood', String(finishedMeta?.soundset))
check('finished 解析到 wood 目录', typeof finishedMeta?.sound === 'string' && finishedMeta.sound.includes('wood'),
  String(finishedMeta?.sound))
check('finished 标记为单独指定', finishedMeta?.soundsetPinned === true, String(finishedMeta?.soundsetPinned))
check('error 仍跟随全局 chime', errorMeta?.soundset === 'chime' && errorMeta.soundsetPinned === false,
  `${errorMeta?.soundset}/${errorMeta?.soundsetPinned}`)

const cleared = await call('/api/dsh-notify-chime/set', 'POST', { perKindSoundset: { finished: null } })
check('null 恢复跟随全局', cleared.body?.settings?.perKindSoundset?.finished === null,
  String(cleared.body?.settings?.perKindSoundset?.finished))
const badPinned = await call('/api/dsh-notify-chime/set', 'POST', { perKindSoundset: { finished: 'nope' } })
check('事件级未知套名返回 400', badPinned.status === 400, JSON.stringify(badPinned.body))

// ── 11. 自定义音效上传 ─────────────────────────────────────────────────
const wavBytes = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'),
  Buffer.from('fmt '), Buffer.alloc(16), Buffer.from('data'), Buffer.alloc(4), Buffer.alloc(64),
])
const badUpload = await call('/api/dsh-notify-chime/sound', 'POST', Buffer.from('not-a-wav'), { 'x-chime-kind': 'finished' })
check('非 WAV 上传返回 400', badUpload.status === 400, JSON.stringify(badUpload.body))
const badKindUpload = await call('/api/dsh-notify-chime/sound', 'POST', wavBytes, { 'x-chime-kind': 'nope' })
check('未知种类上传返回 400', badKindUpload.status === 400, JSON.stringify(badKindUpload.body))

const uploaded = await call('/api/dsh-notify-chime/sound', 'POST', wavBytes, { 'x-chime-kind': 'finished' })
check('WAV 上传返回 200', uploaded.status === 200, JSON.stringify(uploaded.body))
check('上传后该事件切到 custom', uploaded.body?.settings?.perKindSoundset?.finished === 'custom',
  String(uploaded.body?.settings?.perKindSoundset?.finished))
check('上传不动全局音色', uploaded.body?.settings?.soundset === 'chime', String(uploaded.body?.settings?.soundset))
const expectedPath = join(home, 'dsh-notify-chime-sounds', 'finished.wav')
check('自定义文件落到固定路径', uploaded.body?.settings?.customSounds?.finished === expectedPath,
  String(uploaded.body?.settings?.customSounds?.finished))
check('自定义文件已写盘且字节一致', existsSync(expectedPath) && readFileSync(expectedPath).length === wavBytes.length,
  `exists=${existsSync(expectedPath)}`)

const customState = await call('/api/dsh-notify-chime/state')
const customFinished = (customState.body?.kinds || []).find((k) => k.key === 'finished')
check('custom 套解析到上传的文件', customFinished?.sound === expectedPath, String(customFinished?.sound))
const customOther = (customState.body?.kinds || []).find((k) => k.key === 'error')
check('未上传的事件回退内置音效',
  typeof customOther?.sound === 'string' && !customOther.sound.includes('dsh-notify-chime-sounds'),
  String(customOther?.sound))

// ── 12. patch 层 fail-loud 校验 ────────────────────────────────────────
const expectThrow = (label, config) => {
  let threw = null
  try { apply(fakeCtx, config) } catch (error) { threw = error }
  check(label, threw !== null, threw ? threw.message : '未抛错')
}
expectThrow('patch 非法 soundset 报错', { player: 'none', soundset: 'nope' })
expectThrow('patch 未知字段报错', { player: 'none', nope: 1 })
expectThrow('patch 非法 kinds 键报错', { player: 'none', kinds: { nope: true } })

// ── 收尾 ───────────────────────────────────────────────────────────────
rmSync(home, { recursive: true, force: true })

if (VERBOSE) {
  console.log('--- logs ---')
  for (const [level, scope, args] of logs) console.log(`${level} [${scope}] ${args.join(' ')}`)
}

const failed = results.filter((r) => !r.pass)
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}${r.pass ? '' : '  -> ' + r.detail}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
