# SPDX-License-Identifier: GPL-3.0-or-later
# NonZeroScript - command executor (Godot 4.7.2).
#
# Every command returns {"ok": true, "result": <json-safe>} or
# {"ok": false, "error": "<why>"}. The controller transports the result to the
# browser AI. Keep results compact: the AI has a character budget.
#
# Scripts may be GDScript (.gd) or C# (.cs). C# needs the .NET build of Godot
# 4.7.2; the editor state reports whether it is available.
#
# Safety:
#  - only res:// and user:// paths, never outside the project;
#  - .git, .godot and the plugin itself are protected;
#  - destructive and scene commands are undoable where Godot allows it;
#  - writing can be disabled from the dock.

@tool
extends RefCounted

const VERSION := "0.2.1"
const TEXT_EXTS := ["gd", "cs", "tscn", "tres", "godot", "cfg", "json", "md", "txt", "gdshader", "shader", "csv", "svg", "import", "csproj", "sln"]
const SCRIPT_EXTS := ["gd", "cs"]
const MAX_READ_BYTES := 4 * 1024 * 1024

# Untyped on purpose: the plugin may be an EditorPlugin, but typing it here
# would make GDScript reject optional/deprecated members (get_undo_redo) that
# are only called after a has_method() check.
var editor = null
var allow_write := true


# ══════════════════════════════════════════════════════════════════════════
#  DISPATCH
# ══════════════════════════════════════════════════════════════════════════
func execute(name: String, params: Dictionary) -> Dictionary:
	if not ClassDB.class_exists("Node"):
		return _err("Godot is not available")
	match name:
		"list_tools":
			return _ok({"note": "The tool catalogue is served by the controller."})
		"get_editor_state":
			return _editor_state()
		"list_files":
			return _list_files(params)
		"read_file":
			return _read_file(params)
		"search_in_files":
			return _search_in_files(params)
		"write_file":
			return _write_file(params)
		"write_files":
			return _write_files(params)
		"edit_file":
			return _edit_file(params)
		"create_dir":
			return _create_dir(params)
		"delete_path":
			return _delete_path(params)
		"rename_path":
			return _rename_path(params)
		"get_scene_tree":
			return _scene_tree(params)
		"get_node_info":
			return _node_info(params)
		"set_node_property":
			return _set_node_property(params)
		"add_node":
			return _add_node(params)
		"attach_script":
			return _attach_script(params)
		"remove_node":
			return _remove_node(params)
		"select_nodes":
			return _select_nodes(params)
		"instantiate_scene":
			return _instantiate_scene(params)
		"open_scene":
			return _open_scene(params)
		"create_scene":
			return _create_scene(params)
		"save_scene":
			return _save_scene(params)
		"get_project_settings":
			return _get_project_settings(params)
		"set_project_setting":
			return _set_project_setting(params)
		"run_project":
			return _run_project(params)
		"stop_project":
			return _stop_project(params)
		"get_editor_log":
			return _get_editor_log(params)
		"scan_filesystem":
			return _scan_filesystem()
		"capture_editor_viewport":
			return _capture_viewport(params)
		_:
			return _err("unknown command '%s'. Call list_tools for the catalogue." % name)


func _ok(result: Variant) -> Dictionary:
	return {"ok": true, "result": result}


func _err(message: String) -> Dictionary:
	return {"ok": false, "error": message}


# ══════════════════════════════════════════════════════════════════════════
#  EDITOR STATE
# ══════════════════════════════════════════════════════════════════════════
func _editor_state() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var selection: Array = []
	if root != null:
		for n in EditorInterface.get_selection().get_selected_nodes():
			if n is Node and n.is_inside_tree():
				selection.append(String(root.get_path_to(n)))
	var open_scenes := 0
	if EditorInterface.has_method("get_open_scenes"):
		open_scenes = EditorInterface.get_open_scenes().size()
	var csharp := _csharp_available()
	var dotnet := _dotnet_project()
	return _ok({
		"project_name": str(ProjectSettings.get_setting("application/config/name", "")),
		"project_path": ProjectSettings.globalize_path("res://"),
		"engine": str(Engine.get_version_info().get("string", "")),
		"plugin_version": VERSION,
		"open_scene": str(root.scene_file_path) if root != null else "",
		"edited_scene_root": str(root.name) if root != null else "",
		"open_scenes": open_scenes,
		"playing": _is_playing(),
		"selection": selection,
		"write_enabled": allow_write,
		"language": "csharp" if csharp else "gdscript",
		"csharp": csharp,
		"dotnet": dotnet,
		"script_extensions": SCRIPT_EXTS,
	})


func _is_playing() -> bool:
	if EditorInterface.has_method("is_playing_scene"):
		return EditorInterface.is_playing_scene()
	return false


# True when the running Godot binary carries C# support. Checked three ways so
# the answer survives API changes: the CSharpScript class, the build feature,
# and the extensions the Script resource loader recognises.
func _csharp_available() -> bool:
	if ClassDB.class_exists("CSharpScript"):
		return true
	if OS.has_feature("dotnet"):
		return true
	for ext in ResourceLoader.get_recognized_extensions_for_type("Script"):
		var e := str(ext).to_lower()
		if e == "cs" or e == "csx":
			return true
	return false


