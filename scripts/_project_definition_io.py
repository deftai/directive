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
import tempfile
from pathlib import Path
from typing import Any

_PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"


class ProjectDefinitionIOError(Exception):
    """Raised when the PROJECT-DEFINITION file is missing or malformed."""


def project_definition_path(project_root: Path) -> Path:
    return project_root / _PROJECT_DEFINITION_REL_PATH


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
