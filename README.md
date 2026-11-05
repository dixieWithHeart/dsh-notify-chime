# dsh-notify-chime（提示音）

给 DeepSeek Harness 加「听得见」的提醒：**工作完成 / 工作中断 / 出错 / Agent 提问** 时播放音效，
需要视觉提醒时还可以弹出 Windows 系统通知（Toast）。

插件跑在 Host 进程里，**零依赖**（只用 Node 内置模块）、无构建步骤，装完即可用。

---

## 安装

```powershell
dsh plugin add dsh-notify-chime
```

装完刷新页面，在「设置 → 提示音」里调开关与最小间隔。默认只在你的会话结束 / 出错 / Agent 提问时发声。

## 1. 触发时机与默认音效

| 场景 | 触发来源 | `kind` | 默认音效 |
| --- | --- | --- | --- |
| 工作完成（模型不再需要动作，回合正常关闭） | `session/event` → `turn/end`，`reason.kind = completed` / `max-tokens` | `finished` | `assets/finished.wav`（上行三音） |
| 工作中断（点停止、会话被归档、父级/hook 取消、崩溃修复的回合） | `turn/end`，`reason.kind = aborted`（除 `disposed` 外）或 `interrupted` | `interrupted` | `assets/interrupted.wav`（下行两音） |
| 出错结束（模型请求失败并终止回合） | `turn/end`，`reason.kind = error` | `error` | `assets/error.wav`（低频双响） |
| Agent 提问（等你回答 / 等你批准计划） | `session/event` → `tool/call`，工具名命中 `questionTools` | `question` | `assets/question.wav`（三声高音） |

不发声的情况：`reason.kind = aborted` 且取消原因是 `disposed`（应用退出 / 会话释放）、
`forked`（会话分叉）、`blocked`；以及默认被过滤掉的 subagent 子会话。

四种音效是脚本合成的（`tools/make_sounds.py`），音色区分明显、时长 0.7–0.9 秒，可以直接换成你自己的 wav。

## 2. 文件结构

```
dsh-notify-chime/
├── package.json                  # 包元信息（type: module、dsh.bundle.patch）
├── cordis.patch.yml              # 宿主行：装完自动插入 id dsh-notify-chime
├── lib/host.js                   # 插件本体（Host 侧）
├── client.js                     # 设置页（Web 端，slot: settings.section）
├── assets/                       # 四种内置音效 wav
├── locale/{zh,en}.json           # 标题与描述
├── icon.svg                      # 图标
├── tools/make_sounds.py          # 重新生成音效（可改音高/时长）
├── tools/smoke-test.mjs          # 回归测试：投递合成事件并打印分类结果
├── tools/try.mjs                 # 手动试听 / 试弹通知
├── tools/check-notifications.py  # 查 Windows 通知中心数据库：通知到底有没有送达
├── LICENSE / README.md
```

## 3. 安装与配置

```powershell
dsh plugin add dsh-notify-chime
```

包自带 `cordis.patch.yml`，装完自动插入 id `dsh-notify-chime` 的宿主行，不需要手改 profile。

**改配置**：在「设置 → 提示音」里改，写入 `~/.dsh/dsh-notify-chime.json`，保存即生效。要改启动默认值，在 profile 的 `cordis.patch.yml` 里用**同一个 id** 覆盖：

```yaml
- id: dsh-notify-chime
  config:
    minIntervalMs: 700
    includeSubagents: false
```

**改源码**：workspace bundle 以符号链接安装时，Host 侧（`lib/host.js`）改完需重启 DSH——`dsh-hmr` 不监视插件源码目录；Web 端（`client.js`）改完刷新页面即可。

> 默认：四类事件都发声，其中 **Agent 提问**额外弹一条系统通知；子代理会话不提醒。
> 包内**不写** `traceFile`（默认 `null`，不落轨迹）；本地调试要看日志，在 profile 覆盖里自行指一个路径。

## 4. 配置项

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 总开关；`false` 时插件只注册一个空实现，不监听任何事件 |
| `minIntervalMs` | number | `700` | 同一 `kind` 的最小触发间隔，用于去抖（连续多回合完成时不会连响） |
| `includeSubagents` | bool | `false` | 是否也为 subagent / 子会话发声（默认只提醒你自己的会话，避免刷屏） |
| `player` | string | `auto` | `auto` / `powershell` / `pwsh` / `none` / 播放器可执行文件绝对路径 |
| `sounds.finished` 等 | string \| `false` \| `null` | 内置 wav | 每一类事件的声音文件；`false`/`null` 表示该类不发声 |
| `questionTools` | string[] | `["ask_user_question", "exit_plan_mode"]` | 视为「提问」的工具名 |
| `toast.enabled` | bool | `false` | 是否同时弹系统通知 |
| `toast.kinds` | string[] \| `null` | `null` | 只对哪些 kind 弹通知；`null` = 全部 |
| `toast.title` | string | `DeepSeek Harness` | 通知标题前缀（最终标题为 `标题 · 事件名`） |
| `toast.includeSession` | bool | `true` | 通知正文是否附带会话标题 |
| `toast.appId` | string | `com.deepseek.dsh` | Windows 通知来源 AppUserModelID，**必须是系统已注册的 ID**（见第 6 节） |
| `traceFile` | string \| `null` | `null` | 调试用：每次触发追加一行 JSON，便于确认「到底有没有响」 |

