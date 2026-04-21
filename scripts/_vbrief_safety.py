"""
_vbrief_safety.py -- Safety helpers for `task migrate:vbrief` (#497, #506 D7).

# --- safety (Agent C, #497) ---

Implements the four safety affordances for the destructive-default migrator:

1. Always-on `.premigrate.*` backups of every pre-cutover input before any
   destructive write (#497-1).
2. `--dry-run` preview that produces the migration plan without touching the
   filesystem (#497-2).  Implemented via a `dry_run` flag threaded through the
   migration entry point; this module contributes the guard helpers.
3. Dirty-tree guard: refuses to run on a non-clean `git status --porcelain`
   unless the caller passes `--force` (#497-3).
4. `--rollback` path: restores from `.premigrate.*` backups and removes the
   scope vBRIEFs / migration artefacts that a prior run created (#497-4),
   using a manifest written by the migrator at the end of a successful run.

Coordinates with #498 (validation failure keeps backups + writes partial
output to `vbrief.invalid/`) -- that scope is owned by Agent D; nothing in
this module should ever delete a `.premigrate.*` file outside of the
`rollback()` path.

Source of truth for the decisions above is tracking issue #506.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Filesystem constants
# ---------------------------------------------------------------------------

PREMIGRATE_SUFFIX = ".premigrate"
"""Infix written between the filename stem and its extension for backups.

