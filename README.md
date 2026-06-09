# ZeroScript - Free AI Agent for Roblox Studio

![GitHub stars](https://img.shields.io/github/stars/sebattfg/ZeroScript-Free?style=social)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-blue)

**ZeroScript** is a free browser extension that turns DeepSeek into a Roblox Studio AI agent.
Control Roblox Studio with AI directly from your browser - read/edit scripts, run Luau, generate assets, all from chat.deepseek.com. No terminal needed.

> *Also known as: ZeroScript Roblox, ZeroScript free download, Roblox DeepSeek agent, Roblox Studio AI automation, Luau AI, MCP Roblox*
## How it works

```
DeepSeek (browser) -> ZeroScript Extension -> Bridge (your PC) -> Roblox Studio
```

The extension runs inside DeepSeek's chat page. When you type a request, it sends commands to the Bridge running on your PC, which drives Roblox Shtudio through thebuilt-in MCP server.

## Setup

> 📺 **Lost? Watch the [setup tutorial on YouTube](https://youtu.be/QaViHSqzy5Q) it covers every step below.**

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

> Not sure where to find these options? The [video tutorial](https://youtu.be/QaViHSqzy5Q) shows exactly where to click.

### 3. Run the Bridge

Double-click `start.bat` inside the extracted folder. A small window opens, that means the Bridge is running.

### 4. Start a session

Go to https://chat.deepseek.com and open a new chat. The ZeroScript panel appears at the bottom right. Click **Start session**. Type what you want to build.

> Only works on chat.deepseek.com - it will not work on any other site.
### 5. Watch the setup tutorial

[Watch the setup tutorial on YouTube](https://youtu.be/QaViHSqzy5Q)

## What the AI can do

- Read and edit scripts
- Run Luau code directly in Studio
- Inspect the game tree and instances
- Generate meshes, materials, and models
- Browse and insert from the Creator Store
- Control play-testing

## Panel status

| Dot | Meaning |
|-----|---------|
| Green | Bridge + Studio ready |
| Yellow | Bridge OK - open Roblox Studio |
| Grey | Bridge offline - run start.bat |

## Requirements

- Windows PC
- Roblox Studio (MCP support built-in)
- Microsoft Edge or Chrome
- Python 3.8+ (included in start.bat setup)

## Support

ZeroScript is free. If it saves you time: [Ko-fi](https://ko-fi.com/sebattfg) - Robux tip passes available in the extension panel