相对路径按插件目录解析；未知字段会**直接报错**（fail-loud），配置写错时在 Host 日志里一眼可见。

## 5. 换成自己的音效

```yaml
      config:
        sounds:
          finished: C:/Windows/Media/Windows Print complete.wav
          interrupted: C:/Windows/Media/Windows Critical Stop.wav
          question: C:/Windows/Media/Windows Notify Messaging.wav
          error: false          # 出错不响
```

也可以用 `tools/make_sounds.py` 改音高后重新生成到 `assets/`（需要 Python，无第三方依赖）。

## 6. 打开系统通知（Toast）

```yaml
      config:
        toast:
          enabled: true
          kinds: [question]     # 只在 Agent 提问时弹，完成/中断只响不弹
          appId: com.deepseek.dsh
```

Windows 走 WinRT Toast（`powershell.exe -EncodedCommand`，脚本 UTF-16LE + Base64，路径含空格/中文都安全）。
macOS 用 `osascript`、Linux 用 `notify-send` 作为对应实现。

### 关于 `appId`——「通知中心里有、但就是不弹横幅」的根因

Windows 只给**已注册的 AppUserModelID**（开始菜单里存在同名快捷方式）弹横幅；
随便起一个名字（例如 `DeepSeek Harness`）也能 `Show()` 成功、也会写进通知中心数据库，
但**永远不会显示横幅**，而且注册表里不会生成对应的通知设置项。

所以：

- 默认值 `com.deepseek.dsh` 就是 DSH 桌面版注册的 AppID（可用 `Get-StartApps` 确认）。
- 换成绿色版/自编译版时，把 `appId` 改成你自己的 AppID（没有的话，说明程序没有注册 Start Menu 快捷方式，
  需要自己造一个带 AppUserModelID 的快捷方式，或用命令行参数启动的 `ToastNotifier` 兼容写法）。

排查三步：

```powershell
# 1. 通知到底有没有送达 Windows（看 handler 与时间）
python tools/check-notifications.py 6

# 2. 系统里有没有这个来源的通知设置项（有 → 是已注册应用，能弹横幅）
Get-ChildItem "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings" |
  Where-Object PSChildName -match "deepseek|Harness"

# 3. 手动弹一条，肉眼确认
node tools/try.mjs toast
```

如果通知确实送达（第 1 步有记录）但不弹横幅，检查系统「设置 → 系统 → 通知」里
该来源的开关与「专注助手 / 勿扰模式」。

## 7. 调试与验证

```powershell
# 试听四种音效 / 试弹通知
node tools/try.mjs all
node tools/try.mjs question
node tools/try.mjs toast

# 回归测试：投递合成事件，打印每个事件被分成哪一类（含应静音的用例）
node tools/smoke-test.mjs
```

想看「刚才到底响了没有」，在 profile 的 `cordis.patch.yml` 里覆盖 `traceFile` 指到一个文件，
每次插件装载、每次触发都会追加一行：

```json
{"time":"2026-10-04T07:51:46.931Z","kind":"startup","effective":{ … 当前生效配置 … }}
{"time":"2026-10-04T07:38:33.999Z","kind":"finished","sound":"…\\finished.wav","toast":false,"sessionId":"11c6c7d1-…","turn":1}
```

`kind: "startup"` 那一行同时是「配置有没有真的生效」的证据；默认不配 `traceFile`，就不会产生任何文件。

## 8. 停用与卸载

- 临时静音：用设置页的「静音」开关（立即生效）；在 profile 覆盖里把 `enabled` 改成 `false` 则**只是不发声**，插件仍会加载、设置页照常可用。
- 彻底移除：`dsh plugin remove dsh-notify-chime`（或 `plugin_manager` 的 `remove_bundle`）；设置文件 `~/.dsh/dsh-notify-chime.json` 可留可删。

## 9. 工作原理与限制

- **事件来源是广播型事件，不参与 waterfall 争抢**：`session/event` 是 `emit` 模式，
  所有监听器都会收到，因此不会被内置监听器「抢先回答」而漏掉——这是选择它而不是
  `user-questions/request`（waterfall，内置 Web 应答器先注册、可能不调用 `next()`）的原因。
- **提问的识别**靠 `tool/call` 事件里的工具名：模型一发出 `ask_user_question` / `exit_plan_mode`
  就会响，和界面上弹出提问框几乎同时。
- **发声不阻塞 Host**：每次提醒 spawn 一个独立子进程播放，
  Windows 上是 `powershell.exe` + `System.Media.SoundPlayer.PlaySync()`，`windowsHide` 不闪黑框，
  进程 `unref()` 且不参与 Host 生命周期；`PowerShell 5.1` 冷启动约 200 ms，音效延迟约 0.3 s。
- **只提醒上次交互之后的新事件**：监听的是会话日志的追加流，冷启动打开历史会话不会补响。
- **音频输出**取决于系统默认播放设备；若默认设备是虚拟声卡（VB-Audio 等），人耳可能听不到——
  这是设备问题，不是插件问题。
