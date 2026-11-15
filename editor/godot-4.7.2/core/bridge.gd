# SPDX-License-Identifier: GPL-3.0-or-later
# NonZeroScript - controller poller (Godot 4.7.2).
#
# Plain HTTP polling, not WebSocket, on purpose:
#   * the controller stays standard-library only,
#   * it survives editor/controller restarts without reconnect storms,
#   * the assistant sees results with ~0.4s extra latency, which is invisible
#     next to a multi-second AI turn.
#
# The editor never accepts inbound connections: it only POSTs to the loopback
# controller the user configured.

@tool
extends Node

signal status_changed(info: Dictionary)
signal log_line(text: String)

const PLUGIN_VERSION := "0.1.0"
const CONFIG_PATH := "user://nonzeroscript_editor.cfg"
const BASE_INTERVAL := 0.4
const MAX_INTERVAL := 5.0

var controller_url := "http://127.0.0.1:8790"
var enabled := true
# Untyped: the executor script exposes execute()/allow_write, which are not
# members of RefCounted (a typed base would fail to compile).
var commands = null

var _http: HTTPRequest
var _busy := false
var _timer := 0.0
var _poll_interval := BASE_INTERVAL
var _failures := 0
var _connected := false
var _editor_id := ""
var _last_error := ""
var _last_status_sig := ""
var _outbox: Array = []


func _ready() -> void:
	_http = HTTPRequest.new()
	_http.name = "NonZeroScriptHTTP"
	_http.timeout = 8.0
	add_child(_http)
	_load_config()
	_editor_id = "godot-" + str(OS.get_user_data_dir().md5_text().substr(0, 8))
	set_process(true)
	_log("Bridge ready → %s" % controller_url)


func _process(delta: float) -> void:
	if not enabled or _busy:
		return
	_timer += delta
	if _timer < _poll_interval:
		return
	_timer = 0.0
	_run_once()


func _run_once() -> void:
	_busy = true
	if not _outbox.is_empty():
		await _send_one_result()
	else:
		await _poll()
	_busy = false


# ══════════════════════════════════════════════════════════════════════════
#  HTTP
# ══════════════════════════════════════════════════════════════════════════
func _post(path: String, data: Dictionary) -> Array:
	if not enabled:
		return [ERR_UNCONFIGURED, 0, PackedStringArray(), PackedByteArray()]
	var url := controller_url.trim_suffix("/") + path
	var err := _http.request(
		url,
		PackedStringArray(["Content-Type: application/json"]),
		HTTPClient.METHOD_POST,
		JSON.stringify(data)
	)
	if err != OK:
		return [err, 0, PackedStringArray(), PackedByteArray()]
	var res: Array = await _http.request_completed
	return res


func _poll() -> void:
	var res := await _post("/api/editor/poll", _status_body())
	if _http_failed(res):
		_on_offline(res)
		return
	var text := (res[3] as PackedByteArray).get_string_from_utf8()
	var data = JSON.parse_string(text)
	if typeof(data) != TYPE_DICTIONARY:
		_on_offline("invalid JSON from controller")
		return
	if _failures > 0 or not _connected:
		_log("Connected to controller %s" % controller_url)
	_failures = 0
	_poll_interval = BASE_INTERVAL
	_connected = true
	_last_error = ""
	if data.has("commands") and typeof(data["commands"]) == TYPE_ARRAY:
		for item in data["commands"]:
			_execute(item)
	while not _outbox.is_empty():
		await _send_one_result()
	_emit_status(data)


func _send_one_result() -> void:
	if _outbox.is_empty():
		return
	var item: Dictionary = _outbox.pop_front()
	var res := await _post("/api/editor/result", item)
	if _http_failed(res):
		# Idempotent: the controller ignores an unknown request id, so a retry
		# after a flaky connection is safe.
		_outbox.push_front(item)
		_on_offline(res)


func _http_failed(res: Array) -> bool:
	if res.size() < 2:
		return true
	return int(res[0]) != HTTPRequest.RESULT_SUCCESS or int(res[1]) != 200


func _on_offline(res: Variant) -> void:
	_failures += 1
	_poll_interval = minf(MAX_INTERVAL, BASE_INTERVAL * pow(1.7, minf(float(_failures), 6.0)))
	var why := "offline"
	if typeof(res) == TYPE_ARRAY and res.size() >= 1:
		why = _http_result_name(int(res[0]))
	if _connected or _failures == 1:
		_last_error = why
		_log("Controller unreachable (%s) - retrying" % why)
	_connected = false
	_emit_status({})


