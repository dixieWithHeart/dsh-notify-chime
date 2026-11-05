/**
 * dsh-notify-chime — DSH 主机侧「提示音 / 系统通知」插件
 *
 * 监听主机事件，在三种用户真正需要回来看一眼的时刻发出明显音效：
 *   1. finished    工作正常结束（回合完成，模型不再需要动作）
 *   2. interrupted 工作中断（用户点击停止、会话被归档、回合被取消）
 *   3. error       出错结束（模型请求失败并终止回合）
 *   4. question    Agent 用提问工具征求用户输入（ask_user_question / exit_plan_mode）
 *
 * 设计要点：
 *   - 只依赖 node: 内置模块，不 import 任何 @deepseek-ai/* 包，
 *     因此可以直接放在宿主文件系统的任意目录，用 profile patch 的绝对路径插入。
 *   - 事件来源是两个「广播型（emit）」事件，不参与 waterfall 争抢，
 *     不会被内置监听器抢先 claim 而漏掉：
 *       · session/event  → turn/end（回合结束）与 tool/call（提问工具调用）
 *       · 会话过滤：默认忽略 subagent 会话，避免子代理刷屏
 *   - 声音由独立子进程播放（Windows: PowerShell + System.Media.SoundPlayer），
 *     不阻塞宿主事件循环；进程 windowsHide，不会闪黑框。
 *   - 可选：Windows 系统通知（Toast），默认关闭。
 *
 * @module dsh-notify-chime
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 设置页写入的用户设置，覆盖 patch 里的对应项。 */
const SETTINGS_FILENAME = 'dsh-notify-chime.json'
const VERSION = '1.1.1'
/** 去抖间隔上限：填成天文数字会让提示音事实上永久失效，这里兜住。 */
const MAX_MIN_INTERVAL_MS = 600000

function settingsPath () {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, SETTINGS_FILENAME)
}

