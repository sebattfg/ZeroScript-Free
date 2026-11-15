# SPDX-License-Identifier: GPL-3.0-or-later
# NonZeroScript - Godot 4.7.2 editor plugin entry point.
#
# This file must be installed at res://addons/nonzeroscript/plugin.gd.
# It starts the HTTP poller (core/bridge.gd), the command executor
# (core/commands.gd) and the dock (ui/dock.gd).

@tool
extends EditorPlugin

const BridgeScript = preload("res://addons/nonzeroscript/core/bridge.gd")
const CommandsScript = preload("res://addons/nonzeroscript/core/commands.gd")
const DockScript = preload("res://addons/nonzeroscript/ui/dock.gd")

# Untyped on purpose: these hold script instances whose custom properties
# (controller_url, on_status, allow_write…) are not members of Node/Control,
# and GDScript statically rejects unknown members on a typed base class.
var _bridge = null
var _commands = null
var _dock = null


func _enter_tree() -> void:
	_commands = CommandsScript.new()
	_commands.editor = self

	_bridge = BridgeScript.new()
	_bridge.name = "NonZeroScriptBridge"
	_bridge.commands = _commands
	add_child(_bridge)

	_dock = DockScript.new()
	_dock.name = "NonZeroScript"
	_dock.bridge = _bridge
	_dock.commands = _commands
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, _dock)

	if _bridge.has_signal("status_changed"):
		_bridge.status_changed.connect(_dock.on_status)
	if _bridge.has_signal("log_line"):
		_bridge.log_line.connect(_dock.on_log)

	print("[NonZeroScript] plugin loaded - controller: ", _bridge.controller_url)


func _exit_tree() -> void:
	if _dock:
		remove_control_from_docks(_dock)
		_dock.queue_free()
		_dock = null
	if _bridge:
		_bridge.queue_free()
		_bridge = null
	_commands = null
