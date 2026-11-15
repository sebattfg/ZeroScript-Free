# Repair messages

When a reply cannot be turned into a runnable command, the controller sends it
back to the AI as a **repair turn** instead of guessing. These strings live in
`ZS.FEEDBACK` (`extension/core/config.js`); this file documents them so they can
be reviewed and translated.

| Key | When it is sent | Text |
|---|---|---|
| `malformed` | A command was detected but its JSON did not parse. | `ERROR: a NonZeroScript command was detected in your reply, but its JSON could not be parsed, so nothing ran. Rewrite it as ONE valid JSON object in plain text, exactly like {"command": "name", "params": { ... }}. For a long script put the path in JSON and the code in a ###GDSCRIPT### ... ###END_GDSCRIPT### block (GDScript) or a ###CSHARP### ... ###END_CSHARP### block (C#). Please retry.` |
| `unclosed` | The JSON object was cut off before it closed. | `ERROR: your command was cut off before it finished - the JSON object never closed. Rewrite the WHOLE command as one valid JSON object, exactly like {"command": "name", "params": { ... }}. … Please retry.` |
| `unclosedCode` | A `###GDSCRIPT###` / `###CSHARP###` block has no end marker. | `ERROR: your code block was never closed, so the code was not written. End it with ###END_GDSCRIPT### (GDScript) or ###END_CSHARP### (C#) and retry.` |
| `envelope` | Parameters were sent as a bare object without `command`/`params`. | `ERROR: you wrote parameters as a bare JSON object without the command envelope, so nothing ran. Wrap them like {"command": "name", "params": { ... }} - the keys go INSIDE "params". Please retry.` |
| `toolKey` | The command key was `tool`, `name`, `function`, `action`, … | `ERROR: you used the wrong key to name the command. The key must be exactly "command" … Please retry.` |
| `multiple` | More than one command in a single reply. | `ERROR: you wrote more than one command in one reply. Send ONE command at a time and wait for its result before the next. Please retry with only the first command.` |
| `dsml` | The site leaked its internal tool-call markup into the reply. | `ERROR: your reply contains internal tool-call markup instead of a NonZeroScript command. Write a plain JSON object …` |
| `unknownTool` | The command name is not in the catalogue. | `ERROR: unknown command "…". Valid commands are: … Use an exact name and parameter keys from the system prompt.` |
| `editorOffline` | No editor plugin is connected to the controller. | `ERROR: the editor plugin is not connected to the controller, so the command could not run. … Tell the user in one short sentence to open their project (for Godot 4.7.2: enable the NonZeroScript plugin) and then stop and wait.` |
| `controllerOffline` | The relay itself is unreachable from the page. | `ERROR: the local NonZeroScript controller is unreachable. Tell the user in one short sentence to start the controller, then stop and wait.` |
| `truncated` | The AI's reply hit the site's length limit. | `(System note: your previous reply was cut off by a length limit before you finished. Continue from exactly where you stopped. Do NOT restart and do NOT repeat what you already wrote.)` |
| `taskDone` | The task finished cleanly. | `Task finished.` |

## How a repair turn flows

1. The extension parses the reply (`ZSParse.parseToolCalls`) and classifies the
   failure (`ZSParse.diagnose` → one of the keys above).
2. It reports `parseError` + `feedback` to the controller instead of a command.
3. The controller queues that feedback as the next turn — possibly on a
   **different browser**, which is why the memory brief is prepended.
4. Repair turns are counted separately (`task.repairs`) and shown in the console
   so a model that keeps failing is visible instead of looping silently.

## Related guard: block language vs path

`ZSParse.codeLanguageWarning()` runs before a write is sent. If the code block
is `###CSHARP###` but the path ends in `.gd` (or the reverse), the page bar shows
a warning and the console log records it. The write still goes through — the AI
is expected to correct itself on the next turn.
