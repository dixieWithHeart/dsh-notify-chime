# dsh-notify-chime（提示音）

回合**完成 / 中断 / 出错 / Agent 提问**时播放音效，可另弹系统通知。

| 场景 | kind | 默认音色 |
| --- | --- | --- |
| 回合正常结束 | `finished` | 上行三音 |
| 中断（停止、归档、取消） | `interrupted` | 下行两音 |
| 出错结束 | `error` | 低频双响 |
| Agent 提问（等回答） | `question` | 三声高音 |
| 等待审批（`approval/asked`） | `approval` | 上行双音，稍急 |
| 计划评审（`exit_plan_mode`） | `plan-review` | 三音上行 |
| 目标受阻（`goal/change` → `phase: blocked`） | `goal-blocked` | 低频下行 |
| 后台任务失败（`job/settled` → `failed`） | `job-failed` | 短促双音 |

计划评审以前混在「提问」里，1.5.0 起单独分类。目标受阻只在「非 blocked → blocked」那一次跃迁发声；后台任务失败按会话 3 秒窗口去抖，多个任务同时失败只响一次。

应用退出、会话分叉、被阻断，以及默认被过滤的 subagent 会话不发声。

## 安装

```powershell
dsh plugin add dsh-notify-chime
```

包自带 `cordis.patch.yml`，装完自动插入宿主行。刷新页面后在「设置 → 提示音」里调。

## 设置页

三组，保存即生效，不重启：

| 组 | 内容 |
| --- | --- |
| 声音 | 总开关、音色、八类事件各自开关与试听、正在看的会话完成时不响、同类事件最小间隔、子会话提醒 |
| 通知 | 通知总开关、哪些事件弹、标题前缀、正文是否带会话名 |
| 高级 | 设置文件 / 音效 / 自定义 / 轨迹目录（只读）、恢复默认 |

总开关关闭后不发声也不弹通知，事件照常记账，随时能开回来。

设置存 `~/.dsh/dsh-notify-chime.json`，只记改过的项。

## 音色

六套内置，只换音色，不改触发规则：

| 套 | 听感 |
| --- | --- |
| `default` | 明亮三音，1.0 起的出厂音效 |
| `soft` | 低八度、慢起音、谐波少，适合安静环境 |
| `chime` | 长尾泛音，风铃感 |
| `retro` | 方波短促，8-bit 味 |
| `digital` | 硬起音脉冲，设备提示音 |
| `wood` | 低频敲击，不刺耳 |

每套保持同一语义：完成上行、中断下行、出错低频双响、提问高音催问。

顶部选的是全局默认。某类事件要单配：点该行音色名（默认「跟随全局 ▾」）展开面板选，点「跟随全局」还原。

## 自定义音效

音色为「自定义」的行会出现「上传」按钮：

- 支持 **WAV / MP3 / M4A / AAC**，单文件 ≤ 5 MB；WAV 走 `SoundPlayer`，其它走 WPF `MediaPlayer`（借系统解码器）
- 存 `~/.dsh/dsh-notify-chime-sounds/<kind>.wav`，卸载插件不丢
- 上传后该行切到「自定义」，其它事件的音色不变；没传的类仍用内置音效
- 上传即生效，可直接点「试听」确认

## 配置初值

`cordis.patch.yml` 的 `config` 只是初值；设置页保存过的项以设置文件为准。

```yaml
- id: dsh-notify-chime
  config:
    enabled: true
    soundset: default
    minIntervalMs: 700
    includeSubagents: false
    kinds:
      finished: true
      interrupted: true
      error: true
      question: true
      approval: true
      plan-review: true
      goal-blocked: true
      job-failed: true
    toast: { enabled: true, kinds: [question], includeSession: true }
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关初值。`false` 时插件照常加载，设置页仍可用 |
| `soundset` | `default` | 全局音色：`default` / `soft` / `chime` / `retro` / `digital` / `wood` / `custom` |
| `minIntervalMs` | `700` | 同类事件最小间隔，防连响 |
| `includeSubagents` | `false` | 是否也为子会话发声 |
| `quietCurrent` | `false` | 正在查看的那个会话完成时不发声（只影响完成，审批/提问/出错照响） |
| `kinds.<kind>` | `true` | 该类事件是否发声 |
| `sounds.<kind>` | 内置 wav | 单类音效路径；`false` 或 `null` 表示不响 |
| `player` | `auto` | `auto` / `powershell` / `pwsh` / `wpf` / `none` / 播放器路径。`auto` 时 wav 用 `SoundPlayer`、其它格式用 WPF `MediaPlayer` |
| `questionTools` | `["ask_user_question"]` | 只决定谁触发 `question` 音。`exit_plan_mode` 固定归 `plan-review`，想静音它请关 `kinds.plan-review` |
| `toast.enabled` | `false` | 是否弹系统通知（本包初值为 `true`） |
| `toast.kinds` | `null` | 只对哪些 kind 弹，`null` 为全部 |
| `toast.title` | `DeepSeek Harness` | 通知标题前缀，最长 60 字符 |
| `toast.includeSession` | `true` | 正文附带会话标题 |
| `toast.appId` | `com.deepseek.dsh` | Windows AppUserModelID，须为已注册 ID |
| `traceFile` | `null` | 调试用，每次触发追加一行 JSON |

相对路径按插件目录解析，未知字段直接报错。

单类音效也可以在 patch 里写死：

```yaml
- id: dsh-notify-chime
  config:
    sounds:
      finished: C:/Windows/Media/Windows Print complete.wav
      error: false
```

## 系统通知

Windows 走 WinRT Toast，macOS 用 `osascript`，Linux 用 `notify-send`。

`appId` 必须是系统已注册的 AppUserModelID，否则只进通知中心、不弹横幅。默认 `com.deepseek.dsh` 是 DSH 桌面版注册的 ID。

进了通知中心却没横幅时：

```powershell
python tools/check-notifications.py 6
Get-ChildItem "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings" | Where-Object PSChildName -match "deepseek"
node tools/try.mjs toast
```

再查系统「设置 → 系统 → 通知」里该来源的开关与勿扰模式。

## 调试

```powershell
node tools/try.mjs all        # 试听四种音效
node tools/try.mjs toast      # 试弹通知
node tools/smoke-test.mjs     # 契约冒烟，临时目录里跑，不碰真实设置、不发声
node tools/smoke-test.mjs --verbose
```

查「刚才到底响没响」：patch 里给 `traceFile` 指个路径，每次触发追加一行 JSON。默认不配就不落文件。

## 停用

- 暂停：设置页总开关，插件照常加载。
- 卸载：`dsh plugin remove dsh-notify-chime`，设置文件可留可删。

## 限制

- 监听会话日志的追加流，冷启动打开历史会话不补响。
- 每次提醒 spawn 独立子进程播放，不阻塞 Host。PowerShell 冷启动约 200 ms，延迟约 0.3 s。
- 无音量调节，跟随系统默认播放设备；默认设备是虚拟声卡时人耳可能听不到。
- 自定义音效支持 WAV / MP3 / M4A / AAC；WMA、FLAC 不支持（系统虽有解码器，但没有接）。
- 目录：`lib/`（宿主）、`client.js`（设置页）、`assets/`（音效）、`tools/`（脚本）。

## 音效来源

`assets/` 下全部 WAV 由 `tools/make_sounds.py` 合成（正弦叠加 + 指数包络），无第三方采样素材，随包以 MIT 分发。

```powershell
python tools/make_sounds.py          # 全部重生成
python tools/make_sounds.py chime    # 只重生成一套
```

`default` 套的合成参数与浮点运算顺序保持不变，重跑后哈希不变。
