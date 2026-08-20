# ZeroScript - Free AI Agent for Roblox Studio

![GitHub stars](https://img.shields.io/github/stars/sebattfg/ZeroScript-Free?style=social)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)
![License](https://img.shields.io/badge/license-GPL--3.0-blue)

**ZeroScript** is a free browser extension that turns ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena or Meta AI into a Roblox Studio AI agent.
Control Roblox Studio with AI directly from your browser - read/edit scripts, run Luau, generate assets, all from a normal AI chat. No API key, no terminal, no coding needed.

> 🌐 **Website: [zerodev.tools/zeroscript](https://zerodev.tools/zeroscript)** the free Lemonade.gg / Luamotion alternative for building Roblox games with AI.

Eight AI providers are supported: **DeepSeek** (chat.deepseek.com, recommended), **ChatGPT** (chatgpt.com), **Google Gemini** (gemini.google.com), **Kimi** (kimi.ai, Moonshot AI), **GLM** (chat.z.ai, Z.ai), **Qwen** (chat.qwen.ai), **Arena** (arena.ai, a multi-model playground) and **Meta AI** (meta.ai). On ChatGPT, screenshots and image input are turned off on purpose: the free tier limits files and images on a separate quota from messages, so vision would only work part of the day. Gemini and Kimi can be unstable: Gemini tends to stop using the Roblox tools in long sessions, and Kimi sometimes uses its own native tools instead of the Roblox commands. On Arena, use **Direct** mode (ZeroScript only supports Direct; it blocks Start in Battle / Side-by-Side / Agent modes). DeepSeek is the recommended provider.

> 💬 **Stuck? Join the [Discord community](https://discord.gg/9aNyZsMWcb)** get help, share feedback, and follow updates.

> *Also known as: ZeroScript Roblox, ZeroScript free download, Roblox ChatGPT agent, Roblox DeepSeek agent, Roblox Gemini agent, Roblox Kimi agent, Roblox GLM agent, Roblox Qwen agent, Roblox Arena agent, Roblox Meta AI agent, Roblox Studio AI automation, Luau AI, MCP Roblox, lemonade alternative free, lemonade.gg alternative, free Roblox AI agent, free lemonade roblox alternative*

## ⚠️ ZeroScript is Free Beware of Paid Copycats

ZeroScript is 100% free and open-source. It always has been, and it always will be. There is no official paid version, no subscription, and no sign-in required to use the extension.

If you come across a site or extension using the ZeroScript name that asks for payment or account creation, it is **not** this project. The only official links are the ones listed at the top of this README.

## How it works

```
AI chat (ChatGPT / DeepSeek / Gemini / Kimi / GLM / Qwen / Arena / Meta AI, in your browser) -> ZeroScript Extension -> Bridge (your PC) -> Roblox Studio
```

The extension runs inside the chat page (ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena or Meta AI). When you type a request, it sends commands to the Bridge running on your PC, which drives Roblox Studio through the built-in MCP server.

## Setup

> 📺 **Lost? Watch the [setup tutorial on YouTube](https://youtu.be/kPKiZLZ9_Ps) it covers every step below.**

### 1. Download the zip and install the extension

Download the latest zip from the **Releases** page and extract it. The zip contains both the **Bridge** and the **extension folder**.

To load the extension:

- Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
- Enable **Developer mode** (top right toggle)
- Click **Load unpacked**
- Select the `zeroscript-extension` folder from the extracted zip

### 2. Start Roblox Studio and enable MCP

Open Studio and load a Place, then enable MCP (first time only):

- Click **Assistant AI** in the top bar
- Click **...** (top right of the Assistant panel)
- Click **Manage MCP Servers**
- Click **Enable Studio as MCP Server**

> Not sure where to find these options? The [video tutorial](https://youtu.be/kPKiZLZ9_Ps) shows exactly where to click.

### 3. Run the Bridge

- **Windows:** double-click `start.bat` inside the extracted folder.
- **macOS:** double-click `MacOS_Start.command` inside the extracted folder. The first time, macOS will show a security warning ("could not verify... free of malware") - this is normal for any script downloaded outside the App Store, click **Done**, then go to **System Settings > Privacy & Security**, scroll to the bottom, and click **Open Anyway**. You only need to do this once.

A small window opens, that means the Bridge is running.

### 4. Start a session

Go to https://chat.deepseek.com (recommended), https://chatgpt.com, https://gemini.google.com, https://www.kimi.ai, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai or https://www.meta.ai and open a new chat. The ZeroScript bar appears above the input box. Click **Start session**. Type what you want to build.

> Only works on chat.deepseek.com, chatgpt.com, gemini.google.com, www.kimi.ai (or kimi.com), chat.z.ai, chat.qwen.ai, arena.ai and meta.ai - it will not work on any other site.
> On Arena, keep the mode dropdown on **Direct** - ZeroScript blocks Start in Battle / Side-by-Side / Agent modes (it only drives a single Direct reply).
> Gemini and Kimi can be unstable (model behavior, not the extension): Gemini may stop using the Roblox tools after a while, and Kimi may use its own native tools instead. If the AI starts answering in plain text instead of acting, remind it to use the commands or start a new session.
### 5. Watch the setup tutorial

[Watch the setup tutorial on YouTube](https://youtu.be/kPKiZLZ9_Ps)

## What the AI can do

- Read and edit scripts
- Run Luau code directly in Studio
- Inspect the game tree and instances
- Generate meshes, materials, and models
- Browse and insert from the Creator Store
- Control play-testing
- **Remember your project across sessions** persistent project memory saved inside your place

## New in 1.5.2

- **ChatGPT: you can chat normally again without starting an agent.** On a blank ChatGPT tab the extension refused to let a message send until you clicked "Start Roblox agent" every other provider only suggests it, ChatGPT was the odd one out.
- **ChatGPT: it no longer forgets it can actually run commands.** ChatGPT summarises its own context mid-session and the first thing it drops is the *mechanism* it then tells you "I can't invoke those commands in this session" while the extension sits there, ready. Its instructions are now re-stated automatically, carried along on a tool result so they cost no extra message and stay hidden from you (a "Reminder" chip marks them). Tool results are never shortened to make room.
- **ChatGPT: an image you send is now used as reference for the work**, instead of being answered with a freshly generated picture. Ask explicitly if you *do* want an image.
- **A finished command is no longer stranded as "not run"** after a long reply (seen on Qwen writing for 400s and more), where the agent used to give up eight seconds after the model stopped.
- **A clear message when ZeroScript updates while a tab is open.** This used to be reported as "the bridge stopped on your PC run start.bat", sending you to fix something that was never broken. It now tells you the page needs reloading and offers a Reload button.
- **The AI no longer insists your bridge is offline without checking** it must run a command first before saying so.

## New in 1.5.1

- **ChatGPT support (chatgpt.com)** an eighth provider. Screenshots and image input are off there on purpose: ChatGPT's free tier limits files and images on a separate quota from messages, so vision would only work part of the day. The model picker and reasoning mode stay entirely your choice.
- **ChatGPT: fixed most tool calls failing.** ChatGPT renders code blocks with an editor that keeps no line breaks in the page, so a perfectly valid command was read as one giant line and came back as "your code block was empty". Replies are now read with their real line structure.
- **ChatGPT: fixed long commands running truncated.** Past roughly 2000-4000 characters the page only shows *part* of a long line and then stops updating, so a big command executed cut off (the tool chip's token count would climb, fall back to ~500, and freeze). ZeroScript now reads the editor's true content instead of what's drawn on screen a 5.3k-token `multi_edit` applies whole.
- **ChatGPT: fixed the raw command text staying visible** when the model wrote it outside a code block.
- **Meta AI: fixed big commands failing with "bad JSON".** Meta shows a JSON block in an interactive viewer that *shortens* large values - a 19k-character `multi_edit` appeared in the page as 223 characters ending in `"edits":[1 item]`, so the command was read truncated and rejected. This is also what made the tool chip's token counter collapse to ~44 tokens when the block finished rendering. Commands are now read from the viewer's Raw tab, in full.
- **Clearer message when Roblox refuses to parse your Luau.** ZeroScript used to always blame an empty code block or a wrong `###LUA###` marker, even when a full script had been sent - so the model "fixed" something that wasn't broken and failed again. It now says how many characters were sent and names the real causes: invalid syntax, or code too large for the parser.
- **Fixed a stylesheet error that silently disabled command hiding on GLM, Kimi, Qwen, Arena and Meta AI.**

## New in 1.5.0

- **Backgrounding the AI tab no longer strands a command as "not run":** the response watcher now pauses while the tab is hidden and shifts every deadline forward by the time it was paused, instead of burning its inactivity timeout off-screen. The bar shows a **Paused** state while waiting, and resuming is instant (event-driven, not polled).
- **Gemini: fixed the page freezing on a large tool result** (e.g. a big `http_get`) - outgoing text is now capped and the composer insert yields periodically so the page stays responsive and Stop stays clickable.
- **Gemini: fixed the system prompt occasionally never leaving the composer on Start**, caused by the wedged-stop-button detector refusing its own first recovery attempt.
- **Kimi: fixed the model picker looping open/closed** after Kimi's K3 update removed the model it used to default to. The native-agent guard now also correctly detects **K3 Swarm**.
- **Degraded mode (Roblox Studio closed) starts much faster:** the tool catalogue is now cached briefly instead of being re-fetched (and re-timing-out) three times in a row during boot.

See [CHANGELOG.md](CHANGELOG.md) for older releases.

## Panel status

| Dot | Meaning |
|-----|---------|
| Green | Bridge + Studio ready (a place is open) |
| Yellow | Bridge OK, but Studio isn't usable yet - open Roblox Studio, load a place, or enable its MCP server (hover the dot for the exact reason) |
| Grey | Bridge offline - run start.bat (Windows) or MacOS_Start.command (macOS) |

## Requirements

- Windows or macOS
- Roblox Studio (MCP support built-in)
- Microsoft Edge or Chrome
- Python 3.9+ (installed automatically on Windows, or install it yourself on macOS - see [python.org/downloads](https://www.python.org/downloads/))

## Support

ZeroScript is free. If it saves you time: [Ko-fi](https://ko-fi.com/sebattfg) - Robux tip passes available in the extension panel

---

Credit: the idea for connecting other MCP servers (Blender, Sketchfab, etc.) alongside Roblox Studio came from [javnpa](https://github.com/javnpa).

Credit: macOS/Linux support contributed by [archivealf](https://github.com/archivealf).