Example: ``SPECIFICATION.md`` -> ``SPECIFICATION.premigrate.md``;
``specification.vbrief.json`` -> ``specification.premigrate.vbrief.json``.
"""

SAFETY_MANIFEST_NAME = "safety-manifest.json"
"""Manifest filename under ``vbrief/migration/`` that records per-run state."""

MIGRATION_DIR = "migration"
"""Subdirectory of ``vbrief/`` where migration-report artefacts live (#506)."""

LEGACY_DIR = "legacy"
"""Subdirectory of ``vbrief/`` where oversize legacy captures spill (#505)."""

# The four project-root markdown inputs and one JSON input the migrator
# consumes.  PRD.md is optional -- only backed up when it exists.  PRD.md is
# intentionally included so that operators who ran `task prd:render` before
# migrating can still recover its pre-cutover contents.
_ROOT_MD_INPUTS: tuple[str, ...] = (
    "SPECIFICATION.md",
    "PROJECT.md",
    "ROADMAP.md",
    "PRD.md",
)

_VBRIEF_JSON_INPUTS: tuple[str, ...] = (
    "specification.vbrief.json",
)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class BackupRecord:
    """Single backup entry recorded in the safety manifest."""

    source: str
    """Project-root-relative path of the pre-cutover input."""

    backup: str
    """Project-root-relative path of the ``.premigrate.*`` copy."""

    source_sha256: str
    """Hex digest of the pre-cutover content at backup time."""

    size_bytes: int
    """Byte count of the pre-cutover content at backup time."""


@dataclass
class SafetyManifest:
    """State recorded at the end of a successful migration for rollback."""

    version: str = "1"
    migration_timestamp: str = ""
    backups: list[BackupRecord] = field(default_factory=list)
    created_files: list[str] = field(default_factory=list)
    """Project-root-relative paths of files the migrator wrote."""

    created_dirs: list[str] = field(default_factory=list)
    """Project-root-relative paths of directories the migrator created.

    Only includes directories that did NOT exist before the migration so
    rollback can remove them without clobbering pre-existing structure.
    """

    post_migration_stub_hashes: dict[str, str] = field(default_factory=dict)
    """``source -> sha256`` of redirect stubs at migration time.

    On rollback, any diff between this recorded hash and the on-disk content
    means the operator has edited the stub since migration -- we refuse to
    restore (and lose their changes) unless ``--force`` is passed.
    """

    def to_json(self) -> str:
        payload = {
            "version": self.version,
            "migration_timestamp": self.migration_timestamp,
            "backups": [asdict(b) for b in self.backups],
            "created_files": list(self.created_files),
            "created_dirs": list(self.created_dirs),
            "post_migration_stub_hashes": dict(self.post_migration_stub_hashes),
        }
        return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"

    @classmethod
    def from_json(cls, raw: str) -> SafetyManifest:
        data = json.loads(raw)
        backups = [BackupRecord(**b) for b in data.get("backups", [])]
        return cls(
            version=str(data.get("version", "1")),
            migration_timestamp=str(data.get("migration_timestamp", "")),
            backups=backups,
            created_files=list(data.get("created_files", [])),
            created_dirs=list(data.get("created_dirs", [])),
            post_migration_stub_hashes=dict(
                data.get("post_migration_stub_hashes", {})
            ),
        )


# ---------------------------------------------------------------------------
# Backup planning / writing
# ---------------------------------------------------------------------------


def premigrate_sibling(path: Path) -> Path:
    """Return the ``.premigrate.*`` sibling path for ``path``.

    Preserves the full suffix chain -- `specification.vbrief.json` becomes
    `specification.premigrate.vbrief.json`, and `SPECIFICATION.md` becomes
    `SPECIFICATION.premigrate.md`.  Files with no suffix get the sentinel
    appended unchanged: `README` -> `README.premigrate`.
    """
    name = path.name
    if "." in name:
        stem, rest = name.split(".", 1)
        return path.with_name(f"{stem}{PREMIGRATE_SUFFIX}.{rest}")
    return path.with_name(f"{name}{PREMIGRATE_SUFFIX}")


def plan_backups(project_root: Path) -> list[tuple[Path, Path]]:
    """Return the list of ``(source, backup)`` pairs the migrator will write.

    Only includes inputs that actually exist on disk so the caller can log and
    emit one BACKUP line per real file.
    """
    pairs: list[tuple[Path, Path]] = []
    for name in _ROOT_MD_INPUTS:
        src = project_root / name
        if src.is_file():
            pairs.append((src, premigrate_sibling(src)))
    vbrief_dir = project_root / "vbrief"
    for name in _VBRIEF_JSON_INPUTS:
        src = vbrief_dir / name
        if src.is_file():
            pairs.append((src, premigrate_sibling(src)))
    return pairs


def write_backups(
    project_root: Path,
    pairs: Iterable[tuple[Path, Path]],
    *,
    dry_run: bool,
) -> tuple[list[BackupRecord], list[str]]:
    """Copy each ``(source, backup)`` pair and return manifest records + log.

    Logs one ``BACKUP <src> -> <dst> (<N> bytes)`` action per pair regardless
    of ``dry_run`` so the operator can see what would happen.  In dry-run
    mode no bytes are written.
    """
    records: list[BackupRecord] = []
    actions: list[str] = []
    for src, dst in pairs:
        raw = src.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        size = len(raw)
        rel_src = _rel(project_root, src)
        rel_dst = _rel(project_root, dst)
        if not dry_run:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        records.append(
            BackupRecord(
                source=rel_src,
                backup=rel_dst,
                source_sha256=digest,
                size_bytes=size,
            )
        )
        tag = "DRYRUN BACKUP" if dry_run else "BACKUP"
        actions.append(f"{tag} {rel_src} -> {rel_dst} ({size} bytes)")
    return records, actions


# ---------------------------------------------------------------------------
# Dirty-tree guard
# ---------------------------------------------------------------------------


def is_tree_dirty(project_root: Path) -> bool:
    """Return True iff ``git status --porcelain`` reports uncommitted changes.

    A project root that is NOT a git checkout -- or one where ``git`` is not
    on PATH -- is treated as clean so tests using plain temp directories and
    non-git consumers (e.g. tarball deployments) can migrate without a
    special override.  This matches #497 acceptance criteria phrasing of
    "working tree is not clean".
    """
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0:
        # Not a git repo, permission denied, etc. -- treat as clean rather
        # than blocking migration, to avoid false-positive guard trips.
        return False
    return bool(result.stdout.strip())


def dirty_tree_refusal_message() -> str:
    """Return the canonical refusal message used when the guard trips.

    Centralised so the migrator CLI and tests agree on exact wording (Greptile
    noise reduction).
    """
    return (
        "ERROR: Working tree is not clean. Migration is destructive; commit "
        "or stash your changes first, then re-run.\n"
        "       Bypass with: task migrate:vbrief -- --force (not recommended)"
    )


# ---------------------------------------------------------------------------
# Manifest IO
# ---------------------------------------------------------------------------


def manifest_path(project_root: Path) -> Path:
    return project_root / "vbrief" / MIGRATION_DIR / SAFETY_MANIFEST_NAME


def write_safety_manifest(
    project_root: Path,
    manifest: SafetyManifest,
    *,
    dry_run: bool,
) -> str:
    """Write the safety manifest under ``vbrief/migration/`` and return a log line."""
    target = manifest_path(project_root)
    rel = _rel(project_root, target)
    if dry_run:
        return f"DRYRUN WRITE {rel} (safety manifest)"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(manifest.to_json(), encoding="utf-8")
    return f"WRITE {rel} (safety manifest, {len(manifest.backups)} backup(s))"


def load_safety_manifest(project_root: Path) -> SafetyManifest | None:
    path = manifest_path(project_root)
    if not path.is_file():
        return None
    try:
        return SafetyManifest.from_json(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def sha256_of(path: Path) -> str:
    """Return hex sha256 of ``path`` (empty string if path does not exist)."""
    if not path.is_file():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------


def _default_confirm(prompt: str) -> bool:
    """Default interactive confirmation prompt used by ``rollback``."""
    try:
        reply = input(f"{prompt} [yes/NO]: ")
    except EOFError:
        return False
    return reply.strip().lower() in {"yes", "y"}


def rollback(
    project_root: Path,
    *,
    force: bool = False,
    confirm_fn: Callable[[str], bool] | None = None,
) -> tuple[bool, list[str]]:
    """Restore a project to its pre-migration state.

    Returns ``(ok, messages)`` where ``messages`` is a human-readable action
    log.  Fails fast if:

    - No safety manifest exists (migration never ran, or rollback already
      happened).
    - A redirect stub has been edited since migration and ``force`` is False.
    - The user declines the confirmation prompt (``--force`` skips this).

    On success, restores every ``.premigrate.*`` backup, removes the scope
    vBRIEFs / migration / legacy artefacts the migrator created, removes
    directories the migrator created (only if they are empty after cleanup),
    and deletes the manifest and the backup files themselves.
    """
    actions: list[str] = []
    manifest = load_safety_manifest(project_root)
    if manifest is None:
        return False, [
            "ERROR: No safety manifest found. Either migration has not run, "
            "or rollback has already completed. Expected "
            f"{_rel(project_root, manifest_path(project_root))}."
        ]

    # 1. Detect edited stubs unless force.
    edited_stubs: list[tuple[str, str, str]] = []
    for rel, expected_hash in manifest.post_migration_stub_hashes.items():
        current = sha256_of(project_root / rel)
        if current and current != expected_hash:
            edited_stubs.append((rel, expected_hash, current))
    if edited_stubs and not force:
        lines = ["ERROR: Redirect stubs have been edited since migration:"]
        for rel, expected, current in edited_stubs:
            lines.append(
                f"  - {rel} (expected sha256 {expected[:12]}..., got {current[:12]}...)"
            )
        lines.append(
            "Rollback would overwrite your edits. Re-run with --force to "
            "proceed anyway, or commit the stubs before rolling back."
        )
        return False, lines

    # 2. Confirmation prompt.
    if not force:
        prompt_fn = confirm_fn or _default_confirm
        summary = (
            f"Rollback will restore {len(manifest.backups)} backup(s) and "
            f"remove {len(manifest.created_files)} migrator-created file(s). "
            f"Proceed?"
        )
        if not prompt_fn(summary):
            return False, ["Rollback aborted by operator."]

    # 3. Restore backups.
    missing_backups: list[str] = []
    for record in manifest.backups:
        backup_path = project_root / record.backup
        source_path = project_root / record.source
        if not backup_path.is_file():
            missing_backups.append(record.backup)
            continue
        source_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup_path, source_path)
        actions.append(
            f"RESTORE {record.source} <- {record.backup} ({record.size_bytes} bytes)"
        )

    if missing_backups:
        actions.append(
            "WARNING: missing backup file(s) -- sources not restored: "
            + ", ".join(missing_backups)
        )

    # 4. Remove migrator-created files.  Sort deepest-first so rmdir on
    # created_dirs below has a chance at emptying parents cleanly.
    for rel in sorted(manifest.created_files, key=lambda p: -p.count("/")):
        path = project_root / rel
        if path.is_file():
            path.unlink()
            actions.append(f"REMOVE {rel}")
        else:
            actions.append(f"SKIP   {rel} (already absent)")

    # Also remove migration-report / legacy files the migrator writes, other
    # than the manifest itself (that comes last so failures leave a trail).
    for sub in (MIGRATION_DIR, LEGACY_DIR):
        subdir = project_root / "vbrief" / sub
        if not subdir.is_dir():
            continue
        for entry in sorted(subdir.glob("*")):
            if entry.name == SAFETY_MANIFEST_NAME:
                continue
            if entry.is_file():
                entry.unlink()
                actions.append(f"REMOVE {_rel(project_root, entry)}")

    # 5. Remove migrator-created directories (only if now-empty) -- also
    # sorted deepest-first.
    for rel in sorted(manifest.created_dirs, key=lambda p: -p.count("/")):
        path = project_root / rel
        if path.is_dir():
            try:
                path.rmdir()
                actions.append(f"RMDIR  {rel}")
            except OSError:
                actions.append(f"SKIP   rmdir {rel} (not empty)")

    # 6. Remove the backup files themselves so the tree ends clean.
    for record in manifest.backups:
        backup_path = project_root / record.backup
        if backup_path.is_file():
            backup_path.unlink()
            actions.append(f"REMOVE {record.backup}")

    # 7. Finally, remove the manifest and its parent directory if empty.
    m_path = manifest_path(project_root)
    if m_path.is_file():
        m_path.unlink()
        actions.append(f"REMOVE {_rel(project_root, m_path)}")
    for parent in (m_path.parent, m_path.parent.parent):
        if parent.is_dir():
            try:
                parent.rmdir()
                actions.append(f"RMDIR  {_rel(project_root, parent)}")
            except OSError:
                # Non-empty -- leave it.  Common when vbrief/ has other
                # lifecycle folders the operator kept around.
                pass

    actions.append("Rollback completed successfully.")
    return True, actions


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _rel(project_root: Path, target: Path) -> str:
    """Project-root-relative, forward-slash path for logs and manifest entries."""
    try:
        return target.relative_to(project_root).as_posix()
    except ValueError:
        return target.as_posix()


def now_utc_iso() -> str:
    """UTC timestamp in ISO-8601 seconds precision (matches vBRIEF `created`)."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
