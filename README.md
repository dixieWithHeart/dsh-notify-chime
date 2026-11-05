# dsh-notify-chime（提示音）

回合**完成 / 中断 / 出错 / Agent 提问**时播放音效，提问可另弹 Windows 通知。

| 场景 | kind | 默认音效 |
| --- | --- | --- |
| 回合正常结束 | `finished` | 上行三音 |
| 中断（停止、归档、取消） | `interrupted` | 下行两音 |
| 出错结束 | `error` | 低频双响 |
| Agent 提问（等回答 / 等批计划） | `question` | 三声高音 + 系统通知 |

应用退出、会话分叉、被阻断，以及默认被过滤掉的 subagent 会话不发声。

## 安装

```powershell
dsh plugin add dsh-notify-chime
```

包自带 `cordis.patch.yml`，装完自动插入宿主行，不用手改 profile。刷新页面后在「设置 → 提示音」里调。

## 配置

设置页写入 `~/.dsh/dsh-notify-chime.json`，保存即生效。要改启动默认值，在 profile 的 `cordis.patch.yml` 用同一 id 覆盖：

```yaml
- id: dsh-notify-chime
  config:
    minIntervalMs: 700
    includeSubagents: false
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时不发声，插件照常加载，设置页可用 |
| `minIntervalMs` | `700` | 同类事件最小间隔，防连响 |
| `includeSubagents` | `false` | 是否也为子会话发声 |
| `player` | `auto` | `auto` / `powershell` / `pwsh` / `none` / 播放器路径 |
| `sounds.<kind>` | 内置 wav | 各事件音效；`false` 或 `null` 表示不响 |
| `questionTools` | `["ask_user_question", "exit_plan_mode"]` | 视为提问的工具名 |
| `toast.enabled` | `false` | 是否弹系统通知 |
| `toast.kinds` | `null` | 只对哪些 kind 弹，`null` 为全部 |
| `toast.title` | `DeepSeek Harness` | 通知标题前缀 |
| `toast.includeSession` | `true` | 正文附带会话标题 |
| `toast.appId` | `com.deepseek.dsh` | Windows AppUserModelID，须为已注册 ID |
| `traceFile` | `null` | 调试用，每次触发追加一行 JSON |

相对路径按插件目录解析。未知字段直接报错。

## 换音效

```yaml
- id: dsh-notify-chime
  config:
    sounds:
      finished: C:/Windows/Media/Windows Print complete.wav
      error: false
```

也可以用 `tools/make_sounds.py` 改音高重新生成（只需 Python，无第三方依赖）。

## 系统通知（Toast）

```yaml
- id: dsh-notify-chime
  config:
    toast:
      enabled: true
      kinds: [question]
```

Windows 走 WinRT Toast，macOS 用 `osascript`，Linux 用 `notify-send`。

`appId` 必须是系统已注册的 AppUserModelID（开始菜单里有同名快捷方式）。随便取名也能发出去、也会进通知中心，但不会弹横幅。默认 `com.deepseek.dsh` 是 DSH 桌面版注册的 ID。

通知进了中心却不弹横幅时：

```powershell
python tools/check-notifications.py 6   # 看有没有送达
Get-ChildItem "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings" | Where-Object PSChildName -match "deepseek"
node tools/try.mjs toast                 # 手动弹一条
```

再查系统「设置 → 系统 → 通知」里该来源的开关与勿扰模式。

## 调试

```powershell
node tools/try.mjs all      # 试听四种音效
node tools/try.mjs toast    # 试弹通知
node tools/smoke-test.mjs   # 投递合成事件，打印分类结果
```

要看「刚才到底响没响」，在 profile 覆盖里给 `traceFile` 指个路径。默认不配就不落文件。

## 停用

- 静音：用设置页开关。`enabled: false` 只是不发声，插件照常加载。
- 卸载：`dsh plugin remove dsh-notify-chime`。设置文件 `~/.dsh/dsh-notify-chime.json` 可留可删。

## 限制

- 监听会话日志的追加流，冷启动打开历史会话不会补响。
- 每次提醒 spawn 独立子进程播放，不阻塞 Host。PowerShell 冷启动约 200 ms，延迟约 0.3 s。
- 声音走系统默认播放设备。默认设备是虚拟声卡时，人耳可能听不到。
- 目录：`lib/`（宿主）、`client.js`（设置页）、`assets/`（音效）、`tools/`（脚本）。
