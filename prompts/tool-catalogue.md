# Tool catalogue

<!-- Mirrors controller/tools.json, which is the live source. Update both together. -->

29 commands, grouped the way the system prompt presents them. `?` marks an
optional parameter; everything else is required.

## Inspect / read

| Command | Parameters |
|---|---|
| `list_tools` | — |
| `get_editor_state` | — |
| `list_files` | `path?`, `extensions?`, `recursive?`, `max_files?` |
| `read_file` | `path`, `start_line?`, `max_lines?` |
| `search_in_files` | `query`, `path?`, `regex?`, `case_sensitive?`, `include?`, `max_results?` |
| `get_editor_log` | `lines?`, `errors_only?` |
| `capture_editor_viewport` | `save_path?` |

### `list_tools`

Return this command catalogue (names, parameters and descriptions). Use it when you are unsure which command or parameter exists.

### `get_editor_state`

Report the connected Godot editor: project name and path, engine version, open scene, selected nodes, whether a project is playing, and the scripting capabilities (csharp = .NET build, dotnet = a .csproj/.sln exists, language/default).

### `list_files`

List files and folders inside the project. Filter by extension and recurse into subfolders.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | no | Folder to list. Default res:// |
| `extensions` | string | no | Comma-separated extensions to keep, e.g. gd,tscn,godot |
| `recursive` | boolean | no | Walk subfolders (default false) |
| `max_files` | integer | no | Stop after this many entries (default 400) |

### `read_file`

Read a UTF-8 text file (scripts, scenes, project.godot, .tres). Returns numbered lines so you can target edits precisely.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | res:// path of the file |
| `start_line` | integer | no | 1-based first line (default 1) |
| `max_lines` | integer | no | Maximum lines to return (default 500, max 5000) |

### `search_in_files`

Search text or a regular expression across project text files. Returns path, line number and the matching line.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Text or regex to find |
| `path` | string | no | Folder to search. Default res:// |
| `regex` | boolean | no | Treat query as a regular expression (default false) |
| `case_sensitive` | boolean | no | Default false |
| `include` | string | no | Comma-separated extensions to search, e.g. gd,cs,tscn,cfg |
| `max_results` | integer | no | Default 80 |

### `get_editor_log`

Read the tail of the Godot editor log. Use after running the game to see runtime errors.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `lines` | integer | no | Number of lines (default 120, max 1000) |
| `errors_only` | boolean | no | Only lines with errors/warnings (default false) |

### `capture_editor_viewport`

Save a PNG screenshot of the editor viewport into the project so the human can see it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `save_path` | string | no | Optional res:// png path |

## Files

| Command | Parameters |
|---|---|
| `write_file` | `path`, `content?`, `open_in_editor?` |
| `write_files` | `files`, `open_in_editor?` |
| `edit_file` | `path`, `search`, `replace`, `all?` |
| `create_dir` | `path` |
| `delete_path` | `path`, `recursive?` |
| `rename_path` | `from`, `to`, `overwrite?` |
| `scan_filesystem` | — |

### `write_file`

