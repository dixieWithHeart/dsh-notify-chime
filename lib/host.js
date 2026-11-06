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

/** 设置页写入的用户设置文件名（放在 DSH 主目录）。 */
const SETTINGS_FILENAME = 'dsh-notify-chime.json'
const VERSION = '1.4.0'
/** 去抖间隔上限：填成天文数字会让提示音事实上永久失效，这里兜住。 */
const MAX_MIN_INTERVAL_MS = 600000
/** 通知标题前缀的长度上限（再长会被系统截断，也挤掉事件名）。 */
const MAX_TOAST_TITLE = 60
/**
 * 内置音色套：default 用 assets/<kind>.wav，其余用 assets/<set>/<kind>.wav，
 * custom 用用户上传到 ~/.dsh/dsh-notify-chime-sounds/ 的文件（缺的回退内置）。
 */
const SOUNDSETS = [
  { key: 'default', label: '默认' },
  { key: 'soft', label: '柔和' },
  { key: 'chime', label: '钟声' },
  { key: 'retro', label: '复古' },
  { key: 'digital', label: '电子' },
  { key: 'wood', label: '木质' },
  { key: 'custom', label: '自定义' },
]
const SOUNDSET_KEYS = SOUNDSETS.map((set) => set.key)
/** 自定义音效上传上限：5 MB，足够十几秒无损音频。 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/** DSH 主目录：profile 启动时带 DSH_HOME，裸进程回落到 ~/.dsh。 */
function dshHome () {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function settingsPath () {
  return join(dshHome(), SETTINGS_FILENAME)
}

/** 用户上传的自定义音效目录：与包目录分开，卸载插件也不丢。 */
function soundsDir () {
  return join(dshHome(), 'dsh-notify-chime-sounds')
}

function loadUserSettings (logger) {
  try {
    const file = settingsPath()
    if (!existsSync(file)) return {}
    // 记事本等编辑器可能写 BOM，JSON.parse 遇到会直接抛错，先剥掉
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch (error) {
    logger.warn(`settings load failed: ${error instanceof Error ? error.message : String(error)}`)
    return {}
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
  /** 音色套：default | soft | chime | retro | digital | wood | custom。 */
  soundset: 'default',
  /** 每类事件是否发声（设置页可逐类关掉，不必整类静音）。 */
  kinds: {
    finished: true,
    interrupted: true,
    error: true,
    question: true,
  },
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
  sounds: Object.fromEntries(Object.entries(KINDS).map(([key, meta]) => [key, join(ASSET_DIR, meta.asset)])),
  /** 被视为「提问」的工具名。 */
  questionTools: ['ask_user_question', 'exit_plan_mode'],
  /** 调试用：把每次触发追加写入该文件（每行一条 JSON）。默认关闭。 */
  traceFile: null,
}

const KIND_KEYS = Object.keys(KINDS)
const TOP_KEYS = new Set(Object.keys(DEFAULTS))
/** 自定义音效的初始值：每类事件都没上传。 */
const DEFAULT_CUSTOM_SOUNDS = Object.fromEntries(KIND_KEYS.map((key) => [key, null]))
/** 每类事件单独指定音色套的初始值：null = 跟随全局。 */
const DEFAULT_PER_KIND_SOUNDSET = Object.fromEntries(KIND_KEYS.map((key) => [key, null]))

/** 从 patch 配置提取「设置页可见」的初始值。 */
function settingsFromOptions(options) {
  const toastKinds = options.toast && Array.isArray(options.toast.kinds)
    ? [...options.toast.kinds]
    : [...KIND_KEYS]
  return {
    enabled: options.enabled,
    soundset: options.soundset,
    perKindSoundset: { ...DEFAULT_PER_KIND_SOUNDSET },
    customSounds: { ...DEFAULT_CUSTOM_SOUNDS },
    kinds: { ...options.kinds },
    minIntervalMs: options.minIntervalMs,
    includeSubagents: options.includeSubagents,
    toast: {
      enabled: Boolean(options.toast && options.toast.enabled),
      kinds: toastKinds,
      title: String(options.toast?.title ?? 'DeepSeek Harness').slice(0, MAX_TOAST_TITLE),
      includeSession: Boolean(options.toast?.includeSession),
    },
  }
}

/**
 * 把设置文件内容归一化成当前结构，并兼容 1.1.x 的平铺字段：
 * `muted: true` → `enabled: false`，`toastEnabled` → `toast.enabled`。
 * 非法值一律回落到 patch 默认值，不抛错（设置文件坏了也要能打开设置页）。
 */
function normalizeSettings(raw, fallback) {
  const out = {
    enabled: fallback.enabled,
    soundset: fallback.soundset,
    perKindSoundset: { ...fallback.perKindSoundset },
    customSounds: { ...fallback.customSounds },
    kinds: { ...fallback.kinds },
    minIntervalMs: fallback.minIntervalMs,
    includeSubagents: fallback.includeSubagents,
    toast: { ...fallback.toast, kinds: [...fallback.toast.kinds] },
  }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  else if (raw.muted === true) out.enabled = false
  if (typeof raw.minIntervalMs === 'number' && Number.isFinite(raw.minIntervalMs)) {
    out.minIntervalMs = Math.min(MAX_MIN_INTERVAL_MS, Math.max(0, Math.floor(raw.minIntervalMs)))
  }
  if (typeof raw.includeSubagents === 'boolean') out.includeSubagents = raw.includeSubagents
  if (raw.kinds !== null && typeof raw.kinds === 'object' && !Array.isArray(raw.kinds)) {
    for (const key of KIND_KEYS) {
      if (typeof raw.kinds[key] === 'boolean') out.kinds[key] = raw.kinds[key]
    }
  }
  if (typeof raw.soundset === 'string' && SOUNDSET_KEYS.includes(raw.soundset)) out.soundset = raw.soundset
  if (raw.perKindSoundset !== null && typeof raw.perKindSoundset === 'object' && !Array.isArray(raw.perKindSoundset)) {
    for (const key of KIND_KEYS) {
      const value = raw.perKindSoundset[key]
      if (value === null) out.perKindSoundset[key] = null
      else if (typeof value === 'string' && SOUNDSET_KEYS.includes(value)) out.perKindSoundset[key] = value
    }
  }
  if (raw.customSounds !== null && typeof raw.customSounds === 'object' && !Array.isArray(raw.customSounds)) {
    for (const key of KIND_KEYS) {
      const value = raw.customSounds[key]
      if (typeof value === 'string' && value.length > 0) out.customSounds[key] = value
      else if (value === null) out.customSounds[key] = null
    }
  }
  if (raw.toast !== null && typeof raw.toast === 'object' && !Array.isArray(raw.toast)) {
    if (typeof raw.toast.enabled === 'boolean') out.toast.enabled = raw.toast.enabled
    if (typeof raw.toast.includeSession === 'boolean') out.toast.includeSession = raw.toast.includeSession
    if (typeof raw.toast.title === 'string' && raw.toast.title.trim().length > 0) {
      out.toast.title = raw.toast.title.trim().slice(0, MAX_TOAST_TITLE)
    }
    if (Array.isArray(raw.toast.kinds)) {
      out.toast.kinds = raw.toast.kinds.filter((key) => KIND_KEYS.includes(key))
    }
  } else if (typeof raw.toastEnabled === 'boolean') {
    out.toast.enabled = raw.toastEnabled
  }
  return out
}

/**
 * 把设置页提交的局部 patch 合并进当前设置，返回新对象。
 * 非法值抛错，由路由层转成 400 —— 不静默吞掉错误，否则页面会显示「已保存」但其实没生效。
 */
function applySettingsPatch(current, patch, fallback) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('请求体必须是对象')
  }
  if (patch.reset === true) return normalizeSettings({}, fallback)

  const known = new Set(['enabled', 'soundset', 'perKindSoundset', 'customSounds', 'kinds', 'minIntervalMs', 'includeSubagents', 'toast', 'reset'])
  for (const key of Object.keys(patch)) {
    if (!known.has(key)) throw new Error(`未知设置项 "${key}"`)
  }
  const next = {
    enabled: current.enabled,
    soundset: current.soundset,
    perKindSoundset: { ...current.perKindSoundset },
    customSounds: { ...current.customSounds },
    kinds: { ...current.kinds },
    minIntervalMs: current.minIntervalMs,
    includeSubagents: current.includeSubagents,
    toast: { ...current.toast, kinds: [...current.toast.kinds] },
  }
  if (patch.soundset !== undefined) {
    if (typeof patch.soundset !== 'string' || !SOUNDSET_KEYS.includes(patch.soundset)) {
      throw new Error(`未知音色套 "${String(patch.soundset)}"`)
    }
    next.soundset = patch.soundset
  }
  if (patch.perKindSoundset !== undefined) {
    if (patch.perKindSoundset === null || typeof patch.perKindSoundset !== 'object' || Array.isArray(patch.perKindSoundset)) {
      throw new TypeError('perKindSoundset 必须是对象')
    }
    for (const key of Object.keys(patch.perKindSoundset)) {
      if (!KIND_KEYS.includes(key)) throw new Error(`未知事件种类 "${key}"`)
      const value = patch.perKindSoundset[key]
      if (value === null) next.perKindSoundset[key] = null
      else if (typeof value === 'string' && SOUNDSET_KEYS.includes(value)) next.perKindSoundset[key] = value
      else throw new Error(`perKindSoundset.${key} 必须是音色套名或 null（${String(value)}）`)
    }
  }
  if (patch.customSounds !== undefined) {
    if (patch.customSounds === null || typeof patch.customSounds !== 'object' || Array.isArray(patch.customSounds)) {
      throw new TypeError('customSounds 必须是对象')
    }
    for (const key of Object.keys(patch.customSounds)) {
      if (!KIND_KEYS.includes(key)) throw new Error(`未知事件种类 "${key}"`)
      const value = patch.customSounds[key]
      if (value === null) next.customSounds[key] = null
      else if (typeof value === 'string' && value.length > 0) next.customSounds[key] = value
      else throw new TypeError(`customSounds.${key} 必须是路径字符串或 null`)
    }
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值')
    next.enabled = patch.enabled
  }
  if (patch.includeSubagents !== undefined) {
    if (typeof patch.includeSubagents !== 'boolean') throw new TypeError('includeSubagents 必须是布尔值')
    next.includeSubagents = patch.includeSubagents
  }
  if (patch.minIntervalMs !== undefined) {
    if (typeof patch.minIntervalMs !== 'number' || !Number.isFinite(patch.minIntervalMs) || patch.minIntervalMs < 0) {
      throw new TypeError('minIntervalMs 必须是非负数')
    }
    next.minIntervalMs = Math.min(MAX_MIN_INTERVAL_MS, Math.floor(patch.minIntervalMs))
  }
  if (patch.kinds !== undefined) {
    if (patch.kinds === null || typeof patch.kinds !== 'object' || Array.isArray(patch.kinds)) {
      throw new TypeError('kinds 必须是对象')
    }
    for (const key of Object.keys(patch.kinds)) {
      if (!KIND_KEYS.includes(key)) throw new Error(`未知事件种类 "${key}"`)
      if (typeof patch.kinds[key] !== 'boolean') throw new TypeError(`kinds.${key} 必须是布尔值`)
      next.kinds[key] = patch.kinds[key]
    }
  }
  if (patch.toast !== undefined) {
    if (patch.toast === null || typeof patch.toast !== 'object' || Array.isArray(patch.toast)) {
      throw new TypeError('toast 必须是对象')
    }
    const t = patch.toast
    if (t.enabled !== undefined) {
      if (typeof t.enabled !== 'boolean') throw new TypeError('toast.enabled 必须是布尔值')
      next.toast.enabled = t.enabled
    }
    if (t.includeSession !== undefined) {
      if (typeof t.includeSession !== 'boolean') throw new TypeError('toast.includeSession 必须是布尔值')
      next.toast.includeSession = t.includeSession
    }
    if (t.title !== undefined) {
      if (typeof t.title !== 'string') throw new TypeError('toast.title 必须是字符串')
      const title = t.title.trim()
      if (title.length === 0) throw new Error('通知标题不能为空')
      next.toast.title = title.slice(0, MAX_TOAST_TITLE)
    }
    if (t.kinds !== undefined) {
      if (!Array.isArray(t.kinds)) throw new TypeError('toast.kinds 必须是数组')
      for (const key of t.kinds) {
        if (!KIND_KEYS.includes(key)) throw new Error(`未知通知事件种类 "${key}"`)
      }
      next.toast.kinds = [...new Set(t.kinds)]
    }
  }
  return next
}

/** 把设置写回 ~/.dsh/dsh-notify-chime.json。 */
function saveSettings(logger, value) {
  try {
    const file = settingsPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
    return { ok: true, settings: value }
  } catch (error) {
    logger.warn(`settings save failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: error instanceof Error ? error.message : String(error), settings: value }
  }
}

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
    kinds: { ...DEFAULTS.kinds, ...(input.kinds ?? {}) },
    toast: { ...DEFAULTS.toast, ...(input.toast ?? {}) },
    questionTools: [...(input.questionTools ?? DEFAULTS.questionTools)],
  }
  if (typeof options.enabled !== 'boolean') throw new TypeError('notify-sound: enabled must be a boolean')
  if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) {
    throw new TypeError('notify-sound: minIntervalMs must be a non-negative number')
  }
  if (typeof options.includeSubagents !== 'boolean') throw new TypeError('notify-sound: includeSubagents must be a boolean')
  if (typeof options.soundset !== 'string' || !SOUNDSET_KEYS.includes(options.soundset)) {
    throw new Error(`notify-sound: unknown soundset "${String(options.soundset)}"`)
  }
  for (const key of Object.keys(options.kinds)) {
    if (!KIND_KEYS.includes(key)) throw new Error(`notify-sound: unknown kinds key "${key}"`)
    if (typeof options.kinds[key] !== 'boolean') throw new TypeError(`notify-sound: kinds.${key} must be a boolean`)
  }
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
    // auto / powershell / pwsh 走 PowerShell 脚本（-EncodedCommand 免引号转义）；
    // 其它值当播放器可执行文件，直接把文件路径作为唯一参数传过去。
    if (preference === 'auto' || preference === 'powershell' || preference === 'pwsh') {
      const command = preference === 'pwsh' ? 'pwsh.exe' : 'powershell.exe'
      return {
        command,
        args: (file) => powerShellArgs(
          `$ErrorActionPreference='Stop';$player=New-Object System.Media.SoundPlayer ${quotePowerShell(file)};$player.PlaySync()`,
        ),
      }
    }
    return { command: preference, args: (file) => [file] }
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
  const tracePath = options.traceFile === null ? null : resolveSoundFile(options.traceFile)

  // patch 值就是初始默认值；设置页写入的值覆盖它（存在 ~/.dsh/dsh-notify-chime.json）
  const patchSettings = settingsFromOptions(options)
  let settings = normalizeSettings(loadUserSettings(logger), patchSettings)
  const currentSettings = () => settings

  /** 某类事件最终生效的音色套：该事件单独指定的优先，否则跟随全局。 */
  const effectiveSoundset = (kind) => {
    const own = settings.perKindSoundset ? settings.perKindSoundset[kind] : null
    return own || settings.soundset || 'default'
  }

  /** 按当前音色套解析某类事件的音效文件；null 表示这类事件不发声。 */
  const soundFileFor = (kind) => {
    const configured = options.sounds[kind]
    // patch 显式把该类设成 false / null：整类静音，任何音色套都不覆盖
    if (configured === null || configured === false) return null
    const set = effectiveSoundset(kind)
    if (set === 'custom') {
      const own = settings.customSounds ? settings.customSounds[kind] : null
      if (typeof own === 'string' && own.length > 0) {
        if (existsSync(own)) return own
        logger.warn(`custom sound missing: ${own}`)
      }
      // 这类没上传、或文件被移走：回退内置默认，不静音
      return resolveSoundFile(configured)
    }
    if (set && set !== 'default') {
      const preset = join(ASSET_DIR, set, `${kind}.wav`)
      if (existsSync(preset)) return preset
      logger.warn(`sound set "${set}" has no ${kind}.wav, falling back to default`)
    }
    return resolveSoundFile(configured)
  }

  /** 追加一行触发记录（仅在配置了 traceFile 时）。 */
  const trace = (entry) => {
    if (tracePath === null) return
    try {
      appendFileSync(tracePath, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      logger.warn(`trace write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 播放一个音频文件（不阻塞宿主）；返回实际播放的路径或 null。 */
  const playFile = (file) => {
    if (file === null || player === null) return null
    if (!existsSync(file)) {
      logger.warn(`sound file not found: ${file}`)
      return null
    }
    try {
      const child = spawn(player.command, player.args(file), { windowsHide: true, stdio: 'ignore' })
      child.on('error', (error) => logger.warn(`sound player failed: ${error.message}`))
      child.unref()
      return file
    } catch (error) {
      logger.warn(`sound spawn failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** 播放一个事件种类的音效 + 可选通知。 */
  const fire = (kind, detail) => {
    const now = Date.now()
    // enabled=false 不等同于「整插件不加载」：那样会让设置页失去路由、用户被锁在关闭态。
    // 它现在由设置页控制，与其他开关同级——照常记账，只是不发声。
    const skipReason = !settings.enabled ? 'disabled'
      : settings.kinds[kind] === false ? 'kind-disabled'
        : null
    if (skipReason !== null) {
      trace({ time: new Date(now).toISOString(), kind, skipped: skipReason, ...detail })
      return
    }
    const previous = lastFired.get(kind) ?? 0
    if (now - previous < settings.minIntervalMs) {
      trace({ time: new Date(now).toISOString(), kind, skipped: 'debounce', ...detail })
      return
    }
    lastFired.set(kind, now)

    const played = playFile(soundFileFor(kind))

    const toastWanted = settings.toast.enabled && settings.toast.kinds.includes(kind)
    if (toastWanted) {
      const label = KINDS[kind].label
      const suffix = settings.toast.includeSession && detail?.title ? ` · ${detail.title}` : ''
      const title = `${settings.toast.title} · ${label}`
      const body = `${detail?.body ?? KINDS[kind].body}${suffix}`.slice(0, 200)
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

    logger.info(`notify ${kind}${detail?.sessionId === undefined ? '' : ` (session ${String(detail.sessionId).slice(0, 12)}…)`}`)
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
    if (!settings.includeSubagents && (session?.header?.origin === 'subagent' || session?.header?.parentSession !== undefined)) return
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
      /** 设置页需要的全部状态：可编辑项 + 只读展示项。 */
      const statePayload = () => ({
        version: VERSION,
        /** patch 里的初始值，只读展示：设置页改过之后还能看出补丁原本怎么配的 */
        enabledByPatch: patchSettings.enabled,
        settings: currentSettings(),
        /** 每类事件的展示元数据；音效文件缺失时页面要能提示 */
        kinds: KIND_KEYS.map((key) => {
          const sound = soundFileFor(key)
          const own = settings.perKindSoundset ? settings.perKindSoundset[key] : null
          return {
            key,
            label: KINDS[key].label,
            body: KINDS[key].body,
            sound,
            soundExists: sound !== null && existsSync(sound),
            /** 该事件最终生效的音色套（null 项已解析成全局套） */
            soundset: effectiveSoundset(key),
            /** 是否单独指定了套（false = 跟随全局） */
            soundsetPinned: Boolean(own),
          }
        }),
        /** 音色套清单（设置页渲染 chip 用） */
        soundsets: SOUNDSETS,
        customSounds: { ...settings.customSounds },
        soundsDir: soundsDir(),
        traceFile: options.traceFile,
        settingsFile: settingsPath(),
        questionTools: [...questionTools],
        toastAppId: options.toast.appId,
      })

      const json = (res, status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(payload))
      }

      /** 读 JSON 请求体；超过 16 KB 视为异常请求。出错时已自行响应，返回 null。 */
      const readJson = async (req, res) => {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 16384) {
            json(res, 413, { ok: false, error: '请求体过大' })
            return null
          }
        }
        try {
          return JSON.parse(body || '{}')
        } catch {
          json(res, 400, { ok: false, error: '请求体不是合法 JSON', settings: currentSettings() })
          return null
        }
      }

      const routes = [
        {
          kind: 'exact',
          path: '/api/dsh-notify-chime/state',
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405); res.end()
              return
            }
            if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
            json(res, 200, statePayload())
          },
        },
        {
          kind: 'exact',
          path: '/api/dsh-notify-chime/set',
          handler: async (req, res) => {
            if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
            const patch = await readJson(req, res)
            if (patch === null) return
            const before = JSON.stringify(settings)
            let next
            try {
              next = applySettingsPatch(settings, patch, patchSettings)
            } catch (error) {
              json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error), settings: currentSettings() })
              return
            }
            const saved = saveSettings(logger, next)
            if (!saved.ok) {
              json(res, 500, { ok: false, error: saved.error || '设置写入失败', settings: currentSettings() })
              return
            }
            // 立即生效，不需要重启
            settings = saved.settings
            const changed = JSON.stringify(settings) !== before
            json(res, 200, { ok: true, changed, settings: currentSettings() })
          },
        },
        {
          kind: 'exact',
          path: '/api/dsh-notify-chime/preview',
          handler: async (req, res) => {
            if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
            const body = await readJson(req, res)
            if (body === null) return
            const kind = body.kind
            if (!KIND_KEYS.includes(kind)) {
              json(res, 400, { ok: false, error: `未知事件种类 "${String(kind)}"` })
              return
            }
            // 试听不受「启用 / 静音 / 去抖」影响：用户点它就是想听一下。
            const file = soundFileFor(kind)
            if (file === null) {
              json(res, 200, { ok: false, kind, error: '这类事件已配置为不发声（patch 的 sounds 设成 false / null）' })
              return
            }
            if (player === null) {
              json(res, 200, { ok: false, kind, sound: file, error: '播放器被禁用（patch 的 player: none）' })
              return
            }
            if (!existsSync(file)) {
              json(res, 200, { ok: false, kind, sound: file, error: `音效文件不存在：${file}` })
              return
            }
            const played = playFile(file)
            if (played === null) {
              json(res, 200, { ok: false, kind, sound: file, error: '播放进程启动失败，详见宿主日志' })
              return
            }
            trace({ time: new Date().toISOString(), kind, preview: true, sound: played })
            json(res, 200, { ok: true, kind, sound: played, label: KINDS[kind].label })
          },
        },
        {
          kind: 'exact',
          path: '/api/dsh-notify-chime/sound',
          handler: async (req, res) => {
            // 上传自定义音效：只接受 WAV，只写固定目录的固定文件名，不信任客户端给的文件名。
            if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
            const kindHeader = req.headers ? req.headers['x-chime-kind'] : undefined
            const kind = Array.isArray(kindHeader) ? kindHeader[0] : kindHeader
            if (!KIND_KEYS.includes(kind)) {
              json(res, 400, { ok: false, error: `未知事件种类 "${String(kind)}"` })
              return
            }
            const chunks = []
            let size = 0
            for await (const chunk of req) {
              size += chunk.length
              if (size > MAX_UPLOAD_BYTES) {
                json(res, 413, { ok: false, error: '音频文件过大（上限 5 MB）' })
                return
              }
              chunks.push(chunk)
            }
            const buffer = Buffer.concat(chunks)
            if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
              json(res, 400, { ok: false, error: '只支持 WAV 文件（播放后端 System.Media.SoundPlayer 不支持其它格式）' })
              return
            }
            const dir = soundsDir()
            const file = join(dir, `${kind}.wav`)
            try {
              mkdirSync(dir, { recursive: true })
              writeFileSync(file, buffer)
            } catch (error) {
              json(res, 500, { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` })
              return
            }
            // 只把这一类切到「自定义」：全局音色不动，避免上传一个音效把其它事件也换掉。
            const next = applySettingsPatch(settings, {
              perKindSoundset: { [kind]: 'custom' },
              customSounds: { [kind]: file },
            }, patchSettings)
            const saved = saveSettings(logger, next)
            if (!saved.ok) {
              json(res, 500, { ok: false, sound: file, error: saved.error || '音效已写入，但设置保存失败' })
              return
            }
            settings = saved.settings
            trace({ time: new Date().toISOString(), kind, upload: file, bytes: buffer.length })
            json(res, 200, {
              ok: true,
              kind,
              sound: file,
              bytes: buffer.length,
              settings: currentSettings(),
            })
          },
        },
      ]
      const disposers = routes.map((route) => {
        try {
          return wctx.webServer.register(route)
        } catch (error) {
          // 单条路由注册失败不该连累事件监听与其它路由
          logger.warn(`route register failed: ${route.path}: ${error instanceof Error ? error.message : String(error)}`)
          return () => {}
        }
      })
      return () => disposers.forEach((d) => d())
    })
  })

  logger.info('watching turn/end + question tools (%s)', options.questionTools.join(', '))
  trace({
    time: new Date().toISOString(),
    kind: 'startup',
    effective: {
      enabled: settings.enabled,
      soundset: settings.soundset,
      kinds: settings.kinds,
      minIntervalMs: settings.minIntervalMs,
      includeSubagents: settings.includeSubagents,
      player: options.player,
      sounds: options.sounds,
      toast: { ...options.toast, ...settings.toast },
      questionTools: options.questionTools,
    },
  })
}
