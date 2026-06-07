# ZeroScript Free — DeepSeek × Roblox Studio Agent

Turn **DeepSeek** into an agent that **builds inside Roblox Studio for you**. The browser extension drives DeepSeek right in the page; a small **local WebSocket bridge** runs Roblox Studio tools and feeds the result back.

**Clean**, robust, and designed so **DeepSeek always gets an output** — the agentic loop never gets stuck.

```
┌──────────────────────────────┐   reads your page   ┌──────────────────┐
│ Extension (content script)    │◄────────────────────│ DeepSeek (chat)  │
│ ↓                             │    ws://127.0.0.1   │                  │
│ Detects your commands         │    :17613    ┌──────└──────────────────┘
│ & injects results             │    ↓         │
└──────────────────────────────┘  Bridge.py    │
                                   │            │
                                   └────────────┘
                                  Roblox Studio
                                   (MCP plugin)
```

## What DeepSeek can do

Everything the **Roblox Studio MCP** exposes:
- **Read & edit scripts** — `script_read`, `multi_edit`, `script_search`, `script_grep`
- **Run Luau code** — `execute_luau` with synchronous output
- **Inspect the game** — game tree, instances, properties, Studio state
- **Capture the viewport** — see what you're building as DeepSeek works
- **Generate assets** — meshes, materials, procedural models
- **Browse the creator store** — `search_creator_store`, insert models
- **Control play-testing** — `start_stop_play`, teleport the character

All inside the user's open Roblox Studio place. No terminal. No context switching.

## Multimodal — DeepSeek sees captures

When a tool returns an image (e.g., a viewport capture), the extension **pastes it into the composer automatically** and sends it with the message — DeepSeek **actually sees the image** and can analyze it.

## Installation

### 1. Start the bridge (one-time setup)

The bridge is a Python script (~460 lines, fully open source) that routes WebSocket messages to Roblox Studio's MCP.