function loadUserSettings (logger) {
  try {
    const file = settingsPath()
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch (error) {
    logger.warn(`settings load failed: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function saveUserSettings (logger, patch, current) {
  const next = { ...current }
  if (typeof patch.muted === 'boolean') next.muted = patch.muted
  if (typeof patch.includeSubagents === 'boolean') next.includeSubagents = patch.includeSubagents
  if (typeof patch.toastEnabled === 'boolean') next.toastEnabled = patch.toastEnabled
  if (typeof patch.minIntervalMs === 'number' && Number.isFinite(patch.minIntervalMs)) {
    next.minIntervalMs = Math.min(MAX_MIN_INTERVAL_MS, Math.max(0, Math.floor(patch.minIntervalMs)))
  }
  try {
    const file = settingsPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2))
    return { ok: true, settings: next }
  } catch (error) {
    logger.warn(`settings save failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: error instanceof Error ? error.message : String(error), settings: current }
  }
}

/** Loader identity for this plugin entry. */
export const name = 'notify-sound'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = resolve(HERE, '..', 'assets')

/** 事件种类 → 默认音效文件、默认通知文案。 */
const KINDS = {
  finished: { asset: 'finished.wav', label: '工作完成', body: '本轮工作已结束' },
  interrupted: { asset: 'interrupted.wav', label: '工作中断', body: '本轮工作已被中断' },
  error: { asset: 'error.wav', label: '工作出错', body: '本轮工作因错误结束' },
  question: { asset: 'question.wav', label: 'Agent 提问', body: 'Agent 正在等待你的回答' },
}

/** 默认配置（config 中未给出的字段取这里的值）。 */
const DEFAULTS = {
  enabled: true,
  /** 同一类事件的最小触发间隔（毫秒），用于去抖。 */
  minIntervalMs: 700,
  /** 是否也为 subagent / 子会话发声。 */
  includeSubagents: false,
  /** 声音播放器：'auto' | 'powershell' | 'pwsh' | 'none'，或播放器可执行文件的绝对路径。 */
  player: 'auto',
  /** Toast 系统通知（默认关闭；仅 Windows/macOS/Linux 桌面环境有效）。 */
  toast: {
    enabled: false,
    /** 需要同时弹通知的事件种类；缺省为全部。 */
    kinds: null,
    /** 通知标题前缀。 */
    title: 'DeepSeek Harness',
    /** 通知正文是否带会话标题。 */
    includeSession: true,
    /**
     * Windows 通知来源的 AppUserModelID。
     * 必须是「系统里已注册」的 ID（开始菜单有同名快捷方式），否则 Windows 只会把通知
     * 记进通知中心、不弹横幅。DSH 桌面版注册的是 com.deepseek.dsh；
     * 若是绿色版/自编译版，改成你自己的 AppID（可在注册表
     * HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings 下确认）。
     */
    appId: 'com.deepseek.dsh',
  },
  /** 每个事件种类的声音文件；null / false 表示该类事件不发声。 */
  sounds: {
    finished: join(ASSET_DIR, 'finished.wav'),
    interrupted: join(ASSET_DIR, 'interrupted.wav'),
    error: join(ASSET_DIR, 'error.wav'),
    question: join(ASSET_DIR, 'question.wav'),
  },
  /** 被视为「提问」的工具名。 */
  questionTools: ['ask_user_question', 'exit_plan_mode'],
  /** 调试用：把每次触发追加写入该文件（每行一条 JSON）。默认关闭。 */
  traceFile: null,
}

const KIND_KEYS = Object.keys(KINDS)
const TOP_KEYS = new Set(Object.keys(DEFAULTS))

/** 把用户配置合并到默认值，并对明显错误 fail-loud。 */
function resolveOptions(raw) {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new TypeError('notify-sound: config must be a mapping')
  }
  const input = raw ?? {}
  for (const key of Object.keys(input)) {
    if (!TOP_KEYS.has(key)) throw new Error(`notify-sound: unknown config key "${key}"`)
  }
  const options = {
    ...DEFAULTS,
    ...input,
    sounds: { ...DEFAULTS.sounds, ...(input.sounds ?? {}) },
    toast: { ...DEFAULTS.toast, ...(input.toast ?? {}) },
    questionTools: [...(input.questionTools ?? DEFAULTS.questionTools)],
  }
  if (typeof options.enabled !== 'boolean') throw new TypeError('notify-sound: enabled must be a boolean')
  if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) {
    throw new TypeError('notify-sound: minIntervalMs must be a non-negative number')
  }
  if (typeof options.includeSubagents !== 'boolean') throw new TypeError('notify-sound: includeSubagents must be a boolean')
  if (typeof options.player !== 'string' || options.player.length === 0) throw new TypeError('notify-sound: player must be a non-empty string')
  for (const key of Object.keys(options.sounds)) {
    if (!KIND_KEYS.includes(key)) throw new Error(`notify-sound: unknown sounds key "${key}"`)
    const value = options.sounds[key]
    if (value !== null && value !== false && typeof value !== 'string') {
      throw new TypeError(`notify-sound: sounds.${key} must be a file path, false, or null`)
    }
  }
  for (const tool of options.questionTools) {
    if (typeof tool !== 'string' || tool.length === 0) throw new TypeError('notify-sound: questionTools must contain non-empty strings')
  }
  if (options.toast.kinds !== null) {
    if (!Array.isArray(options.toast.kinds)) throw new TypeError('notify-sound: toast.kinds must be a list or null')
    for (const key of options.toast.kinds) {
      if (!KIND_KEYS.includes(key)) throw new Error(`notify-sound: unknown toast.kinds entry "${key}"`)
    }
  }
  return options
}

/** 把绝对/相对路径解析成可读的绝对路径（相对路径按插件目录解析）。 */
function resolveSoundFile(value) {
  if (value === null || value === false) return null
  const text = String(value)
  return isAbsolute(text) ? text : resolve(HERE, '..', text)
}

/** PowerShell 单引号字符串转义。 */
function quotePowerShell(text) {
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * 把脚本编码成 `-EncodedCommand` 参数（UTF-16LE + Base64）。
 * 走这条路径可以完全绕开命令行引号转义与代码页问题（中文路径、含空格路径都安全）。
 */
function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** 统一的 powershell.exe 参数前缀。 */
function powerShellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(script)]
}

/** 解析本机可用的声音播放器；返回 { command, args(file) } 或 null。 */
function resolvePlayer(preference) {
  if (preference === 'none') return null
  const platform = process.platform
  if (platform === 'win32') {
    const command = preference === 'auto' || preference === 'powershell'
      ? 'powershell.exe'
      : preference === 'pwsh' ? 'pwsh.exe' : preference
    return {
      command,
      args: (file) => powerShellArgs(
        `$ErrorActionPreference='Stop';$player=New-Object System.Media.SoundPlayer ${quotePowerShell(file)};$player.PlaySync()`,
      ),
    }
  }
  if (platform === 'darwin') {
    return { command: preference === 'auto' ? 'afplay' : preference, args: (file) => [file] }
  }
  // Linux: 依次尝试 paplay / aplay
  const command = preference === 'auto' ? (existsSync('/usr/bin/paplay') ? 'paplay' : 'aplay') : preference
  return { command, args: (file) => [file] }
}

