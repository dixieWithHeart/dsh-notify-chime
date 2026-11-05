/**
 * Standalone smoke test for dsh-notify-chime.
 *
 * Runs the plugin against a fake Cordis context and synthetic session events,
 * so the event classification, debounce, and sound spawning can be verified
 * without touching the running Host.
 *
 * Usage: node tools/smoke-test.mjs [--mute]
 */

import { apply, name } from '../lib/host.js'

const mute = process.argv.includes('--mute')
const disabled = process.argv.includes('--disabled')
const traceFile = new URL('../smoke-trace.jsonl', import.meta.url).pathname.replace(/^\//, '')

const listeners = new Map()
const logs = []
const fakeCtx = {
  logger: (scope) => ({
    info: (...args) => logs.push(['info', scope, args]),
    warn: (...args) => logs.push(['warn', scope, args]),
  }),
  on(event, listener) {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return () => {}
  },
}

apply(fakeCtx, {
  player: mute ? 'none' : 'auto',
  minIntervalMs: 0,
  traceFile,
  // --disabled 验证 enabled=false 的分支：插件照常加载、照常记账，但不发声。
  enabled: !disabled,
})

const emit = (event, session = { id: 'session-test', header: {} }) => {
  for (const listener of listeners.get('session/event') ?? []) listener(session, event)
}

const turnEnd = (reason) => emit({ type: 'turn/end', data: { turn: 1, reason } })

console.log(`plugin name: ${name}`)
console.log(`listeners: ${[...listeners.keys()].join(', ')}`)

turnEnd({ kind: 'completed' })
turnEnd({ kind: 'aborted', reason: { kind: 'user' } })
turnEnd({ kind: 'aborted', reason: { kind: 'disposed' } })   // 应静音
turnEnd({ kind: 'error', error: { message: 'boom', code: 'SERVER' } })
turnEnd({ kind: 'interrupted' })
turnEnd({ kind: 'forked' })                                   // 应静音
emit({ type: 'tool/call', data: { name: 'ask_user_question' } })
emit({ type: 'tool/call', data: { name: 'read_file' } })       // 应静音
emit({ type: 'tool/call', data: { name: 'exit_plan_mode' } })
emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }, { id: 'session-sub', header: { origin: 'subagent' } }) // 应静音

// 等子进程启动，然后读回 trace 文件
await new Promise((resolve) => setTimeout(resolve, 400))

const { readFileSync } = await import('node:fs')
console.log('\n--- trace ---')
console.log(readFileSync(traceFile, 'utf8').trim())
console.log('\n--- logs ---')
for (const [level, scope, args] of logs) console.log(`${level} [${scope}] ${args.join(' ')}`)
