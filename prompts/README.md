# prompts — every instruction the AI is given

This folder is the human-readable home of the instructions NonZeroScript sends
to the AI, and of the instructions the AI is expected to follow. Nothing here is
loaded at runtime: the browser extension holds the live copies in
`extension/core/config.js`, the command catalogue is served from
`controller/tools.json`, and both are wired together by `systemPrompt()`.

| File | What it is | Used by |
|---|---|---|
| [`system-prompt.md`](system-prompt.md) | The full system prompt template, with `{{PLACEHOLDERS}}` for the parts filled at runtime. | `ZS.systemPrompt()` in `extension/core/config.js` |
| [`agent-rules.md`](agent-rules.md) | The same rules distilled into a checklist (one command per reply, code blocks, inspections, repairs, when to finish). | Human reference + drift check |
| [`tool-catalogue.md`](tool-catalogue.md) | Every command, parameter and description. **Generated** from `controller/tools.json`. | `ZS.compactTools()` in the prompt, `/api/tools`, the console tester |
| [`repair-messages.md`](repair-messages.md) | The error strings sent back when a reply cannot be parsed, so the AI can self-correct. | `ZS.FEEDBACK` in `extension/core/config.js` |

## Keeping it in sync

The single sources of truth are `controller/tools.json` (commands) and
`extension/core/config.js` (prompt text and repair messages). Regenerate the
catalogue and check for drift after changing either:

```bash
python3 tools/prompts.py           # rewrite prompts/tool-catalogue.md
python3 tools/prompts.py --check   # exit 1 if the catalogue or a rule drifted
```

`--check` verifies three things:

1. `prompts/tool-catalogue.md` matches `controller/tools.json` (names, params,
   descriptions, order).
2. Every rule marker in `agent-rules.md` still exists in `config.js` — so a
   rule cannot be edited in one place and silently lost in the other.
3. `config.js` exposes the three code-block languages the docs promise
   (`###GDSCRIPT###`, `###CSHARP###`, legacy `###LUA###`).

## Why a folder instead of code comments

- The AI instructions are part of the product: they are reviewable, diffable
  and translatable without reading a 600-line JavaScript file.
- Users can copy `agent-rules.md` into a custom prompt (`操控台 → 追加给 AI 的
  自定义指令`) without digging through the extension.
- Adapter authors can see exactly which behaviour the prompt expects from the
  editor plugin — see [`../editor/PROTOCOL.md`](../editor/PROTOCOL.md).
