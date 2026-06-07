# ZeroScript Free - Roblox Studio AI Agent

Control **Roblox Studio** with AI directly from your browser.
ZeroScript connects **DeepSeek** to your Studio through a small local Bridge. Just describe what you want to build and the agent does the rest.

## How it works

```
DeepSeek (browser) -> ZeroScript Extension -> Bridge (your PC) -> Roblox Studio
```

The extension runs inside DeepSeek's chat page. When you type a request, it sends commands to the Bridge running on your PC, which drives Roblox Studio through the MCP plugin.

## Setup

### 1. Download the zip and install the extension
Download the latest zip from the **Releases** page and extract it.
The zip contains both the **Bridge** and the **extension folder**.

To load the extension:
1. Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `zeroscript-extension` folder from the extracted zip

### 2. Start Roblox Studio
Open Studio and load a Place before starting the Bridge.

### 3. Run the Bridge
Double-click **start.bat** inside the extracted folder.
A small window opens, that means the Bridge is running.

### 4. Start a session
Go to **https://chat.deepseek.com** and open a new chat.
The ZeroScript panel appears at the bottom right. Click **Start session**.
Type what you want to build.

> Only works on **chat.deepseek.com** - it will not work on any other site.

📺 [Watch the setup tutorial](https://youtu.be/nh0iVPi2BC8)

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
- Roblox Studio with the MCP plugin installed
- Microsoft Edge or Chrome
- Python 3.8+ (included in start.bat setup)

## Support

ZeroScript is free. If it saves you time:
☕ [Ko-fi](https://ko-fi.com/sebattfg) - Robux tip passes available in the extension panel
