# Agent rules (checklist)

The short version of `system-prompt.md`: what the AI must do, why, and what the
controller enforces when it does not. The drift check in
`tools/prompts.py --check` keeps these rules from diverging from
`extension/core/config.js`.

## 1. One command per reply

- A reply is either **one** JSON command, or a **finish** (plain text, no JSON).
- Two commands in one reply ⇒ the controller reports `multiple` and nothing runs.
- The JSON shape is always `{"command": "...", "params": {...}}`. `tool` /
  `arguments` is accepted as a legacy alias; nothing else is.

## 2. Code goes in a block, not in JSON

| Language | File | Block |
|---|---|---|
| GDScript | `.gd` | `###GDSCRIPT### … ###END_GDSCRIPT###` |
| C# | `.cs` | `###CSHARP### … ###END_CSHARP###` |

- The block is written verbatim; the block language must match the extension.
  A mismatch shows a warning in the page bar and is logged.
- `write_file` / `write_files` write it; `edit_file` patches existing files with
  a **literal** search string (no regex).
- Legacy `###LUA###` markers still parse, but the AI is told never to use them.

## 3. Inspect before editing

1. `get_editor_state` — project, open scene, connected plugin, `csharp`, `dotnet`.
2. `list_files` / `search_in_files` / `read_file` — what already exists.
3. `get_scene_tree` / `get_node_info` — before touching nodes.
4. Only then `write_file`, `edit_file`, `add_node`, `attach_script`, …

## 4. Language choice

- Default to GDScript.
- C# only when the environment says `C# available: yes` **and** the project is a
  .NET project (`.csproj`/`.sln`), or the human asked for C# explicitly.
- Never create a `.cs` file in a project without a C# solution: the plugin
  returns a warning pointing at *Project → Tools → C# → Create C# solution*.

## 5. Results and repair

- Every command returns either a result or `ERROR: ...`.
- On `ERROR`, fix the call and retry, or explain the blocker in one sentence and
  finish. Never repeat the same failing call.
- Parse failures come back as a `repair` turn with one of the messages in
  [`repair-messages.md`](repair-messages.md).
- Never invent a result and never claim a change that was not confirmed.

## 6. When to finish

- The task is done and verified (files exist, scene opens, game runs).
- Or you genuinely need a decision only the human can make.
- A finish is plain text with no JSON. The controller returns control to the
  queue.

## 7. Safety boundaries (enforced by the plugin)

- Only `res://` and `user://`; absolute paths and `..` escapes are rejected.
- `.git`, `.godot`, `project.godot` and the plugin itself are protected.
- Folder deletion needs `recursive=true`.
- Writes can be turned off entirely in the plugin dock; scene edits are undoable.
