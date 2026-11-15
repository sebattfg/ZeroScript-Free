# editor — editor plugins

Each subfolder is a self-contained plugin for one engine version. The build
script reads `build.json` inside a folder and packages the folder's contents at
the `target` path, so the zip can be extracted straight into a project.

```
editor/
  godot-4.7.2/          Godot editor plugin
    plugin.cfg
    plugin.gd           EditorPlugin entry point
    core/bridge.gd      HTTP poller to the controller
    core/commands.gd    28 file/scene/project commands
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
- **Results are compact.** The controller truncates long results before they go
  back to the AI; the plugin caps reads at 4 MB and 5000 lines by default.

## Adding another engine folder

Create `editor/<engine>/`, include a `build.json`:

```json
{ "artifact": "editor-godot-4.8", "target": "addons/nonzeroscript" }
```

and run `python3 tools/build.py`. One artifact is produced per folder, as
required by the release scripts.

## Notes for 4.7.2

- Uses the `EditorInterface` singleton (available in 4.x), `EditorPlugin`,
  `EditorUndoRedoManager`, `EditorFileSystem`, `PackedScene` and `HTTPRequest`.
- `play_custom_scene` and `get_open_scenes` are feature-detected; older 4.x
  builds degrade to playing the main scene.
- The editor log is read from `user://logs/godot.log` (fallbacks checked under
  the Godot data/config dirs). It only exists after the project has been run at
  least once, which is why `get_editor_log` reports `available: false` until
  then.