func _http_result_name(code: int) -> String:
	match code:
		HTTPRequest.RESULT_SUCCESS:
			return "ok"
		HTTPRequest.RESULT_CANT_CONNECT:
			return "cannot connect"
		HTTPRequest.RESULT_CANT_RESOLVE:
			return "cannot resolve"
		HTTPRequest.RESULT_CONNECTION_ERROR:
			return "connection error"
		HTTPRequest.RESULT_TIMEOUT:
			return "timeout"
		_:
			return "error %d" % code


# ══════════════════════════════════════════════════════════════════════════
#  COMMAND EXECUTION
# ══════════════════════════════════════════════════════════════════════════
func _execute(item: Variant) -> void:
	if typeof(item) != TYPE_DICTIONARY:
		return
	var id := str(item.get("id", ""))
	var name := str(item.get("command", ""))
	var params = item.get("params", {})
	if typeof(params) != TYPE_DICTIONARY:
		params = {}
	var t0 := Time.get_ticks_msec()
	var result: Dictionary
	if commands == null:
		result = {"ok": false, "error": "command executor is not ready"}
	else:
		result = commands.execute(name, params)
	var ms := Time.get_ticks_msec() - t0
	var ok := bool(result.get("ok", false))
	_log("%s %s (%d ms)" % ["✔" if ok else "✘", name, ms])
	_outbox.append({
		"id": id,
		"ok": ok,
		"result": result.get("result"),
		"error": str(result.get("error", "")),
	})


# ══════════════════════════════════════════════════════════════════════════
#  STATUS / CONFIG
# ══════════════════════════════════════════════════════════════════════════
func _status_body() -> Dictionary:
	return {
		"editorId": _editor_id,
		"version": PLUGIN_VERSION,
		"project": str(ProjectSettings.get_setting("application/config/name", "")),
		"projectPath": ProjectSettings.globalize_path("res://"),
		"engine": str(Engine.get_version_info().get("string", "")),
		"openScene": _open_scene_path(),
		"playing": _is_playing(),
		"writeEnabled": bool(commands.allow_write) if commands != null else true,
	}


func _open_scene_path() -> String:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return ""
	return str(root.scene_file_path)


func _is_playing() -> bool:
	if EditorInterface.has_method("is_playing_scene"):
		return EditorInterface.is_playing_scene()
	return false


func _emit_status(data: Variant) -> void:
	var info := {
		"connected": _connected,
		"controller": controller_url,
		"project": str(ProjectSettings.get_setting("application/config/name", "")),
		"project_path": ProjectSettings.globalize_path("res://"),
		"queue": 0,
		"controller_version": "",
		"last_error": _last_error,
		"write_enabled": bool(commands.allow_write) if commands != null else true,
	}
	if typeof(data) == TYPE_DICTIONARY:
		var d: Dictionary = data
		if d.has("controller") and typeof(d["controller"]) == TYPE_DICTIONARY:
			info["controller_version"] = str(d["controller"].get("version", ""))
		info["queue"] = int(d.get("queue", 0))
	var sig := "%s|%s|%s|%s|%s|%s" % [
		info["connected"], info["project"], info["queue"],
		info["controller_version"], info["write_enabled"], info["last_error"],
	]
	if sig == _last_status_sig:
		return
	_last_status_sig = sig
	status_changed.emit(info)


func _load_config() -> void:
	var cfg := ConfigFile.new()
	if cfg.load(CONFIG_PATH) != OK:
		return
	controller_url = str(cfg.get_value("controller", "url", controller_url))
	enabled = bool(cfg.get_value("controller", "enabled", enabled))
	if commands != null:
		commands.allow_write = bool(cfg.get_value("editor", "allow_write", commands.allow_write))


func save_config() -> void:
	var cfg := ConfigFile.new()
	cfg.set_value("controller", "url", controller_url)
	cfg.set_value("controller", "enabled", enabled)
	if commands != null:
		cfg.set_value("editor", "allow_write", commands.allow_write)
	cfg.save(CONFIG_PATH)


func set_controller_url(url: String) -> bool:
	var clean := url.strip_edges().trim_suffix("/")
	if not (clean.begins_with("http://") or clean.begins_with("https://")):
		_log("Invalid controller URL: %s" % url)
		return false
	controller_url = clean
	save_config()
	reconnect()
	return true


func set_enabled(on: bool) -> void:
	enabled = on
	save_config()
	if on:
		reconnect()


func reconnect() -> void:
	_failures = 0
	_poll_interval = BASE_INTERVAL
	_timer = BASE_INTERVAL
	_connected = false
	_last_error = ""
	_last_status_sig = ""
	_log("Reconnecting → %s" % controller_url)
	_emit_status({})


func is_connected_to_controller() -> bool:
	return _connected


func _log(text: String) -> void:
	print("[NonZeroScript] ", text)
	log_line.emit(text)