# A .NET project has a .sln (project root) or at least one .csproj. The walk is
# shallow on purpose: it stops at the first directory that has one.
func _dotnet_project() -> bool:
	for ext in ["csproj", "sln"]:
		if not _find_by_ext("res://", ext, 0, 2).is_empty():
			return true
	return false


func _find_by_ext(dir_path: String, ext: String, depth: int, max_depth: int) -> Array:
	var out: Array = []
	var d := DirAccess.open(dir_path)
	if d == null:
		return out
	for f in d.get_files():
		if f.get_extension().to_lower() == ext:
			out.append(dir_path.path_join(f))
	if not out.is_empty() or depth >= max_depth:
		return out
	for sub in d.get_directories():
		if sub.begins_with(".") or sub == "addons":
			continue
		out.append_array(_find_by_ext(dir_path.path_join(sub), ext, depth + 1, max_depth))
		if not out.is_empty():
			break
	return out


# Load a .gd or .cs script as a Script resource. Returns
# {"script": <Script>, "path": <res://...>} or {"error": "<why>"}.
func _load_script(raw: String) -> Dictionary:
	var path := _safe_path(raw)
	if path.is_empty():
		return {"error": "invalid script path (use res://...)"}
	var ext := path.get_extension().to_lower()
	if not SCRIPT_EXTS.has(ext):
		return {"error": "script must be a .gd or .cs file, got '%s'" % ext}
	if not FileAccess.file_exists(path):
		return {"error": "script not found: %s" % path}
	if ext == "cs" and not _csharp_available():
		return {"error": "this Godot build has no C# support; open the project with the .NET build of Godot 4.7.2 for .cs scripts"}
	var res = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if res == null or not (res is Script):
		return {"error": "could not load %s as a script" % path}
	return {"script": res, "path": path}


func _open_scene_path() -> String:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return ""
	return str(root.scene_file_path)


# ══════════════════════════════════════════════════════════════════════════
#  PATHS / IO
# ══════════════════════════════════════════════════════════════════════════
func _safe_path(raw: String) -> String:
	var p := raw.strip_edges()
	if p.is_empty():
		return ""
	if p.begins_with("/"):
		return ""
	if not p.begins_with("res://") and not p.begins_with("user://"):
		if p.contains(":"):
			return ""
		p = "res://" + p
	if p.begins_with("user://"):
		return p.simplify_path()
	var root := ProjectSettings.globalize_path("res://").simplify_path().trim_suffix("/")
	var full := ProjectSettings.globalize_path(p).simplify_path()
	if full != root and not full.begins_with(root + "/"):
		return ""
	var rel := full.substr(root.length()).trim_prefix("/")
	return "res://" + rel


func _protected(path: String) -> bool:
	var p := path.to_lower().trim_suffix("/")
	if p == "res://project.godot" or p == "res://.godot" or p.begins_with("res://.godot/"):
		return true
	if p == "res://.git" or p.begins_with("res://.git/"):
		return true
	if p == "res://addons/nonzeroscript" or p.begins_with("res://addons/nonzeroscript/"):
		return true
	return false


func _global(path: String) -> String:
	return ProjectSettings.globalize_path(path)


func _ensure_dir(path: String) -> bool:
	var dir := path.get_base_dir()
	if dir.is_empty() or dir == "res://" or dir == "user://":
		return true
	var g := _global(dir)
	if DirAccess.dir_exists_absolute(g):
		return true
	return DirAccess.make_dir_recursive_absolute(g) == OK


func _file_size(path: String) -> int:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return -1
	var n := f.get_length()
	f.close()
	return n


func _read_text(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var size := f.get_length()
	if size > MAX_READ_BYTES:
		f.close()
		return ""
	var text := f.get_as_text()
	f.close()
	return text


func _write_text(path: String, content: String) -> bool:
	if not allow_write:
		return false
	if not _ensure_dir(path):
		return false
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return false
	f.store_string(content)
	f.close()
	return true


func _open_in_editor(path: String) -> void:
	if path.ends_with(".gd") or path.ends_with(".cs"):
		var res := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE)
		if res is Script:
			EditorInterface.edit_script(res)
	elif path.ends_with(".tscn"):
		EditorInterface.open_scene_from_path(path)


func _rescan() -> void:
	if EditorInterface.has_method("get_resource_filesystem"):
		var fs := EditorInterface.get_resource_filesystem()
		if fs != null:
			fs.scan()


# ══════════════════════════════════════════════════════════════════════════
#  FILE COMMANDS
# ══════════════════════════════════════════════════════════════════════════
func _list_files(params: Dictionary) -> Dictionary:
	var base := _safe_path(str(params.get("path", "res://")))
	if base.is_empty():
		return _err("invalid path")
	var max_files := clampi(int(params.get("max_files", 400)), 1, 5000)
	var recursive := bool(params.get("recursive", false))
	var exts := _csv_lower(str(params.get("extensions", "")))
	var out: Array = []
	var stack: Array = [base]
	var truncated := false
	while not stack.is_empty():
		var dir: String = stack.pop_back()
		var d := DirAccess.open(dir)
		if d == null:
			continue
		for f in d.get_files():
			if not exts.is_empty() and not exts.has(f.get_extension().to_lower()):
				continue
			out.append(dir.path_join(f))
			if out.size() >= max_files:
				truncated = true
				break
		if truncated:
			break
		if recursive:
			for sub in d.get_directories():
				if sub.begins_with("."):
					continue
				stack.append(dir.path_join(sub))
	out.sort()
	return _ok({"path": base, "files": out, "count": out.size(), "truncated": truncated})


