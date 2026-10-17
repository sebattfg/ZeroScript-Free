# SPDX-License-Identifier: GPL-3.0-or-later
"""Safe, project-scoped tools for local software development.

Independent from Roblox Studio/MCP. This module can be called directly by the
local bridge or wrapped by a dedicated MCP server.
"""
from __future__ import annotations

import difflib
import fnmatch
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

DEFAULT_IGNORES = {
    ".git", ".hg", ".svn", ".next", ".nuxt", ".turbo", ".venv", "venv",
    "__pycache__", "node_modules", "bin", "obj", "dist", "build",
    ".idea", ".vscode", ".pytest_cache", ".mypy_cache",
}
MAX_READ_BYTES = 1_000_000
MAX_RESULTS = 500
MAX_OUTPUT_CHARS = 30_000


class WorkspaceError(RuntimeError):
    """Raised when a workspace request violates policy or cannot be completed."""


class Workspace:
    """A resolved project root with path traversal protection."""

    def __init__(self, root: str | os.PathLike[str]):
        resolved = Path(root).expanduser().resolve()
        if not resolved.exists() or not resolved.is_dir():
            raise WorkspaceError(f"Workspace directory does not exist: {resolved}")
        self.root = resolved

    def _resolve(self, relative_path: str = ".") -> Path:
        if not isinstance(relative_path, str) or not relative_path.strip():
            relative_path = "."
        candidate = (self.root / relative_path).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise WorkspaceError("Path escapes the selected workspace.") from exc
        return candidate

    def describe(self) -> dict[str, Any]:
        return {"root": str(self.root), "name": self.root.name or str(self.root), "exists": True}

    @staticmethod
    def _read_text_exact(target: Path) -> str:
        """Read UTF-8 text without translating CRLF/LF, preserving source EOL style."""
        with target.open("r", encoding="utf-8", newline="") as handle:
            return handle.read()

    @staticmethod
    def _preferred_line_ending(content: str) -> str:
        endings = re.findall(r"\r\n|\r|\n", content)
        if not endings:
            return "\n"
        counts = {ending: endings.count(ending) for ending in set(endings)}
        maximum = max(counts.values())
        return next(ending for ending in endings if counts[ending] == maximum)

    @staticmethod
    def _convert_line_endings(content: str, line_ending: str) -> str:
        normalized = content.replace("\r\n", "\n").replace("\r", "\n")
        if line_ending == "\r\n":
            return normalized.replace("\n", "\r\n")
        if line_ending == "\r":
            return normalized.replace("\n", "\r")
        return normalized

    def list_files(self, path: str = ".", max_results: int = 200, include_hidden: bool = False) -> dict[str, Any]:
        base = self._resolve(path)
        if not base.exists() or not base.is_dir():
            raise WorkspaceError(f"Not a directory: {path}")
        limit = max(1, min(int(max_results), MAX_RESULTS))
        files: list[dict[str, Any]] = []
        truncated = False
        for current, dirs, names in os.walk(base):
            dirs[:] = sorted(
                d for d in dirs
                if d not in DEFAULT_IGNORES and (include_hidden or not d.startswith("."))
                and not (Path(current) / d).is_symlink()
            )
            for name in sorted(names):
                if not include_hidden and name.startswith("."):
                    continue
                item = Path(current) / name
                if item.is_symlink():
                    continue
                try:
                    files.append({
                        "path": item.relative_to(self.root).as_posix(),
                        "size": item.stat().st_size,
                        "is_file": True,
                    })
                except OSError:
                    continue
                if len(files) >= limit:
                    truncated = True
                    break
            if truncated:
                break
        return {"root": str(self.root), "files": files, "truncated": truncated}

    def read_file(self, path: str, max_bytes: int = MAX_READ_BYTES) -> dict[str, Any]:
        target = self._resolve(path)
        if not target.is_file():
            raise WorkspaceError(f"Not a file: {path}")
        size = target.stat().st_size
        allowed = max(1, min(int(max_bytes), MAX_READ_BYTES))
        if size > allowed:
            raise WorkspaceError(f"File is {size} bytes; limit is {allowed}. Read a smaller file or split it.")
        try:
            content = self._read_text_exact(target)
        except UnicodeDecodeError as exc:
            raise WorkspaceError("File is not valid UTF-8 text.") from exc
        return {"path": target.relative_to(self.root).as_posix(), "content": content}

    def search(self, query: str, path: str = ".", max_results: int = 100,
               case_sensitive: bool = False, regex: bool = False) -> dict[str, Any]:
        if not isinstance(query, str) or not query:
            raise WorkspaceError("Search query must not be empty.")
        try:
            expression = re.compile(query if regex else re.escape(query),
                                    0 if case_sensitive else re.IGNORECASE)
        except re.error as exc:
            raise WorkspaceError(f"Invalid search regular expression: {exc}") from exc
        base = self._resolve(path)
        if not base.is_dir():
            raise WorkspaceError(f"Not a directory: {path}")
        limit = max(1, min(int(max_results), MAX_RESULTS))
        matches: list[dict[str, Any]] = []
        visited = 0
        for current, dirs, names in os.walk(base):
            dirs[:] = sorted(d for d in dirs if d not in DEFAULT_IGNORES and not d.startswith(".")
                              and not (Path(current) / d).is_symlink())
            for name in sorted(names):
                if name.startswith("."):
                    continue
                candidate = Path(current) / name
                if candidate.is_symlink():
                    continue
                try:
                    if candidate.stat().st_size > MAX_READ_BYTES:
                        continue
                    content = candidate.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    continue
                visited += 1
                for line_number, line in enumerate(content.splitlines(), 1):
                    found = expression.search(line)
                    if found:
                        matches.append({
                            "path": candidate.relative_to(self.root).as_posix(),
                            "line": line_number,
                            "column": found.start() + 1,
                            "text": line[:500],
                        })
                        if len(matches) >= limit:
                            return {"query": query, "case_sensitive": case_sensitive, "regex": regex,
                                    "matches": matches, "truncated": True, "files_scanned": visited}
        return {"query": query, "case_sensitive": case_sensitive, "regex": regex,
                "matches": matches, "truncated": False, "files_scanned": visited}

    def write_file(self, path: str, content: str) -> dict[str, Any]:
        target = self._resolve(path)
        if not isinstance(content, str):
            raise WorkspaceError("File content must be a string.")
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_READ_BYTES:
            raise WorkspaceError(f"File writes are limited to {MAX_READ_BYTES} bytes.")
        if target.exists() and not target.is_file():
            raise WorkspaceError("Target exists and is not a regular file.")
        existed = target.exists()
        previous = ""
        if existed:
            try:
                previous = self._read_text_exact(target)
            except UnicodeDecodeError as exc:
                raise WorkspaceError("Refusing to overwrite a non-UTF-8 file.") from exc
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="")
        diff = "".join(difflib.unified_diff(
            previous.splitlines(keepends=True),
            content.splitlines(keepends=True),
            fromfile=f"a/{target.relative_to(self.root).as_posix()}",
            tofile=f"b/{target.relative_to(self.root).as_posix()}",
        ))
        return {
            "path": target.relative_to(self.root).as_posix(),
            "bytes_written": len(encoded),
            "created": not existed,
            "diff": diff[:MAX_OUTPUT_CHARS],
        }

    def multi_edit(self, edits: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply a validated batch of exact text replacements across existing files."""
        if not isinstance(edits, list) or not edits:
            raise WorkspaceError("edits must be a non-empty list.")
        if len(edits) > 200:
            raise WorkspaceError("A multi-edit batch is limited to 200 replacements.")

        pending: dict[Path, dict[str, Any]] = {}
        for index, edit in enumerate(edits):
            if not isinstance(edit, dict):
                raise WorkspaceError(f"Edit {index + 1} must be an object.")
            path = edit.get("path")
            old_string = edit.get("old_string")
            new_string = edit.get("new_string")
            replace_all = edit.get("replace_all", False)
            whole_file = edit.get("whole_file", False)
            if not isinstance(path, str) or not path.strip():
                raise WorkspaceError(f"Edit {index + 1} requires a path.")
            if not isinstance(old_string, str) or not old_string:
                raise WorkspaceError(f"Edit {index + 1} requires a non-empty old_string.")
            if not isinstance(new_string, str):
                raise WorkspaceError(f"Edit {index + 1} requires new_string to be a string.")
            if not isinstance(replace_all, bool):
                raise WorkspaceError(f"Edit {index + 1} replace_all must be a boolean.")
            if not isinstance(whole_file, bool):
                raise WorkspaceError(f"Edit {index + 1} whole_file must be a boolean.")

            raw_path = Path(path).expanduser()
            raw_path = raw_path if raw_path.is_absolute() else self.root / raw_path
            if raw_path.is_symlink():
                raise WorkspaceError(f"Edit {index + 1} targets a symbolic link, which is not supported.")
            target = self._resolve(path)
            if target == self.root or not target.is_file():
                raise WorkspaceError(f"Edit {index + 1} target is not an existing regular file: {path}")
            if target.stat().st_size > MAX_READ_BYTES:
                raise WorkspaceError(f"Edit {index + 1} target exceeds the {MAX_READ_BYTES}-byte edit limit.")

            if target not in pending:
                try:
                    original = self._read_text_exact(target)
                except UnicodeDecodeError as exc:
                    raise WorkspaceError(f"Refusing to edit non-UTF-8 file: {path}") from exc
                pending[target] = {
                    "path": target.relative_to(self.root).as_posix(),
                    "original": original,
                    "content": original,
                    "line_ending": self._preferred_line_ending(original),
                    "replacements": 0,
                    "operations": 0,
                }
            current = pending[target]["content"]
            if whole_file:
                if current != old_string:
                    raise WorkspaceError(
                        f"Edit {index + 1}: {path} changed while the edit batch was being prepared; "
                        "no files were changed."
                    )
                occurrences = 1
                updated = new_string
                pending[target]["replacements"] += 1
            else:
                occurrences = current.count(old_string)
                if occurrences == 0:
                    raise WorkspaceError(
                        f"Edit {index + 1}: old_string was not found in {path}; no files were changed."
                    )
                if occurrences > 1 and not replace_all:
                    raise WorkspaceError(
                        f"Edit {index + 1}: old_string appears {occurrences} times in {path}; "
                        "add more context or set replace_all=true. No files were changed."
                    )
                if replace_all:
                    updated = current.replace(old_string, new_string)
                    pending[target]["replacements"] += occurrences
                else:
                    updated = current.replace(old_string, new_string, 1)
                    pending[target]["replacements"] += 1
            pending[target]["content"] = updated
            pending[target]["operations"] += 1

        applied: list[Path] = []
        try:
            for target, item in pending.items():
                item["content"] = self._convert_line_endings(item["content"], item["line_ending"])
                self.write_file(item["path"], item["content"])
                applied.append(target)
        except Exception as exc:
            rollback_errors: list[str] = []
            for target in reversed(applied):
                try:
                    target.write_text(pending[target]["original"], encoding="utf-8", newline="")
                except OSError as rollback_exc:
                    rollback_errors.append(f"{pending[target]['path']}: {rollback_exc}")
            suffix = f" Rollback errors: {'; '.join(rollback_errors)}" if rollback_errors else ""
            raise WorkspaceError(f"Multi-edit failed while writing files: {exc}.{suffix}") from exc

        return {
            "files_changed": len(pending),
            "operations_applied": len(edits),
            "files": [
                {
                    "path": item["path"],
                    "operations": item["operations"],
                    "replacements": item["replacements"],
                    "diff": "".join(difflib.unified_diff(
                        item["original"].splitlines(keepends=True),
                        item["content"].splitlines(keepends=True),
                        fromfile=f"a/{item['path']}",
                        tofile=f"b/{item['path']}",
                    ))[:MAX_OUTPUT_CHARS],
                }
                for item in pending.values()
            ],
        }

    def create_file(self, path: str, content: str = "") -> dict[str, Any]:
        """Create a new UTF-8 file, refusing to overwrite any existing path."""
        if not isinstance(path, str) or not path.strip() or path.strip() in (".", "./"):
            raise WorkspaceError("A non-root file path is required.")
        if not isinstance(content, str):
            raise WorkspaceError("File content must be a string.")
        if len(content.encode("utf-8")) > MAX_READ_BYTES:
            raise WorkspaceError(f"File content exceeds the {MAX_READ_BYTES}-byte creation limit.")
        target = self._resolve(path)
        raw = Path(path).expanduser()
        raw = raw if raw.is_absolute() else self.root / raw
        if raw.is_symlink():
            raise WorkspaceError("Creating through a symbolic link is not supported.")
        if target.exists():
            raise WorkspaceError(f"Path already exists: {path}")
        if not target.parent.is_dir():
            raise WorkspaceError("Parent directory does not exist. Create it first.")
        try:
            with target.open("x", encoding="utf-8", newline="") as handle:
                handle.write(content)
        except FileExistsError as exc:
            raise WorkspaceError(f"Path already exists: {path}") from exc
        return {"path": target.relative_to(self.root).as_posix(), "created": True,
                "type": "file", "bytes": len(content.encode("utf-8"))}

    def create_directory(self, path: str) -> dict[str, Any]:
        """Create a project-relative directory without overwriting existing paths."""
        if not isinstance(path, str) or not path.strip() or path.strip() in (".", "./"):
            raise WorkspaceError("A non-root directory path is required.")
        raw = Path(path).expanduser()
        raw = raw if raw.is_absolute() else self.root / raw
        if raw.is_symlink():
            raise WorkspaceError("Creating through a symbolic link is not supported.")
        target = self._resolve(path)
        if target == self.root:
            raise WorkspaceError("The workspace root cannot be created or replaced.")
        if target.exists():
            raise WorkspaceError(f"Path already exists: {path}")
        target.mkdir(parents=True, exist_ok=False)
        return {"path": target.relative_to(self.root).as_posix(), "created": True, "type": "directory"}

    def move_path(self, source: str, destination: str) -> dict[str, Any]:
        """Rename/move a file or directory within the workspace without overwriting."""
        if not isinstance(source, str) or not source.strip() or not isinstance(destination, str) or not destination.strip():
            raise WorkspaceError("Both source and destination paths are required.")
        raw_source = Path(source).expanduser()
        raw_source = raw_source if raw_source.is_absolute() else self.root / raw_source
        raw_destination = Path(destination).expanduser()
        raw_destination = raw_destination if raw_destination.is_absolute() else self.root / raw_destination
        if raw_source.is_symlink() or raw_destination.is_symlink():
            raise WorkspaceError("Moving symbolic links or replacing symlinks is not supported.")
        old = self._resolve(source)
        new = self._resolve(destination)
        if old == self.root:
            raise WorkspaceError("The workspace root cannot be moved.")
        if not old.exists():
            raise WorkspaceError(f"Source path does not exist: {source}")
        if new.exists():
            raise WorkspaceError(f"Destination already exists: {destination}")
        if not new.parent.is_dir():
            raise WorkspaceError("Destination parent directory must already exist.")
        if old.is_dir() and old in new.parents:
            raise WorkspaceError("A directory cannot be moved into itself or one of its descendants.")
        old.rename(new)
        return {"source": old.relative_to(self.root).as_posix(),
                "destination": new.relative_to(self.root).as_posix(),
                "type": "directory" if new.is_dir() else "file", "moved": True}

    def delete_file(self, path: str) -> dict[str, Any]:
        """Delete one regular file only; directories and symbolic links are refused."""
        raw = Path(path).expanduser()
        raw = raw if raw.is_absolute() else self.root / raw
        if raw.is_symlink():
            raise WorkspaceError("Deleting symbolic links is not supported.")
        target = self._resolve(path)
        if target == self.root:
            raise WorkspaceError("The workspace root cannot be deleted.")
        if not target.exists() or not target.is_file():
            raise WorkspaceError(f"Not an existing regular file: {path}")
        relative = target.relative_to(self.root).as_posix()
        target.unlink()
        return {"path": relative, "deleted": True, "type": "file"}
    def find_files(self, pattern: str = "*", path: str = ".", max_results: int = 200, include_hidden: bool = False) -> dict[str, Any]:
        """Find files by glob against their workspace-relative path or filename."""
        if not isinstance(pattern, str) or not pattern.strip():
            raise WorkspaceError("A file glob pattern is required.")
        base = self._resolve(path)
        if not base.is_dir():
            raise WorkspaceError(f"Not a directory: {path}")
        limit = max(1, min(int(max_results), MAX_RESULTS))
        matches: list[dict[str, Any]] = []
        truncated = False
        for current, dirs, names in os.walk(base):
            dirs[:] = sorted(
                d for d in dirs
                if d not in DEFAULT_IGNORES and (include_hidden or not d.startswith("."))
                and not (Path(current) / d).is_symlink()
            )
            for name in sorted(names):
                if not include_hidden and name.startswith("."):
                    continue
                item = Path(current) / name
                if item.is_symlink():
                    continue
                rel = item.relative_to(self.root).as_posix()
                rel_from_base = item.relative_to(base).as_posix()
                if not (fnmatch.fnmatchcase(rel, pattern) or fnmatch.fnmatchcase(rel_from_base, pattern)
                        or fnmatch.fnmatchcase(name, pattern)):
                    continue
                try:
                    matches.append({"path": rel, "size": item.stat().st_size})
                except OSError:
                    continue
                if len(matches) >= limit:
                    truncated = True
                    break
            if truncated:
                break
        return {"pattern": pattern, "path": base.relative_to(self.root).as_posix() or ".",
                "matches": matches, "truncated": truncated}

    def _builtin_task_catalogue(self) -> list[dict[str, Any]]:
        """Return a whitelist of predictable local tasks for common non-Node project types."""
        root_files = {
            item.name for item in self.root.iterdir()
            if not item.is_symlink() and item.is_file()
        }
        tasks: list[dict[str, Any]] = []

        def add(task: str, name: str, command: list[str], description: str) -> None:
            tasks.append({
                "task": task,
                "name": name,
                "kind": "builtin",
                "command": command,
                "command_label": subprocess.list2cmdline(command),
                "description": description,
            })

        if "pyproject.toml" in root_files or "requirements.txt" in root_files or "Pipfile" in root_files:
            test_manifests = ("pyproject.toml", "requirements.txt", "Pipfile", "tox.ini", "pytest.ini")
            pytest_configured = "pytest.ini" in root_files or "conftest.py" in root_files
            ruff_configured = "ruff.toml" in root_files or ".ruff.toml" in root_files
            mypy_configured = "mypy.ini" in root_files or ".mypy.ini" in root_files
            for manifest_name in test_manifests:
                candidate = self.root / manifest_name
                if candidate.is_symlink() or not candidate.is_file():
                    continue
                try:
                    manifest_text = candidate.read_text(encoding="utf-8", errors="replace")[:200_000].lower()
                except OSError:
                    continue
                pytest_configured = pytest_configured or "pytest" in manifest_text
                ruff_configured = ruff_configured or "ruff" in manifest_text
                mypy_configured = mypy_configured or "mypy" in manifest_text
            if pytest_configured:
                add("python.test", "Python: Run pytest", [sys.executable, "-m", "pytest"],
                    "Run the project's pytest suite.")
            else:
                add("python.test", "Python: Run unit tests", [sys.executable, "-m", "unittest", "discover", "-v"],
                    "Discover and run standard-library unittest tests.")
            add("python.compile", "Python: Compile source", [sys.executable, "-m", "compileall", "-q", "-x", "(\\.venv|venv|node_modules|build|dist|\\.tox)", "."],
                "Compile Python files while skipping common environment and generated directories.")
            if ruff_configured:
                add("python.lint", "Python: Ruff check", [sys.executable, "-m", "ruff", "check", "."],
                    "Run Ruff lint checks when the project configures Ruff.")
                add("python.format", "Python: Ruff format check", [sys.executable, "-m", "ruff", "format", "--check", "."],
                    "Check Ruff formatting without rewriting files.")
            if mypy_configured:
                add("python.typecheck", "Python: Mypy", [sys.executable, "-m", "mypy", "."],
                    "Run Mypy when the project configures it.")

        if "Cargo.toml" in root_files:
            add("rust.test", "Rust: Test", ["cargo", "test"], "Run Cargo tests.")
            add("rust.check", "Rust: Check", ["cargo", "check"], "Check the Rust project without producing final binaries.")
            add("rust.build", "Rust: Build", ["cargo", "build"], "Build the Rust project.")
            add("rust.fmt", "Rust: Format check", ["cargo", "fmt", "--", "--check"], "Check Rust formatting without changing files.")

        if "go.mod" in root_files:
            add("go.test", "Go: Test", ["go", "test", "./..."], "Run Go tests across all packages.")
            add("go.build", "Go: Build", ["go", "build", "./..."], "Build all Go packages.")
            add("go.vet", "Go: Vet", ["go", "vet", "./..."], "Run Go's static analysis checks.")

        if any(name.endswith((".sln", ".csproj")) for name in root_files):
            add("dotnet.build", ".NET: Build", ["dotnet", "build"], "Build the solution or project in the workspace root.")
            add("dotnet.test", ".NET: Test", ["dotnet", "test"], "Run discovered .NET tests.")
            add("dotnet.format", ".NET: Format check", ["dotnet", "format", "--verify-no-changes"], "Verify formatting without rewriting files.")

        if "pom.xml" in root_files:
            add("maven.test", "Maven: Test", ["mvn", "test"], "Run Maven tests.")
            add("maven.package", "Maven: Package", ["mvn", "package"], "Build and package the Maven project.")

        if "build.gradle" in root_files or "build.gradle.kts" in root_files or "settings.gradle" in root_files or "settings.gradle.kts" in root_files:
            add("gradle.test", "Gradle: Test", ["gradle", "test"], "Run Gradle tests.")
            add("gradle.build", "Gradle: Build", ["gradle", "build"], "Build the Gradle project.")

        if "CMakeLists.txt" in root_files:
            add("cmake.configure", "CMake: Configure", ["cmake", "-S", ".", "-B", "build"], "Configure a CMake build directory.")
            add("cmake.build", "CMake: Build", ["cmake", "--build", "build"], "Build the configured CMake project.")

        return tasks

    def project_info(self) -> dict[str, Any]:
        """Summarize common project manifests, package scripts, source mix, and Git state."""
        root_files = sorted(p.name for p in self.root.iterdir() if not p.is_symlink() and p.is_file())
        manifests = [
            "package.json", "pnpm-workspace.yaml", "yarn.lock", "pnpm-lock.yaml",
            "package-lock.json", "pyproject.toml", "requirements.txt", "Pipfile",
            "Cargo.toml", "go.mod", "go.work", "pom.xml", "build.gradle",
            "build.gradle.kts", "settings.gradle", "composer.json", "Gemfile",
            "CMakeLists.txt", "Makefile", "justfile", "Dockerfile",
        ]
        present = [name for name in manifests if not (self.root / name).is_symlink() and (self.root / name).is_file()]
        scripts: dict[str, str] = {}
        package_path = self.root / "package.json"
        declared_package_manager = ""
        package_name = None
        dependency_names: set[str] = set()
        if not package_path.is_symlink() and package_path.is_file():
            try:
                package = json.loads(package_path.read_text(encoding="utf-8"))
                if not isinstance(package, dict):
                    raise ValueError("package.json must contain a JSON object")
                raw_scripts = package.get("scripts") or {}
                scripts = {str(k): str(v) for k, v in raw_scripts.items()} if isinstance(raw_scripts, dict) else {}
                package_name = str(package.get("name") or "").strip() or None
                declared_package_manager = str(package.get("packageManager") or "").split("@", 1)[0].strip().lower()
                for dependency_group in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                    values = package.get(dependency_group) or {}
                    if isinstance(values, dict):
                        dependency_names.update(str(name).lower() for name in values)
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
                scripts = {}
                package_name = None
                dependency_names = set()
        framework_catalogue = [
            ("next", "Next.js"), ("react", "React"), ("vue", "Vue"), ("nuxt", "Nuxt"),
            ("svelte", "Svelte"), ("@sveltejs/kit", "SvelteKit"), ("astro", "Astro"),
            ("@angular/core", "Angular"), ("vite", "Vite"), ("express", "Express"),
            ("fastify", "Fastify"), ("@nestjs/core", "NestJS"), ("electron", "Electron"),
            ("expo", "Expo"), ("react-native", "React Native"), ("tailwindcss", "Tailwind CSS"),
            ("@playwright/test", "Playwright Test"), ("playwright", "Playwright"),
            ("vitest", "Vitest"), ("jest", "Jest"), ("puppeteer", "Puppeteer"),
            ("prisma", "Prisma"), ("@prisma/client", "Prisma"), ("drizzle-orm", "Drizzle"),
            ("three", "Three.js"), ("babylonjs", "Babylon.js"),
        ]
        framework_hints = list(dict.fromkeys(
            label for package_id, label in framework_catalogue if package_id in dependency_names
        ))
        if declared_package_manager in {"pnpm", "yarn", "bun", "npm"}:
            package_manager = declared_package_manager
        elif not (self.root / "pnpm-lock.yaml").is_symlink() and (self.root / "pnpm-lock.yaml").is_file():
            package_manager = "pnpm"
        elif not (self.root / "yarn.lock").is_symlink() and (self.root / "yarn.lock").is_file():
            package_manager = "yarn"
        elif (not (self.root / "bun.lock").is_symlink() and (self.root / "bun.lock").is_file()) or (not (self.root / "bun.lockb").is_symlink() and (self.root / "bun.lockb").is_file()):
            package_manager = "bun"
        elif not package_path.is_symlink() and package_path.is_file():
            package_manager = "npm"
        else:
            package_manager = None
        task_catalogue = [
            {
                "task": "package:" + name,
                "name": name,
                "kind": "package",
                "command_label": f"{package_manager} run {name}" if package_manager else f"run {name}",
                "description": script,
            }
            for name, script in scripts.items()
        ]
        task_catalogue.extend(self._builtin_task_catalogue())
        inventory = self.list_files(max_results=MAX_RESULTS, include_hidden=False)
        extensions: dict[str, int] = {}
        for item in inventory["files"]:
            suffix = Path(item["path"]).suffix.lower() or "[no extension]"
            extensions[suffix] = extensions.get(suffix, 0) + 1

        def is_root_file(name: str) -> bool:
            candidate = self.root / name
            return not candidate.is_symlink() and candidate.is_file()

        if is_root_file("package.json"):
            project_type = "Node.js / JavaScript / TypeScript"
        elif is_root_file("pyproject.toml") or is_root_file("requirements.txt"):
            project_type = "Python"
        elif is_root_file("Cargo.toml"):
            project_type = "Rust"
        elif is_root_file("go.mod"):
            project_type = "Go"
        elif any(name.endswith((".sln", ".csproj")) for name in root_files):
            project_type = ".NET / C#"
        elif is_root_file("CMakeLists.txt"):
            project_type = "C / C++ (CMake)"
        elif is_root_file("pom.xml") or is_root_file("build.gradle"):
            project_type = "Java / JVM"
        else:
            project_type = "mixed or undetected"
        return {
            "root": str(self.root),
            "name": self.root.name or str(self.root),
            "project_type": project_type,
            "is_git_repository": (self.root / ".git").exists(),
            "manifest_files": present,
            "package_name": package_name,
            "package_manager": package_manager,
            "package_scripts": scripts,
            "framework_hints": framework_hints,
            "task_catalogue": task_catalogue,
            "source_file_count": len(inventory["files"]),
            "file_inventory_truncated": inventory["truncated"],
            "extension_counts": dict(sorted(extensions.items(), key=lambda item: (-item[1], item[0]))[:20]),
            "top_level_files": root_files[:100],
        }

    def replace_in_files(
        self,
        query: str,
        replacement: str,
        path: str = ".",
        max_files: int = 100,
        case_sensitive: bool = False,
        regex: bool = False,
        apply: bool = False,
        expected_hash: str = "",
    ) -> dict[str, Any]:
        """Preview or apply a bounded multi-file replacement within the workspace."""
        if not isinstance(query, str) or not query:
            raise WorkspaceError("Replacement search text must not be empty.")
        if not isinstance(replacement, str):
            raise WorkspaceError("Replacement text must be a string.")
        if not isinstance(case_sensitive, bool) or not isinstance(regex, bool) or not isinstance(apply, bool):
            raise WorkspaceError("case_sensitive, regex, and apply must be booleans.")
        if not isinstance(expected_hash, str):
            raise WorkspaceError("expected_hash must be a string.")
        base = self._resolve(path)
        if not base.is_dir():
            raise WorkspaceError(f"Not a directory: {path}")
        file_limit = max(1, min(int(max_files), 100))
        try:
            expression = re.compile(query if regex else re.escape(query), 0 if case_sensitive else re.IGNORECASE)
        except re.error as exc:
            raise WorkspaceError(f"Invalid replacement regular expression: {exc}") from exc

        listing = self.list_files(path, max_results=MAX_RESULTS, include_hidden=False)
        if apply and listing["truncated"]:
            raise WorkspaceError("The workspace scan exceeded the file listing limit. Narrow the replacement path and preview again.")
        pending: list[dict[str, Any]] = []
        skipped_large = 0
        scanned = 0
        total_occurrences = 0
        for entry in listing["files"]:
            target = self.root / entry["path"]
            if target.is_symlink():
                continue
            if entry.get("size", 0) > MAX_READ_BYTES:
                skipped_large += 1
                continue
            try:
                original = self._read_text_exact(target)
            except (OSError, UnicodeDecodeError):
                continue
            scanned += 1
            if regex:
                try:
                    updated, count = expression.subn(replacement, original)
                except re.error as exc:
                    raise WorkspaceError(f"Invalid regex replacement: {exc}") from exc
            else:
                count = len(list(expression.finditer(original)))
                updated = expression.sub(lambda _match: replacement, original)
            if count == 0:
                continue
            if len(pending) >= file_limit:
                if apply:
                    raise WorkspaceError(
                        f"More than {file_limit} files would change. Narrow the path or increase max_files, then preview again."
                    )
                break
            line_ending = self._preferred_line_ending(original)
            updated = self._convert_line_endings(updated, line_ending)
            pending.append({
                "path": entry["path"],
                "original": original,
                "updated": updated,
                "replacements": count,
                "diff": "".join(difflib.unified_diff(
                    original.splitlines(keepends=True),
                    updated.splitlines(keepends=True),
                    fromfile=f"a/{entry['path']}",
                    tofile=f"b/{entry['path']}",
                ))[:MAX_OUTPUT_CHARS],
            })
            total_occurrences += count

        # Bind the confirmation token to the exact matching file contents and
        # replacement parameters. Applying a stale preview is refused.
        digest = hashlib.sha256()
        digest.update(query.encode("utf-8"))
        digest.update(b"\0")
        digest.update(replacement.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str((path, case_sensitive, regex, file_limit)).encode("utf-8"))
        for item in pending:
            digest.update(b"\0")
            digest.update(item["path"].encode("utf-8"))
            digest.update(b"\0")
            digest.update(item["original"].encode("utf-8"))
            digest.update(b"\0")
            digest.update(item["updated"].encode("utf-8"))
        token = digest.hexdigest()

        if apply:
            if not expected_hash:
                raise WorkspaceError("Applying a replacement requires the expected_hash from a preview.")
            if expected_hash != token:
                raise WorkspaceError("Project files changed after the preview. Run Preview Replace All again before applying.")
            if not pending:
                return {
                    "applied": True, "files_changed": 0, "replacements": 0,
                    "files_scanned": scanned, "skipped_large_files": skipped_large,
                    "message": "No matching text remains; no files were changed.",
                }
            edits = [
                {"path": item["path"], "old_string": item["original"], "new_string": item["updated"], "whole_file": True}
                for item in pending
            ]
            changed = self.multi_edit(edits)
            return {
                "applied": True,
                "files_changed": changed["files_changed"],
                "replacements": total_occurrences,
                "files_scanned": scanned,
                "skipped_large_files": skipped_large,
                "files": changed["files"],
                "message": f"Replaced {total_occurrences} occurrence(s) across {changed['files_changed']} file(s).",
            }

        return {
            "applied": False,
            "preview_hash": token,
            "files_changed": len(pending),
            "replacements": total_occurrences,
            "files_scanned": scanned,
            "skipped_large_files": skipped_large,
            "truncated": bool(listing["truncated"] or len(pending) >= file_limit),
            "files": [
                {"path": item["path"], "replacements": item["replacements"], "diff": item["diff"]}
                for item in pending
            ],
        }

    def run_task(self, task: str, timeout: int = 300) -> dict[str, Any]:
        """Run a declared package.json script or a whitelisted language task."""
        if not isinstance(task, str) or not task.strip():
            raise WorkspaceError("A task name is required.")
        name = task.strip()
        timeout = max(1, min(int(timeout), 300))
        builtins = {item["task"]: item for item in self._builtin_task_catalogue()}

        # Built-ins have namespaced keys, so they cannot be confused with plain
        # package script names. These argv arrays come only from our whitelist.
        if name in builtins:
            selected = builtins[name]
            result = self._run(selected["command"], timeout=timeout)
            return {**selected, **result, "timeout": timeout}

        explicit_package_task = name.startswith("package:")
        script_name = name[len("package:"):] if explicit_package_task else name
        package_path = self.root / "package.json"
        scripts: dict[str, Any] = {}
        if not package_path.is_symlink() and package_path.is_file():
            try:
                package = json.loads(package_path.read_text(encoding="utf-8"))
                if not isinstance(package, dict):
                    raise ValueError("package.json must contain a JSON object")
                raw_scripts = package.get("scripts") or {}
                scripts = raw_scripts if isinstance(raw_scripts, dict) else {}
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                raise WorkspaceError(f"Could not read package.json: {exc}") from exc

        if script_name and script_name in scripts:
            details = self.project_info()
            manager = details.get("package_manager")
            if manager not in {"npm", "pnpm", "yarn", "bun"}:
                raise WorkspaceError("No supported package manager could be detected for this project.")
            command = [manager, "run", script_name]
            result = self._run(command, timeout=timeout)
            return {
                "task": "package:" + script_name if explicit_package_task else script_name,
                "name": script_name,
                "kind": "package",
                "script": str(scripts[script_name]),
                "package_manager": manager,
                "command_label": " ".join(command),
                **result,
            }

        available = ["package:" + str(key) for key in scripts]
        available.extend(builtins)
        suffix = ", ".join(available[:40])
        raise WorkspaceError(
            f"Task '{name}' is not available for this workspace."
            + (f" Available tasks: {suffix}" if suffix else "")
        )

    def symbols(self, query: str = "", path: str = ".", max_results: int = 200) -> dict[str, Any]:
        """Find likely function/type/variable declarations using language-neutral patterns."""
        base = self._resolve(path)
        if not base.is_dir():
            raise WorkspaceError(f"Not a directory: {path}")
        limit = max(1, min(int(max_results), MAX_RESULTS))
        patterns = [
            ("function", re.compile(r"^\s*(?:(?:export|public|private|protected|static|async|local|pub|crate)\s+)*(?:function|def|fn)\s+([A-Za-z_$][\w$]*)")),
            ("type", re.compile(r"^\s*(?:(?:export|public|private|abstract|sealed|data)\s+)*(?:class|interface|type|enum|struct|trait|record)\s+([A-Za-z_$][\w$]*)")),
            ("variable", re.compile(r"^\s*(?:export\s+)?(?:const|let|var|local)\s+([A-Za-z_$][\w$]*)\s*(?:[:=])")),
        ]
        needle = query.casefold().strip()
        results: list[dict[str, Any]] = []
        scanned = 0
        for current, dirs, names in os.walk(base):
            dirs[:] = sorted(d for d in dirs if d not in DEFAULT_IGNORES and not d.startswith(".")
                              and not (Path(current) / d).is_symlink())
            for name in sorted(names):
                if name.startswith("."):
                    continue
                file_path = Path(current) / name
                if file_path.is_symlink():
                    continue
                try:
                    if file_path.stat().st_size > MAX_READ_BYTES:
                        continue
                    lines = file_path.read_text(encoding="utf-8").splitlines()
                except (OSError, UnicodeDecodeError):
                    continue
                scanned += 1
                for number, line in enumerate(lines, 1):
                    found = None
                    for kind, expression in patterns:
                        match = expression.search(line)
                        if match:
                            found = (kind, match.group(1))
                            break
                    if not found:
                        continue
                    kind, symbol = found
                    if needle and needle not in symbol.casefold() and needle not in line.casefold():
                        continue
                    results.append({
                        "name": symbol, "kind": kind,
                        "path": file_path.relative_to(self.root).as_posix(),
                        "line": number, "text": line.strip()[:500],
                    })
                    if len(results) >= limit:
                        return {"query": query, "symbols": results, "truncated": True, "files_scanned": scanned}
        return {"query": query, "symbols": results, "truncated": False, "files_scanned": scanned}

    def apply_patch(self, path: str, old_string: str, new_string: str, replace_all: bool = False) -> dict[str, Any]:
        """Apply an exact text replacement, refusing ambiguous matches by default."""
        target = self._resolve(path)
        if not target.is_file():
            raise WorkspaceError(f"Patch target is not an existing file: {path}")
        if target.stat().st_size > MAX_READ_BYTES:
            raise WorkspaceError(f"Patch target exceeds the {MAX_READ_BYTES}-byte edit limit.")
        if not isinstance(old_string, str) or not old_string:
            raise WorkspaceError("old_string must be a non-empty exact source fragment.")
        if not isinstance(new_string, str):
            raise WorkspaceError("new_string must be a string.")
        try:
            content = self._read_text_exact(target)
        except UnicodeDecodeError as exc:
            raise WorkspaceError("Refusing to patch a non-UTF-8 file.") from exc
        occurrences = content.count(old_string)
        if occurrences == 0:
            raise WorkspaceError("Exact old_string was not found. Re-read the file and use a smaller, exact patch.")
        if occurrences > 1 and not replace_all:
            raise WorkspaceError(f"Patch is ambiguous: old_string appears {occurrences} times. Include more context or set replace_all=true.")
        line_ending = self._preferred_line_ending(content)
        updated = content.replace(old_string, new_string) if replace_all else content.replace(old_string, new_string, 1)
        updated = self._convert_line_endings(updated, line_ending)
        result = self.write_file(path, updated)
        result["replacements"] = occurrences if replace_all else 1
        return result

    def git_diff(self, staged: bool = False, path: str = ".") -> dict[str, Any]:
        """Return a bounded diff of staged or unstaged changes."""
        relative = self._resolve(path).relative_to(self.root).as_posix()
        command = ["git", "diff", "--no-ext-diff"]
        if staged:
            command.append("--cached")
        if relative not in ("", "."):
            command.extend(["--", relative])
        result = self._run(command, timeout=20)
        return {"staged": bool(staged), "path": relative or ".", **result}

    def git_log(self, limit: int = 10) -> dict[str, Any]:
        """Return recent commit summaries without changing the working tree."""
        count = max(1, min(int(limit), 30))
        return self._run(["git", "log", f"-{count}", "--oneline", "--decorate"], timeout=15)

    def tree(self, path: str = ".", max_depth: int = 4, max_results: int = 300, include_hidden: bool = False) -> dict[str, Any]:
        """Return a bounded, readable project tree without following directory symlinks."""
        base = self._resolve(path)
        if not base.is_dir():
            raise WorkspaceError(f"Not a directory: {path}")
        depth_limit = max(0, min(int(max_depth), 12))
        limit = max(1, min(int(max_results), MAX_RESULTS))
        entries: list[dict[str, Any]] = []
        truncated = False
        def walk(directory: Path, depth: int) -> None:
            nonlocal truncated
            if truncated or depth > depth_limit:
                return
            try:
                children = sorted(directory.iterdir(), key=lambda item: item.name.casefold())
            except OSError:
                return
            directories = []
            for item in children:
                if item.is_symlink():
                    continue
                if not include_hidden and item.name.startswith("."):
                    continue
                if item.is_dir():
                    if item.name in DEFAULT_IGNORES:
                        continue
                    directories.append(item)
                elif item.is_file():
                    pass
                else:
                    continue
                try:
                    relative = item.relative_to(self.root).as_posix()
                    size = item.stat().st_size if item.is_file() else None
                except OSError:
                    continue
                entries.append({"name": item.name, "path": relative,
                                "type": "directory" if item.is_dir() else "file",
                                "depth": depth, "size": size})
                if len(entries) >= limit:
                    truncated = True
                    return
            if depth < depth_limit:
                for child in directories:
                    walk(child, depth + 1)
                    if truncated:
                        return
        walk(base, 0)
        return {"root": str(base), "entries": entries, "max_depth": depth_limit, "truncated": truncated}

    def file_outline(self, path: str, max_results: int = 300) -> dict[str, Any]:
        """Extract likely imports, headings, types, and declarations from one text file."""
        target = self._resolve(path)
        if not target.is_file():
            raise WorkspaceError(f"Not a file: {path}")
        result = self.read_file(path)
        limit = max(1, min(int(max_results), MAX_RESULTS))
        lines = result["content"].splitlines()
        patterns = [
            ("heading", re.compile(r"^\s*(?:#{1,6}\s+.+|//[-=]{3,}.*)$")),
            ("import", re.compile(r"^\s*(?:import\s|from\s+\S+\s+import\s|require\s*\(|using\s+\S+|#include\s*[<\"]|local\s+\w+\s*=\s*require\s*\()")),
            ("declaration", re.compile(r"^\s*(?:(?:export|public|private|protected|static|async|local|pub|crate|abstract|sealed|data)\s+)*(?:function|def|fn|class|interface|type|enum|struct|trait|record)\s+[A-Za-z_$][\w$]*")),
            ("variable", re.compile(r"^\s*(?:export\s+)?(?:const|let|var|local)\s+[A-Za-z_$][\w$]*\s*(?:[:=])")),
        ]
        outline = []
        for number, line in enumerate(lines, 1):
            for kind, expression in patterns:
                if expression.search(line):
                    outline.append({"line": number, "kind": kind, "text": line.strip()[:500]})
                    break
            if len(outline) >= limit:
                break
        return {"path": target.relative_to(self.root).as_posix(), "total_lines": len(lines),
                "outline": outline, "truncated": len(outline) >= limit}

    def git_changed_files(self) -> dict[str, Any]:
        """List changed paths from Git porcelain output, including staged and untracked state."""
        result = self._run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], timeout=20)
        if result["exit_code"] != 0:
            return {"exit_code": result["exit_code"], "output": result["output"], "files": []}
        fields = result["output"].split("\x00")
        files: list[dict[str, Any]] = []
        index = 0
        while index < len(fields):
            record = fields[index]
            index += 1
            if not record or len(record) < 4:
                continue
            x, y = record[0], record[1]
            path = record[3:]
            if not path:
                continue
            original_path = None
            if "R" in (x, y) or "C" in (x, y):
                if index < len(fields):
                    original_path = fields[index] or None
                    index += 1
            code = x + y
            if code == "??":
                kind = "untracked"
            elif "D" in code:
                kind = "deleted"
            elif "R" in code or "C" in code:
                kind = "renamed"
            elif "A" in code:
                kind = "added"
            elif "M" in code:
                kind = "modified"
            else:
                kind = "changed"
            files.append({
                "path": path,
                "status": code,
                "kind": kind,
                "staged": x not in (" ", "?"),
                "unstaged": y not in (" ", "?"),
                "untracked": code == "??",
                "original_path": original_path,
            })
        return {"exit_code": 0, "files": files, "count": len(files)}

    def git_stage_file(self, path: str) -> dict[str, Any]:
        """Stage one workspace-relative file in Git without executing a shell."""
        if not isinstance(path, str) or not path.strip() or path.strip() in (".", "./"):
            raise WorkspaceError("Select a single workspace-relative file to stage.")
        raw_target = Path(path).expanduser()
        raw_target = raw_target if raw_target.is_absolute() else self.root / raw_target
        if raw_target.is_symlink():
            raise WorkspaceError("Staging symbolic links is not supported.")
        target = self._resolve(path)
        if target.exists() and target.is_dir():
            raise WorkspaceError("Only one file can be staged with this tool; directories are refused.")
        relative = target.relative_to(self.root).as_posix()
        return self._run(["git", "add", "--", relative], timeout=30)

    def git_unstage_file(self, path: str) -> dict[str, Any]:
        """Remove one path from the Git index without changing working-tree contents."""
        if not isinstance(path, str) or not path.strip() or path.strip() in (".", "./"):
            raise WorkspaceError("Select a single workspace-relative file to unstage.")
        raw_target = Path(path).expanduser()
        raw_target = raw_target if raw_target.is_absolute() else self.root / raw_target
        if raw_target.is_symlink():
            raise WorkspaceError("Unstaging through symbolic links is not supported.")
        target = self._resolve(path)
        if target.exists() and target.is_dir():
            raise WorkspaceError("Only one file can be unstaged with this tool; directories are refused.")
        relative = target.relative_to(self.root).as_posix()
        return self._run(["git", "restore", "--staged", "--", relative], timeout=30)

    def git_commit(self, message: str) -> dict[str, Any]:
        """Create a local Git commit from already-staged changes. Does not push."""
        if not isinstance(message, str) or not message.strip():
            raise WorkspaceError("A non-empty commit message is required.")
        cleaned = message.strip()
        if len(cleaned) > 500:
            raise WorkspaceError("Commit messages are limited to 500 characters.")
        if any(ord(character) < 32 or ord(character) == 127 for character in cleaned):
            raise WorkspaceError("Commit message contains unsupported control characters.")
        return self._run(["git", "commit", "-m", cleaned], timeout=60)

    def git_branches(self) -> dict[str, Any]:
        """List local and remote Git refs without changing repository state."""
        return self._run(["git", "branch", "--all", "--no-color"], timeout=15)
    def git_status(self) -> dict[str, Any]:
        result = self._run(["git", "status", "--short", "--branch"], timeout=15)
        return {"exit_code": result["exit_code"], "output": result["output"]}

    def run_command(self, command: list[str], timeout: int = 60) -> dict[str, Any]:
        """Run an argv array inside the project. Shell expansion is disabled."""
        if not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command):
            raise WorkspaceError("Command must be a non-empty array of strings.")
        if len(command) > 100 or any("\x00" in item for item in command):
            raise WorkspaceError("Invalid command arguments.")
        return self._run(command, timeout=timeout)

    def _run(self, command: list[str], timeout: int = 60) -> dict[str, Any]:
        timeout = max(1, min(int(timeout), 300))
        try:
            completed = subprocess.run(
                command, cwd=self.root, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
                timeout=timeout, shell=False, check=False,
            )
            return {
                "command": command, "exit_code": completed.returncode,
                "output": completed.stdout[-MAX_OUTPUT_CHARS:], "timed_out": False,
            }
        except FileNotFoundError:
            return {
                "command": command, "exit_code": 127,
                "output": f"Command not found: {command[0]}", "timed_out": False,
            }
        except subprocess.TimeoutExpired as exc:
            output = exc.stdout or ""
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
            return {
                "command": command, "exit_code": None,
                "output": str(output)[-MAX_OUTPUT_CHARS:] + f"\nCommand timed out after {timeout}s.",
                "timed_out": True,
            }
