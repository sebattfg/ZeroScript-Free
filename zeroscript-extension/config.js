// config.js - shared constants for content.js (same isolated world).
// Kept free of `window`/`document` so background.js could importScripts() it too.
// This is the DeepSeek build (chat.deepseek.com). The Kimi build lives in
// ../edge-extension and is left untouched.
// eslint-disable-next-line no-unused-vars
const ZS = (() => {
  const WS_PORT = 17613; // same local bridge as the Kimi build (the bridge accepts many clients)

  // Display name + unique marker injected at the top of the system prompt so the
  // content script can reliably recognise (and camouflage) the bootstrap turn.
  const APP_NAME = "ZeroScript";
  const SYS_MARKER = "⟦ZS-SYS⟧";

  // DOM selectors for chat.deepseek.com. Grouped so a future site tweak is a
  // one-liner. DeepSeek ships hashed CSS-module class names (e.g. `d29f3d7d`);
  // where possible we lean on its stable design-system "ds-" classes instead.
  const SELECTORS = {
    // One logical turn = one .ds-message. The user-turn variant carries an extra
    // hashed modifier class (userMod) and a `.fbb737a4` bubble; the assistant
    // turn carries a `.ds-markdown` body. content.js classifies with isUser()
    // (multi-signal) rather than trusting a single fragile class.
    chatItem: ".ds-message",
    userMod: "d29f3d7d", // hashed modifier on user turns (one-liner to update if DeepSeek redeploys)
    userBubble: ".fbb737a4", // user text bubble (secondary signal)
    assistant: ".ds-message:not(.d29f3d7d)",
    user: ".ds-message.d29f3d7d",
    box: ".ds-markdown",
    editor: "textarea", // DeepSeek uses a real <textarea>, NOT a contenteditable
    // DeepSeek renders its DeepThink/R1 reasoning inside .ds-think-content. The
    // real answer is a .ds-markdown OUTSIDE that container.
    thinking: ".ds-think-content",
    markdown: ".ds-markdown",
    // The send/stop control: a single primary footer button. While generating it
    // shows a <rect> (stop square); idle it shows a <path> (send arrow). The
    // <rect> test lives in content.js isGenerating(); .ds-loading covers the
    // brief spin-up before the first token. (CSS-only fallback signal here.)
    generating: ".ds-loading",
    sendBtn: ".ds-button--primary",
    stopBtn: ".ds-button--primary",
    // surfaces where DeepSeek shows errors / limit modals / toasts
    errorSurfaces:
      '[class*="ds-toast"],[class*="toast"],[class*="error"],[class*="alert"],' +
      '[class*="warning"],[class*="modal"],[role="alert"]',
    // composer image-attachment area (best-effort; DeepSeek's image support is
    // limited, so the attach path degrades gracefully if these don't match).
    attachArea: ".ds-file-list, [class*='file-preview'], [class*='upload']",
    imageThumb: "[class*='thumbnail'], [class*='file-item']",
    // ── Composer mode controls (empty chat only) ──────────────────────────
    // A blank conversation shows a [role=radiogroup] with two [role=radio]
    // options: "Rapide" (fast, default) and "Expert" (better results). We force
    // Expert. The "Pensée profonde / Réflexion" DeepThink toggle is a single
    // .ds-toggle-button below the textarea; we force it on and hide it so it can
    // never be turned off. (Validated live.)
    modeRadioGroup: '[role="radiogroup"]',
    modeRadio: '[role="radio"]',
    deepThinkToggle: ".ds-toggle-button",
  };

  // Error / state regexes (English + French - DeepSeek's UI follows the locale).
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
        "this conversation has reached",
        "cette conversation a atteint",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    // DeepSeek very frequently shows "The server is busy. Please try again later."
    busy: /server is busy|serveur est occup|please try again|réessayer plus tard|system is currently busy/i,
    // DeepSeek truncates long outputs and shows a "Continue" button to resume the
    // SAME turn. We match it by (visible) button text - locale-robust.
    continueBtn: /^(continue|continuer|继续(生成)?|fortfahren|continuar|seguir|続行)$/i,
    // Per-turn "halted" marker DeepSeek renders INSIDE a stopped turn (manual stop
    // or an interrupted generation). Used to tell "actively reasoning" apart from
    // "stopped" without relying on the global footer Continue button.
    stopped: /(arrêté|arrété|stopped|已停止|停止生成|已暂停)/i,
    // Composer mode labels. "Expert" is the same token in FR/EN, so it is the
    // reliable anchor: we select the Expert radio and hide every OTHER radio.
    expertMode: /expert|专家|专业/i,
    // The DeepThink toggle's label across locales ("Pensée profonde" FR,
    // "DeepThink"/"Deep Thinking" EN, "Réflexion (approfondie)", 深度思考).
    deepThink: /pensée profonde|pensee profonde|profonde|réflexion|reflexion|deep ?think|深度思考|r1/i,
    // Search/browsing toggle. It is visible in "Rapide" and disappears in
    // "Expert" (validated live), so absence is OK after Expert is selected.
    searchMode: /recherche intelligente|smart search|search|web|搜索/i,
    // DeepSeek's "New chat" button label (top of the sidebar). Used by the panel's
    // "New session" action to open a FRESH conversation before injecting the
    // system prompt - matched as the WHOLE trimmed text so a history item titled
    // "Nouvelle conversation" (which links to an existing chat) is told apart by
    // the caller (no href + an icon + near the top).
    newChat: /^(nouvelle conversation|new chat|new conversation|开启新对话|新对话)$/i,
  };

  // ── Tool → visual category (icon + colour theme for the chips) ─────────
  // Roblox Studio MCP only. Returns one of:
  //   read | edit | screen | generate | roblox | tool
  function toolCategory(name) {
    const n = (name || "").includes("/") ? name.split("/").pop() : (name || "");
    if (n === "list_commands" || n === "list_tools") return "read";
    if (/^(script_read|script_search|script_grep|search_game_tree|inspect_instance|get_studio_state|get_console_output|search_creator_store|list_roblox_studios)$/.test(n))
      return "read";
    if (/^(multi_edit|insert_from_creator_store|store_image)$/.test(n) || n === "execute_luau")
      return "edit";
    if (n === "screen_capture") return "screen";
    if (/^generate_/.test(n)) return "generate";
    if (n.startsWith("roblox") || /studio|luau|instance|workspace/i.test(n)) return "roblox";
    return "tool";
  }

  // Feedback strings sent back to DeepSeek so it can self-correct.
  const FEEDBACK = {
    parseError:
      "ERROR: a ZeroScript command was detected in your reply but its JSON could not be parsed. " +
      'Write a single valid JSON object as plain text, exactly like {"command": "name", "params": {...}} ' +
      "(or use the ###LUA### / ###END_LUA### block for execute_luau). You may add a short note around it. " +
      "Please retry.",
    multiTool: (names) =>
      "ERROR: You wrote multiple commands in one reply. Write ONE command at a " +
      "time and wait for its result before the next. You tried: " +
      names.join(", ") +
      ". Start over and write only the first command you need.",
    unknownTool: (name, valid) =>
      `ERROR: unknown command "${name}". It does not exist. Valid commands are: ` +
      valid.join(", ") +
      ". Use an exact name and parameter keys from the system prompt.",
    bridgeOffline:
      "ERROR: the local ZeroScript bridge is unreachable, so no command could run. " +
      "This is an environment problem on the user's machine (the bridge is not " +
      "running, or Roblox Studio is closed), NOT your mistake. Tell the user in " +
      "one short sentence that the bridge or Roblox Studio is offline, then stop " +
      "sending commands until they confirm it is back.",
    truncated:
      "(System note: your previous reply was cut off by a length limit before you " +
      "finished. Continue from exactly where you stopped. Do NOT restart and do " +
      "NOT repeat what you already wrote.)",
    continue: "(System note: the server was busy; nothing was lost. Please continue from where you stopped.)",
  };

  const BT = "```";

  function compactTools(tools) {
    return (tools || [])
      .map((t) => {
        const name = t.name || "?";
        const desc = (t.description || "").split("\n")[0].trim();
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const args = Object.keys(props).join(", ");
        return `  ${name}(${args}) - ${desc}`;
      })
      .join("\n");
  }

  function buildSystemPrompt(tools) {
    const toolsString = "  list_commands() - list all available Roblox Studio commands with full parameter details\n" + compactTools(tools);
    return `${SYS_MARKER}
CONTEXT:
A browser extension (ZeroScript) is running inside this page. It watches your replies. When it detects a ZeroScript command in your text, it runs it on the user's Roblox Studio and sends the result back as the next message. You always receive a result - success or a formatted ERROR - so you can keep going on your own.

Through these commands you can read and edit scripts, run Luau code, inspect the game tree and instances, capture the Studio viewport, generate meshes/materials/models, browse the creator store, and control play-testing - all inside the user's open Roblox Studio place. You do not need any special capability - you just write text. The extension does the rest.

CRITICAL - these ZeroScript commands are NOT function calls / tools. They are plain JSON you TYPE into your normal text reply; ZeroScript reads your text and runs them. So:
- DO NOT use DeepSeek's own built-in features (the "Search"/web-search toggle, browsing, file/web connectors, etc.). They are useless here and break the flow. The ONLY exception is if the user EXPLICITLY asks you to search the web. Internal reasoning (DeepThink) is fine.
- DO NOT try to "call a function" or emit a real tool call. Just write the JSON shown below as ordinary text.
- NEVER use a code sandbox or pretend to run code - not even to reason about, test, or draft a script. The only code you can run is Luau, via the execute_luau command. Think in plain text, then write Luau.

⚠️ FORMATTING RULE (MANDATORY - read carefully):
ALWAYS put your command inside a fenced code block (triple backticks). NEVER write a command
as inline/normal text. This page renders normal text as Markdown, which turns things like
\`Instance.new\` or \`part.Name\` into clickable links and reformats the ### markers - that
silently CORRUPTS your command so it cannot run. Inside a code block the text is kept exactly
as you typed it. One command = one fenced code block.

━━━ STANDARD COMMAND FORMAT (everything except execute_luau) ━━━
Write this JSON object inside a fenced code block:
${BT}json
{
  "command": "command_name",
  "params": {"key": "value"}
}
${BT}

━━━ SPECIAL FORMAT FOR execute_luau ━━━
Because Lua code contains " characters that break JSON encoding, use this format instead.
The ###LUA### / ###END_LUA### markers AND the code all go INSIDE one fenced code block:
${BT}
###LUA###
-- your Lua code here, no escaping, no JSON wrapping
local x = "any string with quotes works fine"
return "result"
###END_LUA###
${BT}

AVAILABLE COMMANDS (these are the ONLY valid commands - use exact names and parameter keys):
${toolsString}

RULES:
- ONE command block per reply. Never two.
- If you need several commands, write them one at a time and wait for each result.
- You may write a brief note before or after a command block when it clarifies your intent - keep it short.
- Wait for the result, then write the next command or your final answer.
- Final answers: plain text only, no Markdown, no code fences.
- Do ONLY what the user asked. Do NOT run extra "double-check", verification, or exploration commands they did not request. Prefer the fewest commands that get the job done.
- When the task is finished, or the user signals satisfaction (e.g. "thanks", "perfect", "nice", "ok"), reply with ONE short plain-text sentence and STOP. Do not write another command - wait for the next request.
- Never invent command names. Only use the commands listed above.
- NEVER use DeepSeek's own built-in features (web search, connectors, etc.). Use ONLY the ZeroScript commands above - unless the user explicitly asks you to search/browse.
- execute_luau: use \`return\` to get output (NOT \`print()\`). Always use the ###LUA### / ###END_LUA### markers. CRITICAL: write exactly ###LUA### with three hashes on each side - never ###LUA--- with dashes.
- execute_luau runs SYNCHRONOUSLY: NEVER use yielding/blocking calls inside it - no \`wait()\`, \`task.wait()\`, \`:Wait()\`, \`task.delay\`, \`coroutine.yield\`, \`:WaitForChild(name)\` without a 0 timeout, \`HttpService\`/\`DataStore\` calls, or any async API. A yield will hang the call forever. Do everything synchronously and return immediately; if you need a delay or an event, set it up via a Script/LocalScript instance instead.
- If you receive an ERROR, read it and adapt: fix the command, try another one, or tell the user plainly if it is an environment problem (Studio closed, bridge offline).

IMPORTANT: Your very first action is to write the \`list_commands\` command (no params) so you have the full command reference with parameter details. After receiving the result, reply with exactly one short sentence confirming you are ready, then wait for the user's first request.`;
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