Create or overwrite a text file (.gd, .cs, .tscn, ...). Creates missing folders, rescans the project and can open the file in the editor. For scripts, prefer the code block instead of escaping the code in JSON: ###GDSCRIPT### for GDScript, ###CSHARP### for C#.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | res:// path to write |
| `content` | string | no | Full file content (omitted when a ###GDSCRIPT### or ###CSHARP### block follows) |
| `open_in_editor` | boolean | no | Open the file after writing (default false) |

### `write_files`

Write several text files (.gd, .cs, .tscn, .tres, ...) in one command. Each item is {path, content}. Use for scaffolding a feature in one turn.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `files` | array | yes | Array of {path, content} objects |
| `open_in_editor` | boolean | no | Open the first file after writing (default false) |

### `edit_file`

Replace an exact piece of text in a file (literal search, not regex). Safer than rewriting a whole script. Fails if the search text is missing or ambiguous unless all=true.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | res:// path |
| `search` | string | yes | Exact text to find |
| `replace` | string | yes | Replacement text |
| `all` | boolean | no | Replace every occurrence (default false = require exactly one) |

### `create_dir`

Create a folder (and parents) inside the project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | res:// folder path |

### `delete_path`

Delete a file or folder. Folders require recursive=true. Use with care.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | res:// path |
| `recursive` | boolean | no | Delete a non-empty folder (default false) |

### `rename_path`

Rename or move a file/folder inside the project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | string | yes | Current res:// path |
| `to` | string | yes | New res:// path |
| `overwrite` | boolean | no | Replace the destination if it exists (default false) |

### `scan_filesystem`

Ask the editor to rescan the project filesystem (needed after writing files outside the plugin, e.g. from git).

## Scene and scripts

| Command | Parameters |
|---|---|
| `get_scene_tree` | `max_depth?`, `include_internal?` |
| `get_node_info` | `path`, `include_properties?` |
| `set_node_property` | `path`, `property`, `value` |
| `add_node` | `parent_path`, `type`, `name?`, `properties?`, `script_path?` |
| `attach_script` | `path`, `script_path` |
| `remove_node` | `path` |
| `select_nodes` | `paths` |
| `instantiate_scene` | `scene_path`, `parent_path?`, `name?` |
| `open_scene` | `path` |
| `create_scene` | `path`, `root_type?`, `root_name?`, `script_path?` |
| `save_scene` | `path?` |

### `get_scene_tree`

Return the node tree of the currently edited scene as nested objects (name, type, scene-relative path, script).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `max_depth` | integer | no | Depth to walk (default 6) |
| `include_internal` | boolean | no | Include editor-internal nodes (default false) |

### `get_node_info`

Inspect one node: type, script, groups, children and editor-visible properties.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Scene-relative node path, "." for the root |
| `include_properties` | boolean | no | Include property values (default true) |

### `set_node_property`

Set one property on a node in the open scene (undoable). Strings such as "Vector2(32, 32)" are converted to the property's real type.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Scene-relative node path |
| `property` | string | yes | Property path, e.g. position or modulate |
| `value` | variant | yes | New value |

### `add_node`

Add a new node of any engine type under a parent in the open scene (undoable), optionally with a GDScript or C# script attached.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `parent_path` | string | yes | Scene-relative parent path, "." for root |
| `type` | string | yes | Godot class, e.g. Sprite2D, Label, CharacterBody2D |
| `name` | string | no | Node name (default: the type) |
| `properties` | object | no | Optional property values to set |
| `script_path` | string | no | Optional .gd or .cs script to attach to the new node |

### `attach_script`

Attach an existing GDScript (.gd) or C# (.cs) script to a node in the open scene, or detach it with script_path "" (undoable).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Scene-relative node path |
| `script_path` | string | yes | res:// path of the .gd/.cs script; empty string detaches |

### `remove_node`

Remove a node from the open scene (undoable). The scene root cannot be removed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Scene-relative node path |

### `select_nodes`

Select nodes in the editor so the human can see what you are working on.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `paths` | array | yes | Array of scene-relative node paths |

### `instantiate_scene`

Instance a .tscn file under a node in the open scene (undoable).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scene_path` | string | yes | res:// path of the packed scene |
| `parent_path` | string | no | Scene-relative parent path (default ".") |
| `name` | string | no | Instance name (default: scene file name) |

### `open_scene`

Open a .tscn scene in the editor.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | res:// path of the scene |

### `create_scene`

Create a new scene file with a root node and open it.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | res:// path, e.g. res://scenes/main_menu.tscn |
| `root_type` | string | no | Root class (default Node2D) |
| `root_name` | string | no | Root node name (default Main) |
| `script_path` | string | no | Optional .gd or .cs script for the root node |

### `save_scene`

Save the currently edited scene, optionally as a new path.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | no | Optional new res:// path |

## Project

| Command | Parameters |
|---|---|
| `get_project_settings` | `prefix?`, `max_keys?` |
| `set_project_setting` | `key`, `value` |

### `get_project_settings`

Read project settings (ProjectSettings). Filter by key prefix, e.g. application/ or input/.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prefix` | string | no | Only keys starting with this prefix (default "") |
| `max_keys` | integer | no | Default 300 |

### `set_project_setting`

Set and save one project setting in project.godot.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Setting name, e.g. application/config/name |
| `value` | variant | yes | New value |

## Project and run

| Command | Parameters |
|---|---|
| `run_project` | `mode?`, `scene_path?` |
| `stop_project` | — |

### `run_project`

Start play-testing: the main scene, the current scene, or a specific scene.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | string | no | main \| current \| scene (default main) |
| `scene_path` | string | no | Required when mode=scene |

### `stop_project`

Stop the running play-test.

