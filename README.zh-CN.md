# NonZeroScript —— 免费的 Godot 4.7.2 AI 智能体

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Godot](https://img.shields.io/badge/Godot-4.7.2-478cbf)
![License](https://img.shields.io/badge/license-GPL--3.0-blue)
![Version](https://img.shields.io/badge/version-0.1.0-6366f1)

![NonZeroScript banner](assets/banner.svg)

**NonZeroScript** 是 **[ZeroScript](https://github.com/sebattfg/ZeroScript-Free) 的官方衍生版**，把原本面向 Roblox Studio 的 ZeroScript 重做成了 **Godot 4.7.2** 版本。它让 ChatGPT、DeepSeek、Gemini、Kimi、GLM、Qwen、Meta AI、Arena 变成真正的 Godot 编辑器智能体：读写 **GDScript 或 C#**、创建场景和节点、修改项目设置、运行游戏、读取报错——全部在普通的 AI 聊天页面里完成，**不需要 API Key，也不需要命令行**。

> **官方衍生版说明**：NonZeroScript 并不是第三方魔改，而是 ZeroScript 官方针对 Godot 的衍生版本，与上游项目同步维护。本版本**不包含** Roblox Studio 集成、Roblox MCP 中转和 Roblox 专用说明；其余部分（浏览器插件的智能体循环、命令协议、永久免费承诺）都来自 ZeroScript，并继续使用 GPL-3.0 许可。

> 🌐 上游 ZeroScript：**[zerodev.tools/zeroscript](https://zerodev.tools/zeroscript)** · [github.com/sebattfg/ZeroScript-Free](https://github.com/sebattfg/ZeroScript-Free)

## 与 ZeroScript 的区别

| | ZeroScript（Roblox） | **NonZeroScript（Godot）** |
|---|---|---|
| 目标 | Roblox Studio（通过 MCP） | **Godot 4.7.2（通过编辑器插件）** |
| 操控方式 | 聊天栏 + 命令行 Bridge | **可视化操控台 + 本地中转**，不用命令行 |
| 输入节奏 | 内部固定等待 | **每次模拟输入前，在最小/最大秒数之间随机等待** |
| 浏览器 | 单标签页 | **多浏览器 AI 轮流调用**，共享时间线记忆 |
| 记忆 | Roblox 项目内记忆 | **按任务、按浏览器会话保存的时间线文件**，用于轮换时接续上下文 |
| AI 支持 | 8 家 | **8 家：ChatGPT、DeepSeek、Gemini、Kimi、GLM、Qwen、Meta AI、Arena**（ChatGPT 支持已更新） |

## 工作原理

```
 ┌─────────────────────────────┐        ┌──────────────────────────────┐
 │  浏览器（Chrome / Edge）      │        │  Godot 4.7.2 编辑器           │
 │  ChatGPT · DeepSeek · Gemini │        │  addons/nonzeroscript         │
 │  Kimi · GLM · Qwen · Meta    │        │  （文件 + 场景命令）           │
 │  Arena                       │        │                              │
 │        ▲   浏览器插件         │        │        ▲   编辑器插件          │
 └────────┼─────────────────────┘        └────────┼─────────────────────┘
          │  本机 HTTP                            │  本机 HTTP 轮询
          ▼                                       ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  controller/ —— 可视化操控台 + 本地中转 + 轮换 + 记忆                   │
 │  http://127.0.0.1:8790                                                 │
 └──────────────────────────────────────────────────────────────────────┘
```

1. **浏览器插件**运行在 AI 聊天页里：模拟输入任务 → 等待 AI 回答 → 解析出**一条**命令 → 上报给中转。
2. **中转（controller）**是一个很小的本地程序（只用 Python 标准库）：提供**可视化操控台**，决定下一回合交给哪个浏览器，把命令转发给 Godot，并写入时间线。
3. **Godot 编辑器插件**真正操作你的项目：文件、场景、节点、项目设置、试运行和日志。

全程不经过任何云端服务；网络流量只发生在浏览器、中转和 Godot 之间的 `127.0.0.1`。

## 主要功能

- **用可视化操控台代替命令行。** 双击启动脚本后自动打开浏览器里的操控台：添加任务、查看会话、浏览时间线、调整延迟和轮换设置。
- **随机输入等待时间。** 可设置最小和最大秒数（例如 2–6 秒）。**每一次**模拟输入（启动提示、任务、命令结果）之前都会在该区间随机抽取一个时间等待，并在页面状态栏显示倒计时。
- **多浏览器 AI 轮换。** 打开 3 个浏览器（或 3 个标签页），分别在页面点“启动”，之后每次 AI 调用都会轮流使用下一个就绪会话。也可以在新建任务时指定只用某一家 AI。
- **时间线记忆。** 每个浏览器里的 AI 记忆是独立的，轮换本会丢上下文。中转会把每次提示、回答、工具结果写入 `controller/data/memory/`，并在下一回合前给接手的浏览器附上一段**记忆摘要**。
- **真正可用的 Godot 工具集。** 29 个命令（GDScript 与 C#）：读写/搜索/编辑文件，查看和修改当前场景、增删节点、实例化场景、修改项目设置、运行/停止游戏、读取编辑器日志、保存截图给人类看。
- **ChatGPT 支持已更新**，同时支持 DeepSeek、Gemini、Kimi、GLM、Qwen、Meta AI、Arena。
- **完全免费开源**：GPL-3.0，无账号、无订阅、无 API Key。

## 安装（共三部分）

### 1. 中转 + 可视化操控台

- 安装 **Python 3.9 或更新版本**（[python.org/downloads](https://www.python.org/downloads/)），不需要 `pip install`，只用标准库。
- 打开 `controller` 文件夹，双击：
  - **Windows：** `start.bat`
  - **macOS：** `start.command`（首次运行请右键 → 打开，或在“系统设置 → 隐私与安全性”里允许）
  - **Linux：** `start.sh`
- 会打开一个控制台窗口，并自动在浏览器打开 **http://127.0.0.1:8790/**（可视化操控台）。

> 使用期间请保持这个窗口开启。关闭窗口就会停止中转。修改端口后需要重启。

### 2. 浏览器插件（Chrome / Edge 通用）

1. 打开 `chrome://extensions`（Chrome）或 `edge://extensions`（Edge）。
2. 开启右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择 `extension` 文件夹。
4. 建议把 NonZeroScript 固定到工具栏。

插件不需要编译，`extension` 文件夹本身就是插件。

### 3. Godot 4.7.2 编辑器插件

1. 在发布压缩包（或仓库里的 `editor/godot-4.7.2`）中找到插件，把它复制到你的 Godot 项目，使路径变成：

   ```
   your_project/
     project.godot
     addons/
       nonzeroscript/
         plugin.cfg
         plugin.gd
         core/
         ui/
   ```

2. 在 Godot 中打开 **项目 → 项目设置 → 插件**，启用 **NonZeroScript**。
3. 右侧出现 **NonZeroScript** 面板；中转启动后应显示 `● 已连接`。
4. 确认面板里的中转地址是 `http://127.0.0.1:8790`。如果你改过端口，在这里同步修改并点“应用”。

编辑器插件从不监听外部连接，只会主动向本机中转发请求。

## Godot 新手教学（第一次完整流程）

1. **创建项目。** 打开 Godot 4.7.2，新建项目（例如 `MyFirstGame`）并打开。
2. **安装插件。** 按上面的第 3 步复制 `addons/nonzeroscript`，并在“项目设置 → 插件”里启用。
3. **启动中转。** 双击 `controller/start.bat`（Windows）或 `start.command`（macOS）。操控台自动打开。
4. **连接浏览器。** 加载插件后打开 **https://chat.deepseek.com**（推荐）或任意支持的 AI，**新建对话**，点击输入框上方的 **启动**。状态栏变绿并显示“已就绪 · 等待操控台派发任务”。
5. **在操控台添加任务。** 例如：

   > 给我的项目做一个主菜单：在 `res://scenes/main_menu.tscn` 新建场景，包含标题 Label、开始按钮和退出按钮；脚本放在 `res://scripts/main_menu.gd`，让按钮真正可用，并把项目主场景设置为这个菜单。

   点击 **加入队列**。中转会把第 1 回合派给浏览器。
6. **观察执行。** 页面状态栏先显示随机等待倒计时（`等待 4.2 秒后输入…`），随后 AI 思考，聊天里出现命令卡片，Godot 面板逐条记录命令；操控台的“实时日志”和“时间线记忆”同步显示。Godot 里的文件和场景会真实发生变化。
7. **继续迭代。** 任务完成后可以再添加一个：*“加一个设置面板，带音量滑块，用 ConfigFile 保存。”* AI 会保留上下文；也可以新开对话重新点启动。

### 好用的示例任务

- *“读取 `project.godot` 和场景树，然后添加一个 CharacterBody2D `Player`，WASD 移动，带摄像机；脚本保存到 `res://scripts/player.gd`。”*
- *“找出所有 GDScript 里的 `print(`，换成 `Logger.info()`，并添加 Logger 自动加载。”*
- *“这是 .NET 项目：新建 `res://scripts/Player.cs`，CharacterBody2D + WASD 移动，挂到 Player 节点后保存。”*
- *“做一个暂停菜单（CanvasLayer），包含继续 / 重开 / 退出，绑定到 `ui_cancel`。”*
- *“运行项目，然后读编辑器日志，修复前三个脚本错误。”*
- *“把窗口大小改成 1280×720，拉伸模式改为 `canvas_items`，修改默认清屏颜色。”*

### 小提示

- **小步快跑。** 一次做一个功能；AI 会先检查再修改，每条命令在操控台里都能看到。
- **保持操控台开启。** 它也是唯一能添加任务、查看哪个浏览器在工作的地方。
- **建议 2–6 秒延迟。** 太短虽然能用，但更像机器；类人的停顿更不容易触发 AI 站点的自动输入检测。
- **v0.1.0 以文本工具为主。** 插件可以为你保存一张编辑器截图（`capture_editor_viewport`），但暂不会把截图发给 AI。

## 多浏览器轮换与记忆

可以混用浏览器、标签页和 AI：

1. Chrome 打开 DeepSeek，点 **启动**。
2. Edge 打开同一个 DeepSeek（或 ChatGPT、Gemini…），点 **启动**。
3. 操控台的“浏览器会话”里会出现两个会话，默认都勾选“轮换”。
4. 添加任务。第 1 回合给第一个就绪会话，第 2 回合给下一个，依次轮流。

由于每个标签页的聊天记忆独立，中转会在第 2 回合起附上记忆摘要：

```
MEMORY BRIEF (earlier turns of this task, newest last - possibly handled by another browser):
[TASK] 给我的项目做一个主菜单 ...
[10:31:02] Chrome · DeepSeek replied: 我先检查项目结构。
[10:31:05] tool get_editor_state -> OK: {"project_name": "MyFirstGame", ...}
Continue from the latest state. Do not repeat finished work.
```

记忆文件位于：

```
controller/data/memory/
  tasks/20261115-103000-a1b2c3d4.jsonl     # 一个任务 = 一条共享时间线
  sessions/Chrome-deepseek-9f3a2c11.jsonl   # 一个浏览器标签页 = 一条私有时间线
```

每一行都是一个带时间戳的事件。操控台里可以调整“记忆条数”，控制摘要长度。

不想让某个会话参与轮换：在操控台取消它的“轮换”勾选，或在页面点“停止”彻底脱离。

## 输入节奏设置

操控台 → **输入节奏**：

- **最小秒数 / 最大秒数** —— 随机等待区间。每次模拟输入都会重新抽取，并在页面显示倒计时。
- **最大回合** —— 单个任务的回合上限。
- **记忆条数** —— 轮换时附带的最近时间线事件数。
- **多浏览器轮换** —— 是否轮流派发。
- **追加给 AI 的自定义指令** —— 追加在系统提示末尾（代码风格、命名规范、引擎版本注意事项等）。

## 支持的 AI

| AI | 地址 | 说明 |
|---|---|---|
| **DeepSeek** | chat.deepseek.com | 推荐，速度快、工具调用稳定 |
| **ChatGPT** | chatgpt.com | 已适配新版输入框；图片输入默认关闭（免费额度限制） |
| **Google Gemini** | gemini.google.com | 长会话偶尔不再使用工具，可新开会话 |
| **Kimi** | kimi.ai | 有时会使用自己的原生工具而不用命令 |
| **GLM** | chat.z.ai | 建议 GLM-5.2；高峰期 z.ai 可能繁忙 |
| **Qwen** | chat.qwen.ai | 建议选择支持工具调用的模型 |
| **Meta AI** | meta.ai | 页面支持图片，但 v0.1.0 只发文本命令 |
| **Arena** | arena.ai | 模式必须保持 **Direct**；Battle / Side-by-side / Agent 会被阻止 |

八家共用同一套命令协议，可以自由轮换。操控台新建任务时也可以指定只用某一家。

## 页面状态栏说明

| 圆点 | 含义 |
|-----|------|
| 绿色 | 已连接中转、会话已启动、可以接任务 |
| 黄色 | 已连接但尚未启动——点 **启动** |
| 红色 | 中转离线或启动失败（看提示） |
| 闪烁 | 正在随机等待、输入或等待 AI |

## AI 可以使用的命令

| 分组 | 命令行 |
|---|---|
| 读取 | `list_tools`、`get_editor_state`、`list_files`、`read_file`、`search_in_files`、`get_scene_tree`、`get_node_info`、`get_project_settings`、`get_editor_log`、`capture_editor_viewport` |
| 文件 | `write_file`、`write_files`、`edit_file`、`create_dir`、`delete_path`、`rename_path`、`scan_filesystem` |
| 场景 | `add_node`、`attach_script`、`remove_node`、`set_node_property`、`select_nodes`、`instantiate_scene`、`open_scene`、`create_scene`、`save_scene` |
| 项目 / 运行 | `set_project_setting`、`run_project`、`stop_project` |

脚本使用显式代码块，不必塞进 JSON 转义。**GDScript** 用 `###GDSCRIPT###`，**C#** 用 `###CSHARP###`，语言由文件扩展名决定：

````
{"command": "write_file", "params": {"path": "res://scripts/player.gd"}}
###GDSCRIPT###
extends CharacterBody2D

@export var speed: float = 300.0

func _physics_process(_delta: float) -> void:
	var dir := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	velocity = dir * speed
	move_and_slide()
###END_GDSCRIPT###
````

````
{"command": "write_file", "params": {"path": "res://scripts/Player.cs"}}
###CSHARP###
using Godot;

public partial class Player : CharacterBody2D
{
    [Export] public float Speed { get; set; } = 300.0f;

    public override void _PhysicsProcess(double delta)
    {
        var dir = Input.GetVector("ui_left", "ui_right", "ui_up", "ui_down");
        Velocity = dir * Speed;
        MoveAndSlide();
    }
}
###END_CSHARP###
````

### GDScript 与 C#

两种语言都是一等公民，插件不会把一种改写成另一种。

| 项目 | GDScript | C# |
|---|---|---|
| 脚本文件 | `.gd` | `.cs` |
| 代码块 | `###GDSCRIPT### … ###END_GDSCRIPT###` | `###CSHARP### … ###END_CSHARP###` |
| Godot 版本 | 任意 4.7.2 | 必须 **.NET 版** 4.7.2 |
| 类名 | 自动 | 必须与文件名一致（`Player.cs` → `class Player`） |
| 挂脚本 | `attach_script`、`add_node.script_path` | 同样的命令 |

- `get_editor_state` 会返回 `csharp`（当前编辑器能否编译 C#）、`dotnet`（项目里是否有 `.sln`/`.csproj`）和 `language`。AI 会先读这些信息再决定用哪种语言，不会往纯 GDScript 项目里塞 `.cs`。
- 标准（非 .NET）版 Godot 里仍然可以写 `.cs` 文件，但结果会带 `warning`，`attach_script` 会直接拒绝并给出明确原因，而不是静默失败。
- C# 由 Godot 自己编译，插件不会调用 `dotnet`。运行时如果缺少脚本，请在 MSBuild 面板点 **Build**；`run_project` 的返回里也会提示。
- C# 项目需要 .NET SDK，这是 Godot 自身的要求，与 NonZeroScript 无关。

插件会拒绝 `res://`/`user://` 之外的路径，保护 `.git`、`.godot`、插件本身和 `project.godot`；删除文件夹必须显式 `recursive=true`。也可以在 Godot 面板里直接关闭“允许 AI 写入”。

## 环境要求

- **Godot 4.7.2**（插件按 4.7.2 编写；相邻 4.x 版本或许可用，但未测试）
- C# 项目另需 **Godot 4.7.2 的 .NET 版**和 .NET SDK；纯 GDScript 项目不需要
- **Chrome 或 Edge**（Chromium 111+，Edge 使用同一个插件包）
- **Python 3.9+**（中转，仅标准库）
- Windows / macOS / Linux

## 从源码构建（手动，不会自动构建）

本仓库**不包含**自动构建（没有 CI 工作流）。需要发布包时手动执行：

```bash
python3 tools/build.py
```

输出到 `dist/`：

```
dist/NonZeroScript-0.1.0.zip          # 以下全部打成一个包
dist/controller.zip                   # controller/（操控台 + 中转 + 启动脚本）
dist/extension.zip                    # extension/（Chrome/Edge 加载已解压）
dist/editor-godot-4.7.2.zip           # addons/nonzeroscript/（放进 Godot 项目）
dist/SHA256SUMS.txt
```

构建脚本只用 Python 标准库。若已安装 PyInstaller，可加 `--exe` 生成单文件控制器。

两个测试都离线运行，无需安装依赖：

```bash
python3 tools/smoke_test.py    # 启动控制器 + 假编辑器 + 两个假浏览器，
                               # 验证轮换、记忆摘要和命令执行
node tools/test_parser.js      # 解析器用例（JSON、代码块、截断、别名）
```

本仓库**故意不包含 GitHub Actions 自动构建**：不会自动编译或发布，需要发行包时手动执行上面的构建命令。

目录结构：

```
NonZeroScript/
  controller/              可视化操控台、中转、轮换、记忆（Python 标准库）
    ui/                    操控台页面（无需构建）
    tools.json             命令目录（唯一事实来源）
  extension/               Chrome/Edge MV3 插件
    core/                  与站点无关的智能体循环、解析器、传输
    providers/             每个 AI 网站一个适配器
  editor/
    godot-4.7.2/            Godot 编辑器插件（安装为 addons/nonzeroscript）
  tools/                   构建 + 冒烟测试
  assets/                  横幅与图标
```

## 常见问题

**操控台显示“Godot 未连接”。**
在 Godot 里打开项目并启用插件（项目设置 → 插件），确认面板地址与中转一致，然后点“重新连接”。

**页面显示“中转未运行”。**
先启动控制器；如果端口不同，在插件弹窗和 Godot 面板里改成同一个地址。

**8790 端口被占用。**
关闭另一个控制器，或用 `python3 main.py --port 8791` 启动，并同步修改插件和 Godot 面板里的地址。`--host 0.0.0.0` 只建议在明确的远程演示中使用，否则会把文件编辑能力暴露到局域网。

**AI 只回文字，不出命令。**
在聊天里提醒它“只发一条 NonZeroScript JSON 命令”，或新开会话。Arena 必须用 Direct 模式；Kimi、Gemini 偶尔会用自己的工具，DeepSeek 最稳定。

**任务自己结束了。**
协议是“每条回复最多一条命令”；没有命令的回复代表“任务完成或需要你决策”。操控台会显示最后的回复，继续添加任务即可。

**怎么清空记忆？**
停止控制器后删除 `controller/data/memory/`。所有设置和记忆都是本地文件，不会上传。

## 致谢与许可

NonZeroScript 以 GPL-3.0 开源，是 **ZeroScript 官方 Godot 衍生版**；面向 Roblox Studio 的上游项目仍是 ZeroScript。原始构想、智能体循环和各家 AI 适配来自 ZeroScript 作者；Godot 插件、可视化操控台、轮换和时间线记忆是本版本新增。

- 上游 ZeroScript：[github.com/sebattfg/ZeroScript-Free](https://github.com/sebattfg/ZeroScript-Free)
- 本仓库：[github.com/Moonano-MG/NonZeroScript](https://github.com/Moonano-MG/NonZeroScript)

遇到问题请附上操控台的“实时日志”和浏览器控制台输出，这两样对定位 AI 页面改版造成的 DOM 问题最有帮助。

## License

GPL-3.0-or-later，详见 [LICENSE](LICENSE)。