func _read_file(params: Dictionary) -> Dictionary:
	var path := _safe_path(str(params.get("path", "")))
	if path.is_empty():
		return _err("invalid path (use res://...)")
	if not FileAccess.file_exists(path):
		return _err("file not found: %s" % path)
	var max_lines := clampi(int(params.get("max_lines", 500)), 1, 5000)
	var start := maxi(int(params.get("start_line", 1)), 1)
	var text := _read_text(path)
	if text.is_empty() and _file_size(path) > MAX_READ_BYTES:
		return _err("file is too large to read (limit %d bytes)" % MAX_READ_BYTES)
	var lines := text.split("\n")
	var begin := start - 1
	var stop := mini(begin + max_lines, lines.size())
	var numbered: Array = []
	for i in range(begin, stop):
		numbered.append("%d\t%s" % [i + 1, lines[i]])
	return _ok({
		"path": path,
		"total_lines": lines.size(),
		"start_line": start,
		"returned_lines": numbered.size(),
		"truncated": stop < lines.size(),
		"text": "\n".join(numbered),
	})


func _search_in_files(params: Dictionary) -> Dictionary:
	var query := str(params.get("query", ""))
	if query.is_empty():
		return _err("query is required")
	var base := _safe_path(str(params.get("path", "res://")))
	if base.is_empty():
		return _err("invalid path")
	var use_regex := bool(params.get("regex", false))
	var case_sensitive := bool(params.get("case_sensitive", false))
	var max_results := clampi(int(params.get("max_results", 80)), 1, 500)
	var exts := _csv_lower(str(params.get("include", "gd,cs,tscn,tres,godot,cfg,json,md,txt,gdshader,shader")))
	var rx: RegEx = null
	if use_regex:
		rx = RegEx.new()
		var pattern := query if case_sensitive else "(?i)" + query
		if rx.compile(pattern) != OK:
			return _err("invalid regular expression")
	var needle := query if case_sensitive else query.to_lower()
	var matches: Array = []
	var files_checked := 0
	var stack: Array = [base]
	var done := false
	while not stack.is_empty() and not done:
		var dir: String = stack.pop_back()
		var d := DirAccess.open(dir)
		if d == null:
			continue
		for f in d.get_files():
			if not exts.is_empty() and not exts.has(f.get_extension().to_lower()):
				continue
			var path := dir.path_join(f)
			var text := _read_text(path)
			if text.is_empty():
				continue
			files_checked += 1
			var lines := text.split("\n")
			for i in range(lines.size()):
				var line := lines[i]
				var hit := false
				if use_regex and rx != null:
					hit = rx.search(line) != null
				else:
					hit = line.find(needle) >= 0
				if hit:
					matches.append({"path": path, "line": i + 1, "text": line.strip_edges().substr(0, 300)})
					if matches.size() >= max_results:
						done = true
						break
			if done:
				break
		if not done:
			for sub in d.get_directories():
				if sub.begins_with("."):
					continue
				stack.append(dir.path_join(sub))
	return _ok({
		"query": query,
		"regex": use_regex,
		"files_checked": files_checked,
		"count": matches.size(),
		"truncated": done,
		"matches": matches,
	})


