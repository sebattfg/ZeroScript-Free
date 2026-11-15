# editor — editor adapters

NonZeroScript is **multi-editor**: the browser extension and the controller only
speak the small bridge protocol in [`PROTOCOL.md`](PROTOCOL.md). Every editor
gets one folder here, and the build script packages one artifact per folder.

| Editor | Folder | Languages | Status |
|---|---|---|---|
| **Godot 4.7.2** | `godot-4.7.2/` | GDScript, C# | shipped, 29 commands |
| Unity | — | C# | planned (protocol only) |
| Unreal Engine | — | C++, Blueprint | planned (protocol only) |

"Planned" means the protocol can express it, not that a plugin exists. Only list
an editor here once its folder does something real.

Each subfolder is self-contained. The build script reads `build.json` inside a
folder and packages the folder's contents at the `target` path, so the zip can
be extracted straight into a project.

```
editor/
  PROTOCOL.md           editor-agnostic bridge contract (read this to add an engine)
  godot-4.7.2/          Godot editor plugin
    plugin.cfg
    plugin.gd           EditorPlugin entry point
    core/bridge.gd      HTTP poller to the controller
    core/commands.gd    29 file/scene/project/script commands
    ui/dock.gd          status dock (connection, URL, write toggle, log)
    build.json          artifact name + install target
```

## Install (Godot 4.7.2)

Copy the folder so the project contains:

```
your_project/
  addons/
    nonzeroscript/
      plugin.cfg
      plugin.gd
      core/
      ui/
```

Then **Project → Project Settings → Plugins → NonZeroScript → Enable**.

The dock appears on the right. It shows `● 已连接` when the controller is
running at the URL in the box (`http://127.0.0.1:8790` by default) and the
project is open. **允许 AI 写入 / 修改场景** can be unchecked to make the plugin
read-only; the setting is stored in `user://nonzeroscript_editor.cfg`.

## GDScript and C#

Scripts can be `.gd` or `.cs`. The file extension decides the language; the
plugin never rewrites one into the other.

- `write_file` / `write_files` write `.cs` exactly like `.gd`, and `edit_file`
  patches either one.
- `attach_script {path, script_path}` — plus the `script_path` parameter of
  `add_node` and `create_scene` — loads the script and sets it on the node
  through `EditorUndoRedoManager`, so Ctrl+Z undoes the attachment.
- `get_editor_state` reports `csharp` (the running Godot binary has .NET
  support), `dotnet` (a `.sln`/`.csproj` exists in the project) and
  `script_extensions` (`["gd", "cs"]`). The browser AI reads these before it
  picks a language.
- `search_in_files` searches `cs` by default, and `run_project` adds a build
  note (or a warning when a project has `.cs` files but the editor cannot
  compile them).
- C# needs the **.NET build** of Godot 4.7.2. On the standard build a `.cs`
  file is still written but the result carries a `warning`, and `attach_script`
  refuses to load it with an explicit error instead of failing silently.
- A `.cs` write into a project without a `.csproj`/`.sln` also returns a
  `warning` pointing at **Project → Tools → C# → Create C# solution**, so the
  file is not silently dead.
- Godot compiles C# itself; the plugin never shells out to `dotnet`. If scripts
  are missing at play time, run **Build** in the MSBuild panel — the
  `run_project` result says so too.

## Design

- **Outbound polling only.** The plugin POSTs `/api/editor/poll` every ~0.4 s.
  It never listens on a port, so no firewall prompt and no inbound surface.
- **One command at a time.** Commands run on the editor main thread; results are
  POSTed back with the request id. A long command (run project, big scan) just
  delays the next poll.
- **Undoable scene edits.** `add_node`, `remove_node`, `set_node_property`,
  `instantiate_scene` go through `EditorUndoRedoManager`, so Ctrl+Z works.
- **Project writes are rescanned.** After writing files the plugin calls
  `EditorFileSystem.scan()`, so new scripts/scenes appear immediately.
- **Path safety.** Only `res://` and `user://`; absolute paths and `..` escapes
  are rejected. `.git`, `.godot`, `res://addons/nonzeroscript` and
  `project.godot` are protected from generic writes/deletes.
- **Language-agnostic file ops.** `.gd` and `.cs` travel through the same
  write/edit/attach path; only `attach_script` and `get_editor_state` care about
  the language, and they ask Godot rather than guessing.
- **Results are compact.** The controller truncates long results before they go
  back to the AI; the plugin caps reads at 4 MB and 5000 lines by default.

## Adding another editor

1. Read [`PROTOCOL.md`](PROTOCOL.md) — two POST endpoints and one status body.
2. Create `editor/<engine>/` and implement them (outbound polling only, one
   command at a time, your own path safety and write toggle).
3. Add a `build.json`:

   ```json
   { "artifact": "editor-unity", "target": "Assets/NonZeroScript" }
   ```

4. Run `python3 tools/build.py`. One artifact is produced per folder.
5. Describe the commands in `controller/tools.json`; the prompt picks them up
   automatically, the extension never needs a change.
6. Add the editor to the table above and to the **Supported adapters** table in
   `PROTOCOL.md`.

## Notes for 4.7.2

- Uses the `EditorInterface` singleton (available in 4.x), `EditorPlugin`,
  `EditorUndoRedoManager`, `EditorFileSystem`, `PackedScene` and `HTTPRequest`.
- `play_custom_scene` and `get_open_scenes` are feature-detected; older 4.x
  builds degrade to playing the main scene.
- The editor log is read from `user://logs/godot.log` (fallbacks checked under
  the Godot data/config dirs). It only exists after the project has been run at
  least once, which is why `get_editor_log` reports `available: false` until
  then.
