# SPDX-License-Identifier: GPL-3.0-or-later
# NonZeroScript - editor dock (Godot 4.7.2).
# Shows the controller connection, lets the user change the URL, disable
# writing, rescan the project and open the visual console.

@tool
extends VBoxContainer

# Untyped: these are script instances with custom properties/methods, not
# plain Node/RefCounted members.
var bridge = null
var commands = null

var _status: Label
var _detail: Label
var _url: LineEdit
var _allow: CheckBox
var _enabled: CheckBox
var _log: RichTextLabel
var _log_lines: Array = []


func _ready() -> void:
	custom_minimum_size = Vector2(282, 250)
	add_theme_constant_override("separation", 6)
	_build()
	if bridge != null:
		_url.text = str(bridge.controller_url)
		_enabled.button_pressed = bool(bridge.enabled)
	if commands != null:
		_allow.button_pressed = bool(commands.allow_write)


func _build() -> void:
	var title := Label.new()
	title.text = "NonZeroScript"
	title.add_theme_font_size_override("font_size", 15)
	add_child(title)

	var sub := Label.new()
	sub.text = "Godot 4.7.2 · 中转 + 浏览器扩展"
	sub.add_theme_font_size_override("font_size", 10)
	sub.add_theme_color_override("font_color", Color(1, 1, 1, 0.5))
	add_child(sub)

	_status = Label.new()
	_status.text = "● 未连接"
	_status.add_theme_color_override("font_color", Color(0.97, 0.44, 0.44))
	_status.add_theme_font_size_override("font_size", 12)
	add_child(_status)

	_detail = Label.new()
	_detail.text = "打开 controller 后会自动连接"
	_detail.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_detail.add_theme_font_size_override("font_size", 10)
	_detail.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	add_child(_detail)

	add_child(HSeparator.new())

	var url_label := Label.new()
	url_label.text = "中转地址"
	url_label.add_theme_font_size_override("font_size", 10)
	url_label.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	add_child(url_label)

	var row := HBoxContainer.new()
	_url = LineEdit.new()
	_url.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_url.placeholder_text = "http://127.0.0.1:8790"
	row.add_child(_url)
	var apply := Button.new()
	apply.text = "应用"
	apply.pressed.connect(_on_apply_url)
	row.add_child(apply)
	add_child(row)

	_enabled = CheckBox.new()
	_enabled.text = "启用中转连接"
	_enabled.button_pressed = true
	_enabled.toggled.connect(_on_enabled)
	add_child(_enabled)

	_allow = CheckBox.new()
	_allow.text = "允许 AI 写入 / 修改场景"
	_allow.button_pressed = true
	_allow.tooltip_text = "关闭后，所有写文件、改场景、项目设置命令都会被拒绝。"
	_allow.toggled.connect(_on_allow_write)
	add_child(_allow)

	var actions := HFlowContainer.new()
	actions.add_theme_constant_override("h_separation", 4)
	var reconnect := Button.new()
	reconnect.text = "重新连接"
	reconnect.pressed.connect(_on_reconnect)
	actions.add_child(reconnect)
	var scan := Button.new()
	scan.text = "扫描文件"
	scan.pressed.connect(_on_scan)
	actions.add_child(scan)
	var open := Button.new()
	open.text = "打开操控台"
	open.pressed.connect(_on_open_console)
	actions.add_child(open)
	add_child(actions)

	add_child(HSeparator.new())

	var log_label := Label.new()
	log_label.text = "最近命令"
	log_label.add_theme_font_size_override("font_size", 10)
	log_label.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	add_child(log_label)

	_log = RichTextLabel.new()
	_log.custom_minimum_size = Vector2(0, 130)
	_log.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_log.scroll_following = true
	_log.bbcode_enabled = false
	_log.add_theme_font_size_override("normal_font_size", 10)
	_log.add_theme_color_override("default_color", Color(0.82, 0.84, 0.9))
	add_child(_log)


# ══════════════════════════════════════════════════════════════════════════
#  SIGNALS FROM THE BRIDGE
# ══════════════════════════════════════════════════════════════════════════
func on_status(info: Dictionary) -> void:
	if _status == null:
		return
	var connected := bool(info.get("connected", false))
	var project := str(info.get("project", ""))
	if connected:
		_status.text = "● 已连接" + (" · " + project if not project.is_empty() else "")
		_status.add_theme_color_override("font_color", Color(0.2, 0.83, 0.6))
		var ver := str(info.get("controller_version", ""))
		var queue := int(info.get("queue", 0))
		var parts: Array = []
		if not ver.is_empty():
			parts.append("v" + ver)
		parts.append("待执行 %d" % queue)
		parts.append("写入 " + ("开" if bool(info.get("write_enabled", true)) else "关"))
		_detail.text = " · ".join(parts)
	else:
		_status.text = "● 未连接"
		_status.add_theme_color_override("font_color", Color(0.97, 0.44, 0.44))
		var why := str(info.get("last_error", ""))
		_detail.text = "无法连接中转：%s\n请先启动 controller（start.bat / start.command）。" % (why if not why.is_empty() else "未启动")


func on_log(text: String) -> void:
	if _log == null:
		return
	_log_lines.append(text)
	while _log_lines.size() > 140:
		_log_lines.pop_front()
	_log.text = "\n".join(_log_lines)


# ══════════════════════════════════════════════════════════════════════════
#  BUTTONS
# ══════════════════════════════════════════════════════════════════════════
func _on_apply_url() -> void:
	if bridge == null:
		return
	if bridge.set_controller_url(_url.text):
		_detail.text = "已保存地址，正在重连…"
	else:
		_detail.text = "地址必须以 http:// 或 https:// 开头"
		_status.text = "● 地址无效"
		_status.add_theme_color_override("font_color", Color(0.97, 0.44, 0.44))


func _on_enabled(on: bool) -> void:
	if bridge != null:
		bridge.set_enabled(on)
	if not on:
		_status.text = "● 已停用"
		_status.add_theme_color_override("font_color", Color(1, 1, 1, 0.45))


func _on_allow_write(on: bool) -> void:
	if commands != null:
		commands.allow_write = on
	if bridge != null:
		bridge.save_config()


func _on_reconnect() -> void:
	if bridge != null:
		bridge.reconnect()


func _on_scan() -> void:
	if EditorInterface.has_method("get_resource_filesystem"):
		EditorInterface.get_resource_filesystem().scan()
		_detail.text = "已请求重新扫描项目文件"


func _on_open_console() -> void:
	if bridge != null:
		OS.shell_open(str(bridge.controller_url))
