"""Atomic PROJECT-DEFINITION read/write helpers (D14 / #1133).

Shared by ``scripts/triage_subscribe.py`` and
``scripts/triage_scope_drift.py`` for the typed-policy mutation
surface introduced by D14 (subscribe / unsubscribe / ignore verbs).

Mirrors the atomic-write pattern in ``scripts/cache.py::_atomic_write_text``
(tempfile + ``os.replace``) so a crash mid-write leaves the file
untouched. The lifecycle file (``vbrief/PROJECT-DEFINITION.vbrief.json``)
is the only file these helpers touch; the typed policy block lives at
``data["plan"]["policy"]``.

Pure stdlib. No third-party dependencies.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

_PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"
_mutation_thread_lock = threading.Lock()


class ProjectDefinitionIOError(Exception):
    """Raised when the PROJECT-DEFINITION file is missing or malformed."""


def project_definition_path(project_root: Path) -> Path:
    return project_root / _PROJECT_DEFINITION_REL_PATH


@contextlib.contextmanager
def project_definition_mutation_lock(project_root: Path) -> Iterator[None]:
    """Serialise PROJECT-DEFINITION read-modify-write critical sections.

    The sidecar ``<file>.lock`` is removed on exit -- on the happy path AND
    on an exception -- so a clean mutation never leaves
    ``vbrief/PROJECT-DEFINITION.vbrief.json.lock`` behind for ``git add -A``
    to trap on the next chore commit (#1311). The unlink runs in a
    ``finally`` while the in-process ``_mutation_thread_lock`` is still held,
    so no concurrent in-process acquirer can race it, and is best-effort: a
    cross-process holder (Windows keeps the open file locked) or a benign
    POSIX unlink race simply leaves the (gitignored) sidecar in place rather
    than raising.
    """
    path = project_definition_path(project_root)
    lock_path = path.parent / (path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with _mutation_thread_lock:
        try:
            with open(lock_path, "a+b") as fh:
                if not lock_path.stat().st_size:
                    fh.write(b"\0")
                    fh.flush()
                fh.seek(0)
                if sys.platform == "win32":
                    import msvcrt

                    acquired = False
                    deadline = time.monotonic() + 30.0
                    while True:
                        try:
                            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                            acquired = True
                            break
                        except OSError:
                            if time.monotonic() > deadline:
                                raise
                            time.sleep(0.02)
                    try:
                        yield
                    finally:
                        if acquired:
                            fh.seek(0)
                            with contextlib.suppress(OSError):
                                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
                    try:
                        yield
                    finally:
                        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        finally:
            # The sidecar handle is closed by the `with open(...)` block above
            # BEFORE this unlink (Windows refuses to delete an open file); the
            # unlink is held under _mutation_thread_lock so it cannot race an
            # in-process re-acquire, and is best-effort across processes
            # (#1311 -- do not leave PROJECT-DEFINITION.vbrief.json.lock behind).
            with contextlib.suppress(OSError):
                lock_path.unlink()


def load_project_definition_for_mutation(
    project_root: Path,
) -> tuple[dict[str, Any], Path]:
    """Read PROJECT-DEFINITION.vbrief.json and return ``(data, path)``.

    Raises :class:`ProjectDefinitionIOError` if the file is missing or
    cannot be parsed as a JSON object. The returned dict is a mutable
    deep copy of the on-disk state; callers mutate it and pass it to
    :func:`atomic_write_project_definition` to persist.
    """
    path = project_definition_path(project_root)
    if not path.is_file():
        raise ProjectDefinitionIOError(
            f"PROJECT-DEFINITION not found at {path}; run task triage:welcome / "
            "task triage:bootstrap to scaffold one first."
        )
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ProjectDefinitionIOError(
            f"Could not read PROJECT-DEFINITION at {path}: {exc}"
        ) from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProjectDefinitionIOError(
            f"PROJECT-DEFINITION at {path} is not valid JSON: {exc}"
        ) from exc
    if not isinstance(data, dict):
        raise ProjectDefinitionIOError(
            f"PROJECT-DEFINITION at {path} top-level value is not a JSON object"
        )
    return data, path


def atomic_write_project_definition(path: Path, data: dict[str, Any]) -> None:
    """Atomically write ``data`` to ``path`` as pretty-printed JSON.

    Uses a tempfile + ``os.replace`` so the file is either fully
    written or completely unchanged. The parent directory is created
    on demand for first-write scenarios (fresh consumer installs).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2, ensure_ascii=False, sort_keys=False)
    fd, tmp_name = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(payload)
            if not payload.endswith("\n"):
                fh.write("\n")
            fh.flush()
            with contextlib.suppress(OSError):
                os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
        raise