func _write_file(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("writing is disabled in the NonZeroScript dock")
	var path := _safe_path(str(params.get("path", "")))
	if path.is_empty():
		return _err("invalid path (use res://...)")
	if _protected(path):
		return _err("path is protected: %s" % path)
	var content := str(params.get("content", ""))
	if not _write_text(path, content):
		return _err("could not write %s (permissions or read-only)" % path)
	_rescan()
	if bool(params.get("open_in_editor", false)):
		_open_in_editor(path)
	var out := {"path": path, "bytes": content.to_utf8_buffer().size(), "written": true}
	if path.ends_with(".cs"):
		if not _csharp_available():
			out["warning"] = "this Godot build has no C# support: the .cs file was written but will not compile"
		elif not _dotnet_project():
			out["warning"] = "no .csproj/.sln found: use Project > Tools > C# > Create C# solution so .cs scripts compile"
	return _ok(out)


func _write_files(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("writing is disabled in the NonZeroScript dock")
	var files = params.get("files", [])
	if typeof(files) != TYPE_ARRAY:
		return _err("files must be an array of {path, content}")
	var written: Array = []
	var errors: Array = []
	for item in files:
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var path := _safe_path(str(item.get("path", "")))
		if path.is_empty() or _protected(path):
			errors.append("invalid/protected path: %s" % str(item.get("path", "")))
			continue
		if _write_text(path, str(item.get("content", ""))):
			written.append(path)
		else:
			errors.append("could not write %s" % path)
	_rescan()
	if bool(params.get("open_in_editor", false)) and not written.is_empty():
		_open_in_editor(str(written[0]))
	var out := {"written": written, "count": written.size(), "errors": errors}
	for p in written:
		if not str(p).ends_with(".cs"):
			continue
		if not _csharp_available():
			out["warning"] = "this Godot build has no C# support: .cs files were written but will not compile"
		elif not _dotnet_project():
			out["warning"] = "no .csproj/.sln found: use Project > Tools > C# > Create C# solution so .cs scripts compile"
		break
	return _ok(out)


func _edit_file(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("writing is disabled in the NonZeroScript dock")
	var path := _safe_path(str(params.get("path", "")))
	if path.is_empty():
		return _err("invalid path")
	if _protected(path):
		return _err("path is protected: %s" % path)
	if not FileAccess.file_exists(path):
		return _err("file not found: %s" % path)
	var search := str(params.get("search", ""))
	if search.is_empty():
		return _err("search text is required")
	var replace := str(params.get("replace", ""))
	var all := bool(params.get("all", false))
	var text := _read_text(path)
	var hits := text.count(search)
	if hits == 0:
		return _err("search text not found in %s" % path)
	if hits > 1 and not all:
		return _err("search text appears %d times; pass all=true or provide a longer unique search" % hits)
	# String.replace replaces every occurrence, so for all=false use find+substr.
	var updated := ""
	if all:
		updated = text.replace(search, replace)
	else:
		var at := text.find(search)
		updated = text.substr(0, at) + replace + text.substr(at + search.length())
	if not _write_text(path, updated):
		return _err("could not write %s" % path)
	_rescan()
	return _ok({"path": path, "replaced": hits if all else 1, "bytes": updated.to_utf8_buffer().size()})


func _create_dir(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("writing is disabled in the NonZeroScript dock")
	var path := _safe_path(str(params.get("path", "")))
	if path.is_empty():
		return _err("invalid path")
	if _protected(path):
		return _err("path is protected")
	var g := _global(path)
	if DirAccess.dir_exists_absolute(g):
		return _ok({"path": path, "created": false})
	if DirAccess.make_dir_recursive_absolute(g) != OK:
		return _err("could not create %s" % path)
	_rescan()
	return _ok({"path": path, "created": true})


func _delete_path(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("writing is disabled in the NonZeroScript dock")
	var path := _safe_path(str(params.get("path", "")))
	if path.is_empty():
		return _err("invalid path")
	if _protected(path):
		return _err("path is protected: %s" % path)
	if path == "res://" or path == "user://":
		return _err("refusing to delete a root path")
	var g := _global(path)
	if not FileAccess.file_exists(path) and not DirAccess.dir_exists_absolute(g):
		return _err("path not found: %s" % path)
	if DirAccess.dir_exists_absolute(g):
		if not bool(params.get("recursive", false)):
			return _err("refusing to delete a folder without recursive=true")
		if not _remove_dir(g):
			return _err("could not delete folder %s" % path)
	else:
		if DirAccess.remove_absolute(g) != OK:
			return _err("could not delete %s" % path)
	_rescan()
	return _ok({"path": path, "deleted": true})


func _remove_dir(global_dir: String) -> bool:
	var d := DirAccess.open(global_dir)
	if d == null:
		return false
	for f in d.get_files():
		DirAccess.remove_absolute(global_dir.path_join(f))
	for sub in d.get_directories():
		_remove_dir(global_dir.path_join(sub))
	return DirAccess.remove_absolute(global_dir) == OK


func _rename_path(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("writing is disabled in the NonZeroScript dock")
	var from := _safe_path(str(params.get("from", "")))
	var to := _safe_path(str(params.get("to", "")))
	if from.is_empty() or to.is_empty():
		return _err("from and to are required")
	if _protected(from) or _protected(to):
		return _err("path is protected")
	if from == "res://" or to == "res://" or from == "user://" or to == "user://":
		return _err("refusing to rename a root path")
	if not FileAccess.file_exists(from) and not DirAccess.dir_exists_absolute(_global(from)):
		return _err("source not found: %s" % from)
	if not bool(params.get("overwrite", false)) and (FileAccess.file_exists(to) or DirAccess.dir_exists_absolute(_global(to))):
		return _err("destination exists: %s" % to)
	_ensure_dir(to)
	if DirAccess.rename_absolute(_global(from), _global(to)) != OK:
		return _err("rename failed: %s -> %s" % [from, to])
	_rescan()
	return _ok({"from": from, "to": to, "renamed": true})


func _scan_filesystem() -> Dictionary:
	_rescan()
	return _ok({"scanned": true})


# ══════════════════════════════════════════════════════════════════════════
#  SCENE COMMANDS
# ══════════════════════════════════════════════════════════════════════════
func _scene_root() -> Node:
	return EditorInterface.get_edited_scene_root()


func _node(path: String) -> Node:
	var root := _scene_root()
	if root == null:
		return null
	var p := path.strip_edges()
	if p.is_empty() or p == "." or p == "/" or p == String(root.name):
		return root
	var n := root.get_node_or_null(NodePath(p))
	if n == null and p.begins_with("/root/"):
		n = root.get_node_or_null(NodePath(p.substr(6)))
	return n


func _node_tree(node: Node, root: Node, depth: int, max_depth: int, include_internal: bool) -> Dictionary:
	var d := {
		"name": String(node.name),
		"type": node.get_class(),
		"path": "." if node == root else String(root.get_path_to(node)),
	}
	var scr = node.get_script()
	if scr != null:
		d["script"] = str(scr.resource_path)
	if depth < max_depth:
		var kids: Array = []
		for c in node.get_children(include_internal):
			if not include_internal and String(c.name).begins_with("_"):
				continue
			kids.append(_node_tree(c, root, depth + 1, max_depth, include_internal))
		if not kids.is_empty():
			d["children"] = kids
	return d


func _scene_tree(params: Dictionary) -> Dictionary:
	var root := _scene_root()
	if root == null:
		return _err("no scene is open in the Godot editor")
	var max_depth := clampi(int(params.get("max_depth", 6)), 1, 32)
	var include_internal := bool(params.get("include_internal", false))
	return _ok({
		"scene": str(root.scene_file_path),
		"root": _node_tree(root, root, 0, max_depth, include_internal),
	})


func _node_info(params: Dictionary) -> Dictionary:
	var n := _node(str(params.get("path", ".")))
	if n == null:
		return _err("node not found: %s" % str(params.get("path", ".")))
	var root := _scene_root()
	var groups: Array = []
	for g in n.get_groups():
		groups.append(String(g))
	var children: Array = []
	for c in n.get_children():
		children.append(String(c.name))
	var d := {
		"name": String(n.name),
		"type": n.get_class(),
		"path": "." if n == root else String(root.get_path_to(n)),
		"groups": groups,
		"children": children,
	}
	var scr = n.get_script()
	if scr != null:
		d["script"] = str(scr.resource_path)
	if bool(params.get("include_properties", true)):
		d["properties"] = _properties(n)
	return _ok(d)


func _properties(n: Node) -> Dictionary:
	var out := {}
	var count := 0
	for p in n.get_property_list():
		var usage := int(p.get("usage", 0))
		if (usage & PROPERTY_USAGE_EDITOR) == 0:
			continue
		if (usage & PROPERTY_USAGE_CATEGORY) != 0 or (usage & PROPERTY_USAGE_GROUP) != 0:
			continue
		var name := str(p.get("name", ""))
		if name.is_empty() or name.begins_with("_") or name == "script":
			continue
		var v = n.get(name)
		if v is Object:
			continue
		out[name] = _json_value(v)
		count += 1
		if count >= 120:
			break
	return out


func _json_value(v: Variant) -> Variant:
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return v
		TYPE_STRING_NAME:
			return String(v)
		TYPE_NODE_PATH:
			return str(v)
		TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I, TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_RECT2, TYPE_RECT2I, TYPE_COLOR, TYPE_QUATERNION, TYPE_PLANE, TYPE_BASIS, TYPE_TRANSFORM2D, TYPE_TRANSFORM3D, TYPE_AABB, TYPE_PROJECTION:
			return str(v)
		TYPE_ARRAY:
			var arr: Array = []
			for i in range(mini(v.size(), 200)):
				arr.append(_json_value(v[i]))
			return arr
		TYPE_DICTIONARY:
			var d := {}
			for k in v.keys():
				if d.size() >= 200:
					break
				d[str(k)] = _json_value(v[k])
			return d
		TYPE_OBJECT:
			if v == null:
				return null
			return v.get_class()
		_:
			return str(v)


func _find_property(n: Node, prop: String) -> bool:
	var base := prop.get_slice(":", 0)
	for p in n.get_property_list():
		if str(p.get("name", "")) == base:
			return true
	return false


func _coerce(value: Variant, current: Variant) -> Variant:
	var t := typeof(current)
	if typeof(value) == TYPE_STRING:
		var s := str(value).strip_edges()
		if t in [TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I, TYPE_COLOR,
				TYPE_RECT2, TYPE_RECT2I, TYPE_TRANSFORM2D, TYPE_TRANSFORM3D, TYPE_NODE_PATH,
				TYPE_QUATERNION, TYPE_PLANE, TYPE_BASIS]:
			var parsed = str_to_var(s)
			if parsed != null:
				return parsed
		if t == TYPE_INT:
			return int(s)
		if t == TYPE_FLOAT:
			return float(s)
		if t == TYPE_BOOL:
			return s.to_lower() in ["true", "1", "yes", "on"]
	if t == TYPE_INT and (typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT):
		return int(value)
	if t == TYPE_FLOAT and (typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT):
		return float(value)
	return value


func _undo_redo() -> Variant:
	if editor != null and editor.has_method("get_undo_redo"):
		return editor.get_undo_redo()
	if EditorInterface.has_method("get_editor_undo_redo"):
		return EditorInterface.get_editor_undo_redo()
	return null


func _mark_unsaved() -> void:
	if EditorInterface.has_method("mark_scene_as_unsaved"):
		EditorInterface.mark_scene_as_unsaved()


func _set_node_property(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("editing is disabled in the NonZeroScript dock")
	var n := _node(str(params.get("path", ".")))
	if n == null:
		return _err("node not found: %s" % str(params.get("path", ".")))
	var prop := str(params.get("property", "")).strip_edges()
	if prop.is_empty():
		return _err("property is required")
	if not _find_property(n, prop):
		return _err("property not found on %s: %s" % [n.get_class(), prop])
	if not params.has("value"):
		return _err("value is required")
	var current = n.get_indexed(NodePath(prop)) if prop.contains(":") else n.get(prop)
	var value = _coerce(params.get("value"), current)
	var ur = _undo_redo()
	if ur != null:
		ur.create_action("NonZeroScript: set %s" % prop)
		if prop.contains(":"):
			ur.add_do_method(n, "set_indexed", NodePath(prop), value)
			ur.add_undo_method(n, "set_indexed", NodePath(prop), current)
		else:
			ur.add_do_property(n, prop, value)
			ur.add_undo_property(n, prop, current)
		ur.commit_action()
	else:
		if prop.contains(":"):
			n.set_indexed(NodePath(prop), value)
		else:
			n.set(prop, value)
	_mark_unsaved()
	return _ok({"path": String(_scene_root().get_path_to(n)) if n != _scene_root() else ".", "property": prop, "value": _json_value(value)})


func _add_node(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("editing is disabled in the NonZeroScript dock")
	var root := _scene_root()
	if root == null:
		return _err("no scene is open in the Godot editor")
	var parent := _node(str(params.get("parent_path", ".")))
	if parent == null:
		return _err("parent not found: %s" % str(params.get("parent_path", ".")))
	var type_name := str(params.get("type", "Node")).strip_edges()
	if not ClassDB.class_exists(type_name):
		return _err("unknown Godot class: %s" % type_name)
	if not ClassDB.can_instantiate(type_name):
		return _err("class cannot be instantiated: %s" % type_name)
	var node = ClassDB.instantiate(type_name)
	if node == null or not (node is Node):
		return _err("could not instantiate %s" % type_name)
	var base_name := str(params.get("name", type_name)).strip_edges()
	if base_name.is_empty():
		base_name = type_name
	node.name = _unique_name(parent, base_name)
	var script_path := str(params.get("script_path", "")).strip_edges()
	var script_abs := ""
	if not script_path.is_empty():
		var loaded := _load_script(script_path)
		if loaded.has("error"):
			node.free()
			return _err(str(loaded["error"]))
		node.set_script(loaded["script"])
		script_abs = str(loaded["path"])
	var ur = _undo_redo()
	if ur != null:
		ur.create_action("NonZeroScript: add %s" % String(node.name))
		ur.add_do_method(parent, "add_child", node, true)
		ur.add_do_reference(node)
		ur.add_undo_method(parent, "remove_child", node)
		ur.commit_action()
	else:
		parent.add_child(node, true)
	node.owner = root
	var props = params.get("properties", {})
	if typeof(props) == TYPE_DICTIONARY:
		for key in props.keys():
			var pname := str(key)
			if _find_property(node, pname):
				node.set_indexed(NodePath(pname), _coerce(props[key], node.get_indexed(NodePath(pname)) if pname.contains(":") else node.get(pname)))
	var out := {"path": String(root.get_path_to(node)), "type": node.get_class()}
	if not script_abs.is_empty():
		out["script"] = script_abs
	_mark_unsaved()
	return _ok(out)


func _attach_script(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("editing is disabled in the NonZeroScript dock")
	var root := _scene_root()
	if root == null:
		return _err("no scene is open in the Godot editor")
	var n := _node(str(params.get("path", ".")))
	if n == null:
		return _err("node not found: %s" % str(params.get("path", ".")))
	var raw := str(params.get("script_path", "")).strip_edges()
	var script_res = null
	var script_abs := ""
	if not raw.is_empty():
		var loaded := _load_script(raw)
		if loaded.has("error"):
			return _err(str(loaded["error"]))
		script_res = loaded["script"]
		script_abs = str(loaded["path"])
	var previous = n.get_script()
	var out := {"path": String(root.get_path_to(n)), "script": script_abs, "changed": previous != script_res}
	if previous != script_res:
		var ur = _undo_redo()
		if ur != null:
			ur.create_action("NonZeroScript: script on %s" % String(n.name))
			ur.add_do_property(n, "script", script_res)
			ur.add_undo_property(n, "script", previous)
			ur.commit_action()
		else:
			n.set_script(script_res)
		_mark_unsaved()
	return _ok(out)


func _unique_name(parent: Node, base: String) -> String:
	var candidate := base
	var i := 2
	while parent.get_node_or_null(NodePath(candidate)) != null:
		candidate = "%s%d" % [base, i]
		i += 1
	return candidate


func _remove_node(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("editing is disabled in the NonZeroScript dock")
	var root := _scene_root()
	if root == null:
		return _err("no scene is open in the Godot editor")
	var n := _node(str(params.get("path", ".")))
	if n == null:
		return _err("node not found: %s" % str(params.get("path", ".")))
	if n == root:
		return _err("the scene root cannot be removed")
	var parent := n.get_parent()
	if parent == null:
		return _err("node has no parent")
	var ur = _undo_redo()
	if ur != null:
		ur.create_action("NonZeroScript: remove %s" % String(n.name))
		ur.add_do_method(parent, "remove_child", n)
		ur.add_undo_method(parent, "add_child", n, true)
		ur.add_undo_reference(n)
		ur.commit_action()
	else:
		parent.remove_child(n)
	_mark_unsaved()
	return _ok({"removed": String(n.name)})


func _select_nodes(params: Dictionary) -> Dictionary:
	var paths = params.get("paths", [])
	if typeof(paths) != TYPE_ARRAY:
		return _err("paths must be an array")
	var sel := EditorInterface.get_selection()
	sel.clear()
	var selected: Array = []
	for p in paths:
		var n := _node(str(p))
		if n != null:
			sel.add_node(n)
			selected.append(str(p))
	return _ok({"selected": selected})


func _instantiate_scene(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("editing is disabled in the NonZeroScript dock")
	var root := _scene_root()
	if root == null:
		return _err("no scene is open in the Godot editor")
	var scene_path := _safe_path(str(params.get("scene_path", "")))
	if scene_path.is_empty() or not scene_path.ends_with(".tscn"):
		return _err("scene_path must be a res:// .tscn file")
	if not ResourceLoader.exists(scene_path):
		return _err("scene not found: %s" % scene_path)
	var parent := _node(str(params.get("parent_path", ".")))
	if parent == null:
		return _err("parent not found")
	var packed := load(scene_path) as PackedScene
	if packed == null:
		return _err("could not load scene: %s" % scene_path)
	var inst = packed.instantiate()
	if inst == null or not (inst is Node):
		return _err("could not instantiate %s" % scene_path)
	var base_name := str(params.get("name", ""))
	if base_name.is_empty():
		base_name = scene_path.get_file().get_basename()
	inst.name = _unique_name(parent, base_name)
	var ur = _undo_redo()
	if ur != null:
		ur.create_action("NonZeroScript: instance %s" % scene_path)
		ur.add_do_method(parent, "add_child", inst, true)
		ur.add_do_reference(inst)
		ur.add_undo_method(parent, "remove_child", inst)
		ur.commit_action()
	else:
		parent.add_child(inst, true)
	inst.owner = root
	_mark_unsaved()
	return _ok({"path": String(root.get_path_to(inst)), "scene": scene_path})


func _open_scene(params: Dictionary) -> Dictionary:
	var path := _safe_path(str(params.get("path", "")))
	if path.is_empty() or not path.ends_with(".tscn"):
		return _err("path must be a res:// .tscn file")
	if not FileAccess.file_exists(path):
		return _err("scene not found: %s" % path)
	EditorInterface.open_scene_from_path(path)
	return _ok({"opened": path})


func _create_scene(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("writing is disabled in the NonZeroScript dock")
	var path := _safe_path(str(params.get("path", "")))
	if path.is_empty() or not path.ends_with(".tscn"):
		return _err("path must be a res:// .tscn file")
	if _protected(path):
		return _err("path is protected")
	var root_type := str(params.get("root_type", "Node2D")).strip_edges()
	if not ClassDB.class_exists(root_type):
		return _err("unknown Godot class: %s" % root_type)
	if not ClassDB.can_instantiate(root_type):
		return _err("class cannot be instantiated: %s" % root_type)
	var root = ClassDB.instantiate(root_type)
	if root == null or not (root is Node):
		return _err("could not instantiate %s" % root_type)
	var root_name := str(params.get("root_name", "Main")).strip_edges()
	if root_name.is_empty():
		root_name = "Main"
	root.name = root_name
	var script_path := str(params.get("script_path", "")).strip_edges()
	if not script_path.is_empty():
		var loaded := _load_script(script_path)
		if loaded.has("error"):
			root.free()
			return _err(str(loaded["error"]))
		root.set_script(loaded["script"])
	var packed := PackedScene.new()
	var err := packed.pack(root)
	if err != OK:
		root.free()
		return _err("could not pack scene (%s)" % error_string(err))
	if not _ensure_dir(path):
		root.free()
		return _err("could not create folder for %s" % path)
	err = ResourceSaver.save(packed, path)
	root.free()
	if err != OK:
		return _err("could not save scene: %s" % error_string(err))
	_rescan()
	EditorInterface.open_scene_from_path(path)
	var out := {"path": path, "root_type": root_type}
	if not script_path.is_empty():
		out["script"] = script_path
	return _ok(out)


func _save_scene(params: Dictionary) -> Dictionary:
	var root := _scene_root()
	if root == null:
		return _err("no scene is open in the Godot editor")
	var path := _safe_path(str(params.get("path", "")))
	if not path.is_empty():
		var err := EditorInterface.save_scene_as(path, true)
		return _ok({"saved": path}) if err == OK else _err("could not save as %s: %s" % [path, error_string(err)])
	var err2 := EditorInterface.save_scene()
	if err2 != OK:
		return _err("could not save scene: %s" % error_string(err2))
	return _ok({"saved": str(root.scene_file_path)})


# ══════════════════════════════════════════════════════════════════════════
#  PROJECT / RUN
# ══════════════════════════════════════════════════════════════════════════
func _get_project_settings(params: Dictionary) -> Dictionary:
	var prefix := str(params.get("prefix", ""))
	var max_keys := clampi(int(params.get("max_keys", 300)), 1, 5000)
	var out := {}
	for p in ProjectSettings.get_property_list():
		var key := str(p.get("name", ""))
		if key.is_empty() or key.begins_with("_"):
			continue
		if not prefix.is_empty() and not key.begins_with(prefix):
			continue
		var usage := int(p.get("usage", 0))
		if (usage & PROPERTY_USAGE_STORAGE) == 0:
			continue
		var v = ProjectSettings.get_setting(key)
		if v is Object:
			continue
		out[key] = _json_value(v)
		if out.size() >= max_keys:
			break
	return _ok({"prefix": prefix, "count": out.size(), "settings": out})


func _set_project_setting(params: Dictionary) -> Dictionary:
	if not allow_write:
		return _err("writing is disabled in the NonZeroScript dock")
	var key := str(params.get("key", "")).strip_edges()
	if key.is_empty():
		return _err("key is required")
	if not params.has("value"):
		return _err("value is required")
	var current = ProjectSettings.get_setting(key, null)
	ProjectSettings.set_setting(key, _coerce(params.get("value"), current))
	var err := ProjectSettings.save()
	if err != OK:
		return _err("could not save project.godot: %s" % error_string(err))
	return _ok({"key": key, "value": _json_value(ProjectSettings.get_setting(key))})


func _run_project(params: Dictionary) -> Dictionary:
	var mode := str(params.get("mode", "main")).to_lower()
	match mode:
		"main", "project":
			EditorInterface.play_main_scene()
		"current":
			EditorInterface.play_current_scene()
		"scene":
			var path := _safe_path(str(params.get("scene_path", "")))
			if path.is_empty():
				return _err("scene_path is required for mode=scene")
			if not EditorInterface.has_method("play_custom_scene"):
				return _err("this Godot build has no play_custom_scene")
			EditorInterface.play_custom_scene(path)
		"stop":
			EditorInterface.stop_playing_scene()
		_:
			return _err("mode must be main, current, scene or stop")
	var csharp := _csharp_available()
	var dotnet := _dotnet_project()
	var out := {"mode": mode, "playing": _is_playing(), "csharp": csharp, "dotnet": dotnet}
	if mode != "stop":
		if csharp and dotnet:
			out["note"] = "C# is compiled by the .NET build of Godot; if scripts are missing at runtime, run Build in the MSBuild panel and play again."
		elif not csharp and not _find_by_ext("res://", "cs", 0, 6).is_empty():
			out["warning"] = "the project contains .cs files but this Godot build has no C# support: open it with the .NET build"
	return _ok(out)


func _stop_project() -> Dictionary:
	EditorInterface.stop_playing_scene()
	return _ok({"stopped": true, "playing": _is_playing()})


# ══════════════════════════════════════════════════════════════════════════
#  LOG / CAPTURE
# ══════════════════════════════════════════════════════════════════════════
func _log_candidates() -> Array:
	var out: Array = []
	out.append("user://logs/godot.log")
	var ud := OS.get_user_data_dir()
	out.append(ud.path_join("logs/godot.log"))
	if OS.has_method("get_data_dir"):
		out.append(str(OS.get_data_dir()).path_join("logs/godot.log"))
	if OS.has_method("get_config_dir"):
		out.append(str(OS.get_config_dir()).path_join("logs/godot.log"))
	return out


func _get_editor_log(params: Dictionary) -> Dictionary:
	var lines_wanted := clampi(int(params.get("lines", 120)), 1, 1000)
	var errors_only := bool(params.get("errors_only", false))
	var source := ""
	var text := ""
	for candidate in _log_candidates():
		if FileAccess.file_exists(candidate):
			var f := FileAccess.open(candidate, FileAccess.READ)
			if f != null:
				var size := f.get_length()
				f.seek(maxi(0, size - 512 * 1024))
				text = f.get_as_text()
				f.close()
				source = str(candidate)
				break
	if source.is_empty():
		return _ok({
			"available": false,
			"note": "No godot.log found yet. Run the project once; the editor writes user://logs/godot.log.",
		})
	var all := text.split("\n")
	var picked: Array = []
	for i in range(all.size() - 1, -1, -1):
		var line: String = all[i]
		if errors_only:
			var low := line.to_lower()
			if not (low.contains("error") or low.contains("warning") or low.contains("parse")):
				continue
		if line.strip_edges().is_empty():
			continue
		picked.push_front(line)
		if picked.size() >= lines_wanted:
			break
	return _ok({
		"available": true,
		"file": source,
		"count": picked.size(),
		"errors_only": errors_only,
		"text": "\n".join(picked),
	})


func _capture_viewport(params: Dictionary) -> Dictionary:
	var base := EditorInterface.get_base_control()
	if base == null:
		return _err("editor viewport is unavailable")
	var viewport := base.get_viewport()
	if viewport == null:
		return _err("editor viewport is unavailable")
	var img := viewport.get_texture().get_image()
	if img == null:
		return _err("could not capture the editor viewport")
	var path := _safe_path(str(params.get("save_path", "")))
	if path.is_empty():
		var stamp := Time.get_datetime_string_from_system().replace(":", "-").replace("T", "-")
		path = "res://.nonzeroscript/captures/editor-%s.png" % stamp
	if _protected(path):
		return _err("path is protected")
	if not _ensure_dir(path):
		return _err("could not create the capture folder")
	var err := img.save_png(_global(path))
	if err != OK:
		return _err("could not save PNG: %s" % error_string(err))
	return _ok({"path": path, "width": img.get_width(), "height": img.get_height()})


func _csv_lower(raw: String) -> Array:
	var out: Array = []
	for part in raw.split(","):
		var s := part.strip_edges().to_lower().trim_prefix(".")
		if not s.is_empty():
			out.append(s)
	return out