/**
 * Windows Toast 通知脚本（WinRT）。
 *
 * `appId` 决定通知的「来源」：只有系统里已注册的 AppUserModelID（开始菜单有对应快捷方式）
 * 才会弹出横幅；未注册的 ID 只会被记进通知中心而不显示。因此默认用 DSH 桌面版的
 * `com.deepseek.dsh`，而不是随便起一个名字。
 */
function toastScript(appId, title, body) {
  const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>`
  return [
    "$ErrorActionPreference='Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml(${quotePowerShell(xml)})`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${quotePowerShell(appId)}).Show($toast)`,
  ].join(';')
}

/** macOS / Linux 桌面通知（PowerShell 之外的平台走这里）。 */
function notifyCommand(title, body) {
  if (process.platform === 'darwin') {
    const esc = (text) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return { command: 'osascript', args: ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`] }
  }
  return { command: 'notify-send', args: [title, body] }
}

/**
 * 安装提示音监听。
 *
 * @param ctx - 插件上下文；监听器随 fiber 一起释放。
 * @param rawConfig - profile patch 中给出的原始 config。
 */
export function apply(ctx, rawConfig) {
  const options = resolveOptions(rawConfig)
  const logger = ctx.logger('notify-sound')

  const player = resolvePlayer(options.player)
  if (player === null) logger.info('sound player disabled (player: none)')
  const questionTools = new Set(options.questionTools)
  const lastFired = new Map()
  const overwriteTrace = options.traceFile === null ? null : resolveSoundFile(options.traceFile)

  // 设置页保存的覆盖项（存在 ~/.dsh/dsh-notify-chime.json）
  const userSettings = loadUserSettings(logger)
  if (typeof userSettings.minIntervalMs === 'number' && Number.isFinite(userSettings.minIntervalMs)) {
    options.minIntervalMs = Math.max(0, Math.floor(userSettings.minIntervalMs))
  }
  if (typeof userSettings.includeSubagents === 'boolean') options.includeSubagents = userSettings.includeSubagents
  if (typeof userSettings.toastEnabled === 'boolean' && options.toast) options.toast.enabled = userSettings.toastEnabled
  let muted = userSettings.muted === true

  const currentSettings = () => ({
    muted,
    minIntervalMs: options.minIntervalMs,
    includeSubagents: options.includeSubagents,
    toastEnabled: Boolean(options.toast && options.toast.enabled),
  })

  /** 追加一行触发记录（仅在配置了 traceFile 时）。 */
  const trace = (entry) => {
    if (overwriteTrace === null) return
    try {
      appendFileSync(overwriteTrace, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      logger.warn(`trace write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 播放一个事件种类的音效 + 可选通知。 */
  const fire = (kind, detail) => {
    const now = Date.now()
    // enabled=false 不再等同于「整插件不加载」：那样会让设置页失去路由、用户被锁在关闭态。
    // 现在它与 muted 同级——照常记账，只是不发声。
    const skipReason = !options.enabled ? 'disabled' : (muted ? 'muted' : null)
    if (skipReason !== null) {
      trace({ time: new Date(now).toISOString(), kind, skipped: skipReason, ...detail })
      return
    }
    const previous = lastFired.get(kind) ?? 0
    if (now - previous < options.minIntervalMs) {
      trace({ time: new Date(now).toISOString(), kind, skipped: 'debounce', ...detail })
      return
    }
    lastFired.set(kind, now)

    const file = resolveSoundFile(options.sounds[kind])
    let played = null
    if (file !== null && player !== null) {
      if (existsSync(file)) {
        played = file
        try {
          const child = spawn(player.command, player.args(file), { windowsHide: true, stdio: 'ignore' })
          child.on('error', (error) => logger.warn(`sound player failed: ${error.message}`))
          child.unref()
        } catch (error) {
          logger.warn(`sound spawn failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        logger.warn(`sound file not found: ${file}`)
      }
    }

    const toastWanted = options.toast.enabled
      && (options.toast.kinds === null || options.toast.kinds.includes(kind))
    if (toastWanted) {
      const label = KINDS[kind].label
      const suffix = options.toast.includeSession && detail?.title ? ` · ${detail.title}` : ''
      const title = `${options.toast.title} · ${label}`
      const body = `${detail?.body ?? KINDS[kind].body}${suffix}`
      try {
        const spec = process.platform === 'win32'
          ? { command: 'powershell.exe', args: powerShellArgs(toastScript(options.toast.appId, title, body)) }
          : notifyCommand(title, body)
        const child = spawn(spec.command, spec.args, { windowsHide: true, stdio: 'ignore' })
        child.on('error', (error) => logger.warn(`notification failed: ${error.message}`))
        child.unref()
      } catch (error) {
        logger.warn(`notification spawn failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    logger.info(`notify %s%s`, kind, detail?.sessionId === undefined ? '' : ` (session ${String(detail.sessionId).slice(0, 12)}…)`)
    trace({ time: new Date(now).toISOString(), kind, sound: played, toast: toastWanted, ...detail })
  }

  /** 回合结束原因 → 事件种类；null 表示不发声。 */
  const classifyTurnEnd = (reason) => {
    switch (reason?.kind) {
      case 'completed':
      case 'max-tokens':
        return 'finished'
      case 'interrupted':
        return 'interrupted'
      case 'error':
        return 'error'
      case 'aborted': {
        const cause = reason.reason?.kind
        // 应用退出/会话释放导致的取消不必提醒；用户停止、父级取消、hook 取消都算中断。
        return cause === 'disposed' ? null : 'interrupted'
      }
      default:
        return null
    }
  }

  /** 会话标题（通知正文用）。 */
  const sessionTitle = (session) => {
    for (const key of ['title', 'name']) {
      const value = session?.header?.[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return undefined
  }

  ctx.on('session/event', (session, event) => {
    if (!options.includeSubagents && (session?.header?.origin === 'subagent' || session?.header?.parentSession !== undefined)) return
    if (event === null || typeof event !== 'object') return

    if (event.type === 'turn/end') {
      const kind = classifyTurnEnd(event.data?.reason)
      if (kind === null) return
      fire(kind, { sessionId: session?.id, title: sessionTitle(session), turn: event.data?.turn })
      return
    }

    if (event.type === 'tool/call' && questionTools.has(event.data?.name)) {
      fire('question', {
        sessionId: session?.id,
        title: sessionTitle(session),
        tool: event.data.name,
        body: `Agent 正在等待你的回答（${event.data.name}）`,
      })
    }
  })

  // ── HTTP 路由（设置页读写）────────────────────────────────────────────
  // 宿主没提供 ctx.inject（mock、无 webserver 的组合）时不能让整个插件崩掉：
  // 那样连事件监听都注册不上，提示音彻底失效。
  if (typeof ctx.inject !== 'function') {
    logger.warn('webServer 不可用：设置页路由未注册')
  } else ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => {
      const routes = [
        {
          kind: 'exact',
          path: '/api/dsh-notify-chime/state',
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405); res.end()
              return
            }
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({
              version: VERSION,
              /** patch 层的总开关：改它需要重启，设置页只读展示 */
              enabledByPatch: options.enabled,
              settings: currentSettings(),
              /** 不可编辑但需要让用户看到的路径 */
              traceFile: options.traceFile,
              sounds: Object.fromEntries(Object.keys(options.sounds).map((k) => [k, resolveSoundFile(options.sounds[k])])),
              questionTools: [...questionTools],
            }))
          },
        },
        {
          kind: 'exact',
          path: '/api/dsh-notify-chime/set',
          handler: async (req, res) => {
            if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
            let body = ''
            for await (const chunk of req) {
              body += chunk
              if (body.length > 16384) { res.writeHead(413); res.end(); return }
            }
            let patch
            try {
              patch = JSON.parse(body || '{}')
            } catch {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON', settings: currentSettings() }))
              return
            }
            const before = JSON.stringify(currentSettings())
            const saved = saveUserSettings(logger, patch, {
              muted,
              minIntervalMs: options.minIntervalMs,
              includeSubagents: options.includeSubagents,
              toastEnabled: Boolean(options.toast && options.toast.enabled),
            })
            if (!saved.ok) {
              res.writeHead(500, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: saved.error || '设置写入失败', settings: currentSettings() }))
              return
            }
            // 立即生效，不需要重启
            muted = saved.settings.muted === true
            options.minIntervalMs = saved.settings.minIntervalMs
            options.includeSubagents = saved.settings.includeSubagents
            if (options.toast) options.toast.enabled = saved.settings.toastEnabled
            const changed = JSON.stringify(currentSettings()) !== before
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, changed, settings: currentSettings() }))
          },
        },
      ]
      const disposers = routes.map((r) => wctx.webServer.register(r))
      return () => disposers.forEach((d) => d())
    })
  })

  logger.info('watching turn/end + question tools (%s)', options.questionTools.join(', '))
  trace({
    time: new Date().toISOString(),
    kind: 'startup',
    effective: {
      enabled: options.enabled,
      minIntervalMs: options.minIntervalMs,
      includeSubagents: options.includeSubagents,
      player: options.player,
      sounds: options.sounds,
      toast: options.toast,
      questionTools: options.questionTools,
    },
  })
}