**On Windows:**
1. Download the [latest release](https://github.com/your-username/zeroscript-free/releases)
2. Unzip the folder
3. Double-click `start.bat`
   - It finds Python, installs the `websockets` library (once), and runs the bridge
   - The window stays open so you can see what's happening
   - Nothing is hidden — the full `bridge.py` is right there to read

**On macOS/Linux:**
```bash
pip install websockets
python bridge.py
```

The bridge reads `config.json` (which points to your Roblox Studio MCP plugin) and launches it.

### 2. Install the extension

1. Download the [release zip](https://github.com/your-username/zeroscript-free/releases) (includes `deepseek-extension/`)
2. **Chrome / Chromium:**
   - Go to `chrome://extensions`
   - Enable **Developer mode** (top right)
   - **Load unpacked** → select the `deepseek-extension` folder
3. **Edge:**
   - Go to `edge://extensions`
   - Enable **Developer mode** (bottom left)
   - **Load unpacked** → select the `deepseek-extension` folder

### 3. Open Roblox Studio (required)

Start Roblox Studio with the MCP plugin enabled (it comes pre-installed on Windows via the launcher).

### 4. Go to DeepSeek and start building

1. Open **https://chat.deepseek.com**
2. A **ZeroScript panel** appears at the bottom right
3. The panel **dot** tells you the status:
   - **Green**: bridge + Roblox Studio ready ✓
   - **Yellow**: bridge OK, but Studio is closed
   - **Grey**: bridge offline
4. When both are green, click **▶ Start session** once
   - This injects the system prompt camouflaged as a "startup message"
   - DeepSeek loads the full command reference automatically
5. Type your request. DeepSeek loops on its own and drives Studio.
6. Once the session is active, **⟳ New session** appears — use it after a context limit.
7. **■ Stop** interrupts the loop anytime.

## Robustness — what's covered

| Case | Behaviour |
|------|-----------|
| Malformed command JSON | Error message → DeepSeek retries cleanly |
| Multiple commands in one reply | "One at a time" error with the command names |
| Unknown command | Error listing valid commands (never silent failure) |
| Command throws | The exact error is sent back to DeepSeek |
| Command timeout | Timeout message → DeepSeek adapts |
| Roblox MCP dies | Auto-restart on the next call; the call is retried once |
| Bridge offline | Clear error to DeepSeek + banner to the user |
| Context limit hit | Auto-detected (text, modals, editor gone) → banner + Stop |
| "Generating" stuck | Falls back to text stability → loop never freezes |
| Empty response | One auto-retry, then a banner if it persists |
| Page reload | Session restored from the DOM (no re-injection needed) |
| Message sent by mouse / loop ended | Auto-resume watchdog picks the tool call back up |

**Key design principle**: DeepSeek always receives a usable response — success *or* a structured error. The agentic loop never hangs silently.

## Configuration

### Port
- **Bridge**: `ZS_BRIDGE_PORT` environment variable (default: `17613`)
- **Extension**: `WS_PORT` in `deepseek-extension/config.js`

Both must match.

### MCP servers
Edit `config.json` next to `bridge.py`:
```json
{
  "mcpServers": {
    "roblox": {
      "command": "cmd.exe",
      "args": ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"]
    }
  }
}
```

On Windows, the bridge automatically wraps `npx`/`npm`/`yarn`/`pnpm` in `cmd.exe /c`, so any Node-based MCP server "just works".

### Extension details
- **DeepSeek DOM selectors**: `SELECTORS` in `deepseek-extension/config.js`
- **Error detection patterns**: `RE` object in `config.js` (English + French)
- **Tool visual categories**: `toolCategory()` function
- **Feedback strings**: `FEEDBACK` object

## How it works

1. **content.js** runs inside https://chat.deepseek.com and watches your messages
2. When it detects a ZeroScript command (JSON in a code block), it sends it to the **background service worker**
3. **background.js** forwards the command over WebSocket to the local bridge
4. **bridge.py** routes the command to the Roblox Studio MCP (spawned as a stdio subprocess)
5. The MCP executes the command and returns a result (text + optional images)
6. The bridge sends it back to the extension
7. **content.js** injects the result into the chat as the next message from the system
8. DeepSeek reads the result and continues

**Per-server locking** ensures slow MCP servers don't block others. **Auto-restart** on death. **ID-matched JSON-RPC** so responses never race.

## Files

- **bridge.py** — WebSocket server + MCP router (per-server lock, auto-restart, id-matching, timeouts)
- **config.json** — MCP servers configuration
- **start.bat** — Windows launcher (checks Python, installs websockets, runs bridge)
- **deepseek-extension/manifest.json** — MV3 declaration + permissions
- **deepseek-extension/config.js** — System prompt, DOM selectors, error regexes, UI messages
- **deepseek-extension/background.js** — Service worker: resilient WebSocket (reconnect, heartbeat, timeouts, health)
- **deepseek-extension/content.js** — Agentic loop, command parsing, onboarding, UI injection, Stop, limit detection
- **deepseek-extension/overlay.css** — In-page UI (panel, themed chips, collapsible bodies)
- **deepseek-extension/popup.html** / **popup.js** — Status, reconnect, restart, Ko-fi link

## Support

ZeroScript is free. If it saved you time, you can tip the developer:
- **Ko-fi**: Link in the extension popup and panel

## Security & transparency

- **Bridge is open source** — read the full 460 lines of `bridge.py`, no hidden downloads
- **Extension code is visible** — inspect `content.js`, `background.js` etc. in the browser DevTools
- **No telemetry** — no external requests except to Roblox Studio (MCP) and DeepSeek
- **Local only** — commands run on your machine, in your Studio

## Why not just use the Roblox Studio terminal?

- **UI clutter** — terminal windows, multiple clicks, context switching
- **No multimodal** — can't see Studio captures, pass them to DeepSeek automatically
- **Manual loop** — you copy-paste results, don't get an agentic loop
- **Harder onboarding** — "download a bat, run it in a terminal, go to this URL" vs. "install extension, click Start"

## Limitations

- **Synchronous Luau only** — `execute_luau` does NOT support yields (`wait()`, `task.wait()`, `:Wait()`, etc.). Set up delays via Script instances instead.
- **DeepSeek's built-in features disabled** — web search, browsing, file connectors are not available (they break the flow). Use ZeroScript commands only, unless the user explicitly asks to search.
- **One command at a time** — DeepSeek must write one command per reply and wait for the result.
- **Image upload limited** — DeepSeek's image API support is basic; if image attachment doesn't work, the tool still runs (just without the image).

## License

MIT

## Contributing

If you find a bug or want to improve the extension:
1. Fork the repo
2. Create a feature branch
3. Test with the unpacked extension
4. Submit a pull request

---

**Get started:** Download the latest [release](https://github.com/your-username/zeroscript-free/releases), unzip, double-click `start.bat`, install the extension, open DeepSeek. 🚀
