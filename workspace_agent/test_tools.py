# SPDX-License-Identifier: GPL-3.0-or-later
import shutil
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from workspace_agent.tools import Workspace, WorkspaceError


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ws = Workspace(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_read_write_and_diff(self):
        result = self.ws.write_file("src/main.py", "print('hello')\n")
        self.assertEqual(result["path"], "src/main.py")
        self.assertTrue(result["created"])
        self.assertIn("+print('hello')", result["diff"])
        self.assertEqual(self.ws.read_file("src/main.py")["content"], "print('hello')\n")

        result = self.ws.write_file("src/main.py", "print('updated')\n")
        self.assertFalse(result["created"])
        self.assertIn("-print('hello')", result["diff"])
        self.assertIn("+print('updated')", result["diff"])

    def test_read_write_preserves_windows_line_endings(self):
        target = self.root / "source.txt"
        target.write_bytes(b"first\r\nsecond\r\n")
        self.assertEqual(self.ws.read_file("source.txt")["content"], "first\r\nsecond\r\n")
        self.ws.write_file("source.txt", self.ws.read_file("source.txt")["content"].replace("second", "updated"))
        self.assertEqual(target.read_bytes(), b"first\r\nupdated\r\n")

    def test_blocks_path_traversal(self):
        with self.assertRaises(WorkspaceError):
            self.ws.read_file("../outside.txt")
        with self.assertRaises(WorkspaceError):
            self.ws.write_file("../../outside.txt", "bad")

    def test_blocks_symlink_escape(self):
        outside = self.root.parent / (self.root.name + "_outside")
        try:
            outside.mkdir()
            (outside / "secret.txt").write_text("secret", encoding="utf-8")
            (outside / "leak.py").write_text("def leaked_symbol():\n    return 'outside'\n", encoding="utf-8")
            link = self.root / "escape"
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("Symlink creation is not available")
            with self.assertRaises(WorkspaceError):
                self.ws.read_file("escape/secret.txt")
            self.assertEqual(self.ws.search("secret")["matches"], [])
            found_symbols = {item["name"] for item in self.ws.symbols()["symbols"]}
            self.assertNotIn("leaked_symbol", found_symbols)
        finally:
            if outside.exists():
                shutil.rmtree(outside)

    def test_lists_and_searches_project_files(self):
        (self.root / "src").mkdir()
        (self.root / "src" / "app.py").write_text("def greet():\n    return 'hello'\n", encoding="utf-8")
        listing = self.ws.list_files()
        self.assertEqual([item["path"] for item in listing["files"]], ["src/app.py"])
        search = self.ws.search("HELLO")
        self.assertEqual(len(search["matches"]), 1)
        self.assertEqual(search["matches"][0]["line"], 2)

    def test_targeted_patches_preserve_original_eol_style(self):
        target = self.root / "source.txt"
        target.write_bytes(b"VALUE = 1\r\nNAME = old\r\n")
        self.ws.apply_patch("source.txt", "VALUE = 1\r\n", "VALUE = 2\n")
        self.assertEqual(target.read_bytes(), b"VALUE = 2\r\nNAME = old\r\n")
        self.ws.multi_edit([
            {"path": "source.txt", "old_string": "NAME = old\r\n", "new_string": "NAME = new\n"}
        ])
        self.assertEqual(target.read_bytes(), b"VALUE = 2\r\nNAME = new\r\n")

    def test_search_regex_case_sensitivity_and_columns(self):
        self.ws.write_file("src/search.txt", "Hello 123\nhello 456\n")
        sensitive = self.ws.search("Hello", case_sensitive=True)
        self.assertEqual(len(sensitive["matches"]), 1)
        numeric = self.ws.search(r"\d+", regex=True)
        self.assertEqual([item["line"] for item in numeric["matches"]], [1, 2])
        self.assertEqual(numeric["matches"][0]["column"], 7)
        with self.assertRaises(WorkspaceError):
            self.ws.search("[", regex=True)

    def test_finds_files_by_glob(self):
        (self.root / "src").mkdir()
        (self.root / "src" / "main.luau").write_text("return true\n", encoding="utf-8")
        (self.root / "src" / "theme.json").write_text("{}\n", encoding="utf-8")
        result = self.ws.find_files("*.luau")
        self.assertEqual([item["path"] for item in result["matches"]], ["src/main.luau"])

    def test_project_info_detects_node_scripts(self):
        (self.root / "package.json").write_text(
            '{"name":"sample-project","scripts":{"test":"vitest run","build":"tsc"},"devDependencies":{"vitest":"3.0.0"}}',
            encoding="utf-8",
        )
        result = self.ws.project_info()
        self.assertEqual(result["project_type"], "Node.js / JavaScript / TypeScript")
        self.assertEqual(result["package_scripts"]["test"], "vitest run")
        self.assertEqual(result["package_manager"], "npm")
        self.assertEqual(result["package_name"], "sample-project")
        self.assertIn("Vitest", result["framework_hints"])
        self.assertIn("package.json", result["manifest_files"])

    def test_project_info_detects_framework_hints(self):
        (self.root / "package.json").write_text(
            '{"name":"web-app","dependencies":{"next":"15.0.0","react":"19.0.0","tailwindcss":"4.0.0"},'
            '"devDependencies":{"@playwright/test":"1.0.0","typescript":"5.0.0"}}',
            encoding="utf-8",
        )
        result = self.ws.project_info()
        self.assertEqual(result["package_name"], "web-app")
        self.assertEqual(result["framework_hints"], ["Next.js", "React", "Tailwind CSS", "Playwright Test"])

    def test_project_info_gracefully_handles_malformed_package_json(self):
        (self.root / "package.json").write_text("[]", encoding="utf-8")
        result = self.ws.project_info()
        self.assertEqual(result["package_scripts"], {})
        self.assertIsNone(result["package_name"])
        self.assertEqual(result["framework_hints"], [])

    def test_run_task_rejects_malformed_package_json(self):
        (self.root / "package.json").write_text("[]", encoding="utf-8")
        with self.assertRaisesRegex(WorkspaceError, "Could not read package.json"):
            self.ws.run_task("test")

    def test_project_info_uses_declared_package_manager(self):
        (self.root / "package.json").write_text(
            '{"name":"sample-project","packageManager":"pnpm@9.0.0","scripts":{"test":"vitest run"}}',
            encoding="utf-8",
        )
        result = self.ws.project_info()
        self.assertEqual(result["package_manager"], "pnpm")
        self.assertEqual(result["package_scripts"]["test"], "vitest run")

    def test_project_info_catalogues_python_tasks(self):
        (self.root / "pyproject.toml").write_text("[project]\nname='sample'\n", encoding="utf-8")
        result = self.ws.project_info()
        tasks = {item["task"]: item for item in result["task_catalogue"]}
        self.assertIn("python.test", tasks)
        self.assertIn("python.compile", tasks)
        self.assertEqual(tasks["python.test"]["command"][-3:], ["unittest", "discover", "-v"])

    def test_run_task_executes_whitelisted_rust_task(self):
        (self.root / "Cargo.toml").write_text("[package]\nname='sample'\nversion='0.1.0'\n", encoding="utf-8")
        with mock.patch.object(self.ws, "_run", return_value={"exit_code": 0, "output": "ok"}) as mocked:
            result = self.ws.run_task("rust.test", timeout=90)
        self.assertEqual(result["task"], "rust.test")
        mocked.assert_called_once_with(["cargo", "test"], timeout=90)
        with self.assertRaisesRegex(WorkspaceError, "not available"):
            self.ws.run_task("rust.publish")

    def test_run_task_uses_only_declared_package_scripts(self):
        (self.root / "package.json").write_text(
            '{"name":"sample","packageManager":"pnpm@9.0.0","scripts":{"test":"vitest run","build":"vite build"}}',
            encoding="utf-8",
        )
        with mock.patch.object(self.ws, "_run", return_value={"exit_code": 0, "output": "ok"}) as mocked:
            result = self.ws.run_task("test", timeout=45)
        self.assertEqual(result["task"], "test")
        self.assertEqual(result["package_manager"], "pnpm")
        self.assertEqual(result["script"], "vitest run")
        mocked.assert_called_once_with(["pnpm", "run", "test"], timeout=45)
        with mock.patch.object(self.ws, "_run") as mocked:
            with self.assertRaisesRegex(WorkspaceError, "not declared"):
                self.ws.run_task("deploy")
            mocked.assert_not_called()

    def test_symbols_finds_function_and_type(self):
        (self.root / "src").mkdir()
        (self.root / "src" / "app.py").write_text(
            "class WorkspaceManager:\n    def select_workspace(self):\n        return True\n",
            encoding="utf-8",
        )
        result = self.ws.symbols()
        names = {item["name"] for item in result["symbols"]}
        self.assertIn("WorkspaceManager", names)
        self.assertIn("select_workspace", names)

    def test_apply_patch_rejects_ambiguous_match(self):
        self.ws.write_file("src/main.txt", "same\nsame\n")
        with self.assertRaises(WorkspaceError):
            self.ws.apply_patch("src/main.txt", "same", "changed")
        result = self.ws.apply_patch("src/main.txt", "same", "changed", replace_all=True)
        self.assertEqual(result["replacements"], 2)
        self.assertEqual(self.ws.read_file("src/main.txt")["content"], "changed\nchanged\n")

    def test_tree_respects_depth_and_ignored_folders(self):
        (self.root / "src" / "nested").mkdir(parents=True)
        (self.root / "src" / "main.py").write_text("print('ok')\n", encoding="utf-8")
        (self.root / "src" / "nested" / "detail.py").write_text("pass\n", encoding="utf-8")
        (self.root / "node_modules").mkdir()
        (self.root / "node_modules" / "ignored.js").write_text("ignored\n", encoding="utf-8")
        result = self.ws.tree(max_depth=2)
        paths = {item["path"] for item in result["entries"]}
        self.assertIn("src", paths)
        self.assertIn("src/main.py", paths)
        self.assertIn("src/nested", paths)
        self.assertNotIn("node_modules", paths)
        self.assertNotIn("node_modules/ignored.js", paths)

    def test_file_outline_extracts_imports_and_declarations(self):
        self.ws.write_file(
            "src/app.py",
            "from pathlib import Path\n\nclass App:\n    def run(self):\n        return Path('.')\n",
        )
        result = self.ws.file_outline("src/app.py")
        kinds = {item["kind"] for item in result["outline"]}
        self.assertIn("import", kinds)
        self.assertIn("declaration", kinds)
        self.assertEqual(result["path"], "src/app.py")

    def test_replace_in_files_previews_then_applies_and_preserves_line_endings(self):
        (self.root / "src").mkdir()
        first = self.root / "src" / "first.txt"
        second = self.root / "src" / "second.txt"
        first.write_bytes(b"hello world\r\nhello universe\r\n")
        second.write_bytes(b"HELLO there\n")
        preview = self.ws.replace_in_files("hello", "hi", apply=False)
        self.assertFalse(preview["applied"])
        self.assertEqual(preview["files_changed"], 2)
        self.assertEqual(preview["replacements"], 3)
        self.assertTrue(preview["preview_hash"])
        self.assertEqual(first.read_bytes(), b"hello world\r\nhello universe\r\n")
        result = self.ws.replace_in_files("hello", "hi", apply=True, expected_hash=preview["preview_hash"])
        self.assertTrue(result["applied"])
        self.assertEqual(result["files_changed"], 2)
        self.assertEqual(result["replacements"], 3)
        self.assertEqual(first.read_bytes(), b"hi world\r\nhi universe\r\n")
        self.assertEqual(second.read_bytes(), b"hi there\n")

    def test_replace_in_files_rejects_stale_preview(self):
        self.ws.write_file("main.py", "VALUE = 1\n")
        preview = self.ws.replace_in_files("VALUE", "RESULT", apply=False)
        self.ws.write_file("main.py", "VALUE = 2\n")
        with self.assertRaisesRegex(WorkspaceError, "changed after the preview"):
            self.ws.replace_in_files("VALUE", "RESULT", apply=True, expected_hash=preview["preview_hash"])
        self.assertEqual(self.ws.read_file("main.py")["content"], "VALUE = 2\n")

    def test_replace_in_files_supports_regex_groups_and_validates_query(self):
        self.ws.write_file("src.py", "item_12 item_34\nITEM_56\n")
        preview = self.ws.replace_in_files(r"item_(\d+)", r"value_\1", regex=True, case_sensitive=True)
        self.assertEqual(preview["replacements"], 2)
        result = self.ws.replace_in_files(
            r"item_(\d+)", r"value_\1", regex=True, case_sensitive=True,
            apply=True, expected_hash=preview["preview_hash"],
        )
        self.assertEqual(result["replacements"], 2)
        self.assertEqual(self.ws.read_file("src.py")["content"], "value_12 value_34\nITEM_56\n")
        with self.assertRaisesRegex(WorkspaceError, "must not be empty"):
            self.ws.replace_in_files("", "x")
        with self.assertRaisesRegex(WorkspaceError, "Invalid search regular expression"):
            self.ws.replace_in_files("[", "x", regex=True)

    def test_multi_edit_whole_file_requires_exact_current_content(self):
        self.ws.write_file("source.txt", "ORIGINAL CONTENT\n")
        with self.assertRaisesRegex(WorkspaceError, "changed while the edit batch was being prepared"):
            self.ws.multi_edit([{
                "path": "source.txt",
                "old_string": "ORIGINAL",
                "new_string": "REPLACED",
                "whole_file": True,
            }])
        self.assertEqual(self.ws.read_file("source.txt")["content"], "ORIGINAL CONTENT\n")
        result = self.ws.multi_edit([{
            "path": "source.txt",
            "old_string": "ORIGINAL CONTENT\n",
            "new_string": "UPDATED CONTENT\n",
            "whole_file": True,
        }])
        self.assertEqual(result["files_changed"], 1)
        self.assertEqual(self.ws.read_file("source.txt")["content"], "UPDATED CONTENT\n")

    def test_multi_edit_updates_multiple_files_and_returns_diffs(self):
        self.ws.write_file("src/one.py", "VALUE = 1\n")
        self.ws.write_file("src/two.py", "VALUE = 2\n")
        result = self.ws.multi_edit([
            {"path": "src/one.py", "old_string": "VALUE = 1", "new_string": "VALUE = 10"},
            {"path": "src/two.py", "old_string": "VALUE = 2", "new_string": "VALUE = 20"},
        ])
        self.assertEqual(result["files_changed"], 2)
        self.assertEqual(result["operations_applied"], 2)
        self.assertIn("+VALUE = 10", result["files"][0]["diff"])
        self.assertEqual(self.ws.read_file("src/one.py")["content"], "VALUE = 10\n")
        self.assertEqual(self.ws.read_file("src/two.py")["content"], "VALUE = 20\n")

    def test_multi_edit_validates_entire_batch_before_writing(self):
        self.ws.write_file("src/one.py", "VALUE = 1\n")
        self.ws.write_file("src/two.py", "VALUE = 2\n")
        with self.assertRaises(WorkspaceError):
            self.ws.multi_edit([
                {"path": "src/one.py", "old_string": "VALUE = 1", "new_string": "VALUE = 10"},
                {"path": "src/two.py", "old_string": "NOT_PRESENT", "new_string": "VALUE = 20"},
            ])
        self.assertEqual(self.ws.read_file("src/one.py")["content"], "VALUE = 1\n")
        self.assertEqual(self.ws.read_file("src/two.py")["content"], "VALUE = 2\n")

    def test_multi_edit_rejects_ambiguous_matches(self):
        self.ws.write_file("src/ambiguous.py", "X = 1\nX = 1\n")
        with self.assertRaisesRegex(WorkspaceError, "appears 2 times"):
            self.ws.multi_edit([
                {"path": "src/ambiguous.py", "old_string": "X = 1", "new_string": "X = 2"}
            ])
        self.assertEqual(self.ws.read_file("src/ambiguous.py")["content"], "X = 1\nX = 1\n")

    def test_create_file_refuses_overwrite_and_requires_parent(self):
        self.ws.create_directory("src")
        result = self.ws.create_file("src/new.py", "print('new')\n")
        self.assertTrue(result["created"])
        self.assertEqual(self.ws.read_file("src/new.py")["content"], "print('new')\n")
        with self.assertRaises(WorkspaceError):
            self.ws.create_file("src/new.py", "do not overwrite")
        self.assertEqual(self.ws.read_file("src/new.py")["content"], "print('new')\n")
        with self.assertRaises(WorkspaceError):
            self.ws.create_file("src/missing/nested.py", "no parents created")

    def test_create_move_and_delete_paths(self):
        created = self.ws.create_directory("src/generated")
        self.assertEqual(created["type"], "directory")
        self.ws.write_file("src/generated/app.txt", "hello\n")
        moved = self.ws.move_path("src/generated/app.txt", "src/app.txt")
        self.assertTrue(moved["moved"])
        self.assertEqual(self.ws.read_file("src/app.txt")["content"], "hello\n")
        deleted = self.ws.delete_file("src/app.txt")
        self.assertTrue(deleted["deleted"])
        self.assertFalse((self.root / "src" / "app.txt").exists())

    def test_path_lifecycle_refuses_overwrite_and_directory_delete(self):
        self.ws.create_directory("src")
        self.ws.write_file("src/existing.txt", "existing\n")
        self.ws.write_file("src/other.txt", "other\n")
        with self.assertRaises(WorkspaceError):
            self.ws.move_path("src/other.txt", "src/existing.txt")
        with self.assertRaises(WorkspaceError):
            self.ws.delete_file("src")
        with self.assertRaises(WorkspaceError):
            self.ws.move_path(".", "backup")

    def test_git_changed_files_parses_staged_unstaged_and_untracked(self):
        porcelain = " M src/main.py\\x00A  src/new file.py\\x00?? notes.md\\x00"
        with mock.patch.object(self.ws, "_run", return_value={"exit_code": 0, "output": porcelain}) as mocked:
            result = self.ws.git_changed_files()
        self.assertEqual(result["count"], 3)
        by_path = {item["path"]: item for item in result["files"]}
        self.assertTrue(by_path["src/main.py"]["unstaged"])
        self.assertFalse(by_path["src/main.py"]["staged"])
        self.assertTrue(by_path["src/new file.py"]["staged"])
        self.assertFalse(by_path["src/new file.py"]["unstaged"])
        self.assertTrue(by_path["notes.md"]["untracked"])
        mocked.assert_called_once_with(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], timeout=20)

    def test_git_stage_file_scopes_to_one_path(self):
        (self.root / "src").mkdir()
        (self.root / "src" / "main.py").write_text("print('ok')\n", encoding="utf-8")
        with mock.patch.object(self.ws, "_run", return_value={"exit_code": 0, "output": ""}) as mocked:
            result = self.ws.git_stage_file("src/main.py")
        self.assertEqual(result["exit_code"], 0)
        mocked.assert_called_once_with(["git", "add", "--", "src/main.py"], timeout=30)
        with self.assertRaises(WorkspaceError):
            self.ws.git_stage_file(".")

    def test_git_stage_refuses_symbolic_links(self):
        target = self.root / "target.txt"
        target.write_text("source\n", encoding="utf-8")
        link = self.root / "link.txt"
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest("Symlink creation is not available")
        with self.assertRaisesRegex(WorkspaceError, "symbolic links"):
            self.ws.git_stage_file("link.txt")

    def test_git_unstage_does_not_touch_working_tree(self):
        with mock.patch.object(self.ws, "_run", return_value={"exit_code": 0, "output": ""}) as mocked:
            result = self.ws.git_unstage_file("src/main.py")
        self.assertEqual(result["exit_code"], 0)
        mocked.assert_called_once_with(["git", "restore", "--staged", "--", "src/main.py"], timeout=30)

    def test_git_commit_validates_message_and_does_not_use_shell(self):
        with mock.patch.object(self.ws, "_run", return_value={"exit_code": 0, "output": "[main abc] test"}) as mocked:
            result = self.ws.git_commit("  test commit  ")
        self.assertEqual(result["exit_code"], 0)
        mocked.assert_called_once_with(["git", "commit", "-m", "test commit"], timeout=60)
        with self.assertRaises(WorkspaceError):
            self.ws.git_commit(" ")
        with self.assertRaises(WorkspaceError):
            self.ws.git_commit("x" * 501)

    def test_run_command_without_shell(self):
        result = self.ws.run_command([sys.executable, "-c", "print('workspace-ok')"])
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("workspace-ok", result["output"])

    def test_run_command_validates_argv(self):
        with self.assertRaises(WorkspaceError):
            self.ws.run_command("echo unsafe")  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
