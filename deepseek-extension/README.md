# ZeroScript Free — DeepSeek × Roblox Studio Agent

Turn **chat.deepseek.com** into an agent that **builds inside Roblox Studio for you**. The
browser extension drives DeepSeek right in the page; a small **local WebSocket bridge** runs
the Roblox Studio tools and feeds the result back. Cleaner than a terminal, and designed so
**DeepSeek always gets an output** (success *or* a formatted error) — the agentic loop never
gets stuck.

```
┌──────────────┐   drives the page   ┌────────────────────────┐
│ Extension    │ ◄─────────────────► │ chat.deepseek.com      │
│  content.js  │                     └────────────────────────┘
│  background  │   ws://127.0.0.1    ┌────────────────────────┐   Roblox Studio MCP
│  (worker) ───┼────────17613───────►│   bridge.py            │──► (mcp.bat → Studio plugin)
└──────────────┘                     └────────────────────────┘
```

> This is the **DeepSeek build**. It is a sibling of the Kimi build in `../edge-extension` and
> shares the **exact same `bridge.py`** — the bridge is site-agnostic and accepts many clients
> at once, so you can run the Kimi and DeepSeek extensions side by side against one bridge.

## What DeepSeek can do
Everything the **Roblox Studio MCP** exposes, for example: read & edit scripts, run Luau
(`execute_luau`), inspect the game tree and instances, capture the Studio viewport, generate
meshes / materials / models, browse the creator store, and control play-testing — all inside
the user's open Roblox Studio place. Any MCP server added to `config.json` is aggregated
automatically.

## 🖼️ Captures sent to DeepSeek
When a tool returns an image (e.g. a viewport capture), the extension shows it to **you** in the
panel and makes a **best-effort** attempt to attach it into the composer. DeepSeek's image
support is more limited than Kimi's, so if the attach can't complete, the loop continues and
tells DeepSeek that the image was shown to the user but it cannot see it — nothing hangs.

## Installation

### 1. The bridge (shared with the Kimi build)
```powershell
pip install websockets
python "C:\SideProjects\ZeroSript Free\bridge.py"
```
- The bridge reads `config.json` (next to `bridge.py`) and launches the Roblox Studio MCP.
- Open **Roblox Studio** (with the MCP plugin enabled) so the tools become available.
- If you already run the bridge for the Kimi build, **do not start a second one** — the same
  bridge on port `17613` serves both.

`config.json` (source of truth for MCP servers):
```json
{
  "mcpServers": {
    "roblox": { "command": "cmd.exe", "args": ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"] }
  }
}
```
> The bridge automatically wraps `npx`/`npm`/`yarn`/`pnpm` in `cmd.exe /c` on Windows, so any
> node-based MCP server you add will "just work".

### 2. The extension
1. Edge → `edge://extensions` (or Chrome → `chrome://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → choose the `deepseek-extension` folder
4. Open **https://chat.deepseek.com** — the **ZeroScript Free** panel appears at the bottom right.

You can load both `edge-extension` (Kimi) and `deepseek-extension` (DeepSeek) at the same time;
each only runs on its own site.

## Usage
- The panel **dot**: green = bridge + Roblox ready · yellow = bridge OK but Studio down · grey =
  bridge offline.
- Click **▶ Start session** once (it injects the system prompt, camouflaged as "Starting Up").
  The button is disabled until the bridge and Studio are ready, and the panel tells you what is
  missing.
- Type your request in DeepSeek. The agent loops on its own and drives Roblox Studio.
- Once a session is active the Start button becomes **⟳ New session** — only use it after a
  context limit, so you never start two sessions in the same chat by accident.
- **■ Stop** interrupts the loop at any time.

> **Tip:** ZeroScript forces **Expert** + **DeepThink (R1)** before startup, and disables
> **Search** if DeepSeek exposes it. In Expert mode the Search toggle currently disappears,
> which is expected.

## Robustness — what's covered
DeepSeek always receives a usable response:

| Case | Behaviour |
|------|-----------|
| Malformed tool JSON / text around it | error message → DeepSeek retries cleanly |
| Multiple tools in one response | "one at a time" error |
| Unknown tool name | error listing the valid tools |
| Tool throws | the exact error is sent back to DeepSeek |
| Tool timeout | timeout message → DeepSeek adapts; **hard watchdog** on the extension side |
| **Roblox MCP dies** | auto-restart on the next call; the failing call is retried once |
| Bridge offline | clear message to DeepSeek + banner to the user |
| **"server is busy"** | detected → auto-retry after a short delay |
| **Context limit (silent)** | detected (text, modals, empty replies, editor gone) → banner + Stop |
| **"generating" flag stuck** | falls back to text stability → the loop never freezes |
| Empty response | one auto-retry, then a banner if it persists |
| DeepSeek page reload / chat switch | **session restored** per-conversation (no useless re-injection) |
| Message sent by mouse / loop ended | **auto-resume watchdog** picks the tool call back up |

## DeepSeek-specific notes
- **Input is a `<textarea>`** (not a contenteditable): the extension sets its value through the
  native setter + an input event, then clicks the primary send button.
- **"generating" detection** keys off the primary footer button: it renders a `<rect>` (stop
  square) while streaming and a `<path>` (send arrow) when idle.
- **DeepThink/R1 reasoning** lives in `.ds-think-content`; the loop reads only the real answer
  (`.ds-markdown` outside that container), so tool blocks drafted inside reasoning are ignored.
- **Virtualized message list** (`.ds-virtual-list`): the session is tracked **per conversation
  (URL path)** so a system-prompt turn scrolling out of the virtual window never flips the
  session off or causes a re-injection.

## ♥ Support
ZeroScript is free. If it saved you time, you can tip the developer on **Ko-fi** (the ♥ button
in the panel and the extension popup).

## Settings
- Port: `ZS_BRIDGE_PORT` (env) on the bridge **and** `PORT` in `background.js` (+ `WS_PORT` in `config.js`).
- MCP servers: `config.json`.
- DeepSeek DOM selectors: `SELECTORS` in `config.js` (hashed CSS-module classes like the user
  modifier `userMod` are one-liners to update if DeepSeek redeploys).
- Ko-fi link: `KOFI_URL` in `content.js` and `popup.js`.

## Files
- `bridge.py` — shared WebSocket server + **MCP router** (per-server lock, auto-restart, id-matching, timeouts).
- `config.json` — MCP servers (roblox by default).
- `manifest.json` — MV3 declaration (matches `chat.deepseek.com`).
- `config.js` — system prompt, selectors, regexes, messages, tool categories.
- `background.js` — service worker: resilient WebSocket (reconnect, heartbeat, timeouts, health).
- `content.js` — agentic loop, parsing, onboarding, themed tool chips, camouflage, Stop, limit detection.
- `overlay.css` — in-page UI (panel, themed chips, expandable bodies).
- `popup.html` / `popup.js` — status + reconnect / restart + tip.
