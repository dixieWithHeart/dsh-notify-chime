/**
 * 手动试用工具：用插件自身的代码路径播放指定音效或弹出系统通知。
 *
 *   node tools/try.mjs finished|interrupted|error|question   播放对应音效
 *   node tools/try.mjs toast                                  弹一条测试系统通知
 *   node tools/try.mjs all                                    依次播放四种音效
 */

import { apply } from '../lib/host.js'

const target = (process.argv[2] ?? 'all').toLowerCase()
const KINDS = ['finished', 'interrupted', 'error', 'question']

/** 用一个只实现 on/logger 的假上下文驱动插件，事件按 kind 直接投递。 */
const listeners = []
const fakeCtx = {
  logger: () => ({ info: (...args) => console.log('[info]', ...args), warn: (...args) => console.log('[warn]', ...args) }),
  on: (event, listener) => listeners.push(listener),
}

const eventFor = (kind) => kind === 'question'
  ? { type: 'tool/call', data: { name: 'ask_user_question' } }
  : {
      type: 'turn/end',
      data: {
        turn: 1,
        reason: kind === 'finished'
          ? { kind: 'completed' }
          : kind === 'interrupted'
            ? { kind: 'aborted', reason: { kind: 'user' } }
            : { kind: 'error', error: { code: 'SERVER', message: 'test' } },
      },
    }

if (target === 'toast') {
  apply(fakeCtx, { minIntervalMs: 0, sounds: { question: false }, toast: { enabled: true, kinds: ['question'] } })
  for (const listener of listeners) listener({ id: 'session-try', header: {} }, eventFor('question'))
  console.log('已发出系统通知（若系统未显示，检查“专注助手/勿扰模式”与通知权限）')
} else {
  const kinds = target === 'all' ? KINDS : [target]
  for (const kind of kinds) if (!KINDS.includes(kind)) {
    console.error(`unknown target: ${target}（可用：${KINDS.join(' | ')} | toast | all）`)
    process.exit(2)
  }
  apply(fakeCtx, { minIntervalMs: 0 })
  for (const kind of kinds) for (const listener of listeners) listener({ id: 'session-try', header: {} }, eventFor(kind))
  console.log(`已播放：${kinds.join(', ')}`)
}

await new Promise((resolve) => setTimeout(resolve, 2500))
