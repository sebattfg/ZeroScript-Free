// config.js — shared constants for content.js (same isolated world).
// Kept free of `window`/`document` so background.js could importScripts() it too.
// eslint-disable-next-line no-unused-vars
const ZS = (() => {
  const WS_PORT = 17613;

  // Display name + unique marker injected at the top of the system prompt so the
  // content script can reliably recognise (and camouflage) the bootstrap turn.
  const APP_NAME = "ZeroScript";
  const SYS_MARKER = "⟦ZS-SYS⟧";

  // DOM selectors for kimi.com. Grouped so a future site tweak is a one-liner.
  const SELECTORS = {
    // K2.6: one logical turn = one .chat-content-item (with a role modifier
    // class). .segment-content-box is per-SEGMENT and gets re-rendered/duplicated
    // during streaming, so we never rely on it for counting or reading.
    chatItem: ".chat-content-item",
    assistant: ".chat-content-item-assistant",
    user: ".chat-content-item-user",
    box: ".segment-content-box",
    editor: "div[contenteditable='true']",
    thinking: ".thinking-container",
    markdown: ".markdown",
    // "still generating" indicators (any match => Kimi is streaming).
    // On K2.6 the send control becomes <div class="send-button-container ... stop">
    // while generating; that is the primary, reliable signal.
    generating:
      '.send-button-container.stop,[class*="generating"],' +
      '[class*="loading-dot"],[class*="cursor-blink"],[class*="streaming"]',
    // native stop-generation control we can click to abort Kimi (a div, not a button)
    stopBtn: '.send-button-container.stop, [aria-label*="stop" i]',
    // surfaces where Kimi shows errors / limit modals / toasts
    errorSurfaces:
      '[class*="error"],[class*="alert"],[class*="warning"],[class*="modal"],' +
      '[class*="toast"],[class*="limit"]',
    // composer image-attachment area (Kimi is multimodal — we paste captures here)
    attachArea: ".chat-editor-attachment-area",
    imageThumb: ".image-thumbnail",
  };

  // Error / state regexes.
  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|d\\u00e9pass\\u00e9)",
        "session.{0,20}(expired|expir\\u00e9e)",
        "please.{0,30}(start|cr\\u00e9er).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "message.{0,20}too.{0,10}long",
        "maximum.{0,20}context",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation with kimi is getting too long/i,
    busy: /system is currently busy|please try again/i,
  };

  // ── Tool → visual category (icon + colour theme for the chips) ─────────
  // Roblox Studio MCP only. Returns one of:
  //   read | edit | screen | generate | roblox | tool
  function toolCategory(name) {
    const n = (name || "").includes("/") ? name.split("/").pop() : (name || "");
    if (n === "list_tools") return "read";
    if (/^(script_read|script_search|script_grep|search_game_tree|inspect_instance|get_studio_state|get_console_output|search_creator_store|list_roblox_studios)$/.test(n))
      return "read";
    if (/^(multi_edit|insert_from_creator_store|store_image)$/.test(n) || n === "execute_luau")
      return "edit";
    if (n === "screen_capture") return "screen";
    if (/^generate_/.test(n)) return "generate";
    if (n.startsWith("roblox") || /studio|luau|instance|workspace/i.test(n)) return "roblox";
    return "tool";
  }

  // Feedback strings sent back to Kimi so it can self-correct.
  const FEEDBACK = {
    parseError:
      "ERROR: your ###MCP_TOOL### block was detected but its content could not be parsed. " +
      "Check that the JSON inside the block is valid and that ###END_MCP_TOOL### is present. " +
      "You may include a brief explanation before or after the block, but the block itself " +
      "must be correctly formatted. Please retry.",
    multiTool: (names) =>
      "ERROR: You sent multiple tool calls in one response. Call ONE tool at a " +
      "time and wait for its result before the next. You tried: " +
      names.join(", ") +
      ". Start over and call only the first tool you need.",
    unknownTool: (name, valid) =>
      `ERROR: unknown tool "${name}". It does not exist. Valid tools are: ` +
      valid.join(", ") +
      ". Use an exact name and argument keys from the system prompt.",
    bridgeOffline:
      "ERROR: the local ZeroScript bridge is unreachable, so no tool could run. " +
      "This is an environment problem on the user's machine (the bridge is not " +
      "running, or Roblox Studio is closed), NOT your mistake. Tell the user in " +
      "one short sentence that the bridge or Roblox Studio is offline, then stop " +
      "calling tools until they confirm it is back.",
    emptyRetry:
      "(System note: your previous response arrived empty — nothing was sent. " +
      "Please continue from where you were.)",
    continue: "Continue.",
  };

  const BT = "```";

  function compactTools(tools) {
    return (tools || [])
      .map((t) => {
        const name = t.name || "?";
        const desc = (t.description || "").split("\n")[0].trim();
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const args = Object.keys(props).join(", ");
        return `  ${name}(${args}) — ${desc}`;
      })
      .join("\n");
  }

  function buildSystemPrompt(tools) {
    const toolsString = "  list_tools() — list all available Roblox Studio tools with full parameter details\n" + compactTools(tools);
    return `${SYS_MARKER}
CONTEXT:
A browser extension (ZeroScript) is running inside this page. It watches your responses. When it detects a tool call in your text, it executes it on the user's Roblox Studio and sends the result back as the next message. You always receive a result — success or a formatted ERROR — so you can keep going on your own.

Through these tools you can read and edit scripts, run Luau code, inspect the game tree and instances, capture the Studio viewport, generate meshes/materials/models, browse the creator store, and control play-testing — all inside the user's open Roblox Studio place. You do not need any special capability — you just write text. The extension does the rest.

CRITICAL — DO NOT use any of your OWN built-in tools (web search, browsing, databases, code interpreter, image generation, etc.). They are useless here and waste time. ONLY use the ZeroScript tools listed below, in the exact text format described. The ONLY exception is if the user EXPLICITLY asks you to search the web or use a built-in capability. By default, everything you do must go through the ZeroScript tools to act on Roblox Studio.

━━━ STANDARD TOOL FORMAT (all tools except execute_luau) ━━━
Write the JSON object directly in your response — no wrapper needed:
${BT}json
{
  "tool": "tool_name",
  "arguments": {"arg": "value"}
}
${BT}

━━━ SPECIAL FORMAT FOR execute_luau ━━━
Because Lua code contains " characters that break JSON encoding, use this format:
###LUA###
-- your Lua code here, no escaping, no JSON wrapping
local x = "any string with quotes works fine"
return "result"
###END_LUA###

AVAILABLE TOOLS (these are the ONLY valid tools — use exact names and argument keys):
${toolsString}

RULES:
- ONE tool block per response. Never two.
- If you need multiple tools, call them one at a time and wait for each result.
- You may write a brief note before or after a tool block when it helps clarify your intent — keep it short.
- Wait for the result, then call the next tool or write your final answer.
- Final answers: plain text only, no Markdown, no code fences.
- Never invent tool names. Only use the tools listed above.
- NEVER use your own built-in tools (web search, browsing, databases, code interpreter, etc.). Use ONLY the ZeroScript tools above — unless the user explicitly asks you to search/browse.
- execute_luau: use \`return\` to get output (NOT \`print()\`). Always use the ###LUA### / ###END_LUA### markers. CRITICAL: write exactly ###LUA### with three hashes on each side — never ###LUA--- with dashes.
- If you receive an ERROR, read it and adapt: fix the call, try another tool, or tell the user plainly if it is an environment problem (Studio closed, bridge offline).

IMPORTANT: Your very first action is to call \`list_tools\` (no arguments) so you have the full tool reference with parameter details. After receiving the result, reply with exactly one short sentence confirming you are ready, then wait for the user's first request.`;
  }

  return {
    WS_PORT,
    APP_NAME,
    SYS_MARKER,
    SELECTORS,
    RE,
    FEEDBACK,
    toolCategory,
    buildSystemPrompt,
    compactTools,
  };
})();
