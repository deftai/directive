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
    # #571 / #567 Greptile P1: the migrator force-bumps
    # ``plan.vbrief.json`` to v0.6 when present, so the pre-bump bytes
    # MUST be backed up to its ``.premigrate.*`` sibling for rollback
    # to restore them. Without this entry the bump was not reversible
    # and ``migrate -> rollback`` left a non-empty ``git status
    # --porcelain`` on any project that carried a v0.5 plan.vbrief.json.
    "plan.vbrief.json",
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
class FileModification:
    """In-place file-modification recorded in the safety manifest (#567).

    Tracks every non-backup forward-pass edit the migrator performs on a
    pre-existing project file (currently: ``.gitignore`` append) so the
    rollback path can reverse it symmetrically to
    :attr:`SafetyManifest.post_migration_stub_hashes` for redirect
    stubs.

    Attributes
    ----------
    path
        Project-root-relative path of the modified file.
    operation
        ``"append"`` when the migrator added content to an existing
        file, or ``"create"`` when the migrator created the file from
        scratch (pre-migration state was "absent"). Additional
        operations may be introduced as the migrator grows; rollback
        refuses when it sees an operation it does not recognise.
    pre_hash
        sha256 of the file BEFORE the modification. Empty string when
        the file did not exist pre-migration (operation == "create").
    post_hash
        sha256 of the file AFTER the modification. Used by rollback to
        detect whether the operator has edited the file since migration;
        rollback refuses (same pattern as
        :attr:`SafetyManifest.post_migration_stub_hashes`) when the
        current on-disk hash matches neither ``pre_hash`` nor
        ``post_hash``.
    appended_content
        Exact bytes the migrator appended (operation == "append") or
        the full file content (operation == "create"). On rollback the
        append case strips this suffix from the current file; the
        create case deletes the file entirely.
    """

    path: str
    operation: str
    pre_hash: str
    post_hash: str
    appended_content: str


@dataclass
class RenameRecord:
    """Single post-migration rename recorded in the safety manifest (#528).

    When a ``deft-directive-*`` skill renames a file the migrator originally
    created (e.g. Phase 6c of ``deft-directive-sync`` renames
    ``LEGACY-REPORT.md`` -> ``LEGACY-REPORT.reviewed.md``), the skill
    appends one of these records to :attr:`SafetyManifest.renames` so
    rollback can resolve the current on-disk name before attempting
    removal. Without this, rollback would target the original name,
    silently miss the renamed file, and leave the artefact + its parent
    directory orphaned on disk (issue #528).
    """

    original: str
    """Project-root-relative path of the file when the migrator created it."""

    current: str
    """Project-root-relative path of the file on disk RIGHT NOW."""

    renamed_by: str
    """Human-readable name of the skill/phase that performed the rename."""

    renamed_at: str
    """UTC ISO-8601 timestamp (seconds precision) when the rename was recorded."""


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

    renames: list[RenameRecord] = field(default_factory=list)
    """Post-migration renames recorded by downstream skills (#528).

    Rollback consults this to resolve the current on-disk name of any
    tracked file before attempting removal. The migrator never writes
    entries here itself -- entries are appended by ``deft-directive-sync``
    Phase 6c and any future skill that renames migrator-created files.
    """

    file_modifications: list[FileModification] = field(default_factory=list)
    """In-place edits the migrator performed on pre-existing files (#567).

    Currently limited to the ``.gitignore`` append, but the shape is
    deliberately generic so future migrator features (e.g. README
    patches, Taskfile ``includes:`` injection) can record here too.
    Rollback iterates this list and either strips the appended content
    (``operation == "append"``) or deletes the file entirely
    (``operation == "create"``) if the current on-disk hash matches the
    recorded ``post_hash``. When the hash matches neither ``pre_hash``
    nor ``post_hash`` the operator has edited the file since migration
    and rollback refuses -- same pattern as
    :attr:`post_migration_stub_hashes` for SPECIFICATION.md /
    PROJECT.md redirect stubs.
    """

    def to_json(self) -> str:
        payload = {
            "version": self.version,
            "migration_timestamp": self.migration_timestamp,
            "backups": [asdict(b) for b in self.backups],
            "created_files": list(self.created_files),
            "created_dirs": list(self.created_dirs),
            "post_migration_stub_hashes": dict(self.post_migration_stub_hashes),
            "renames": [asdict(r) for r in self.renames],
            "file_modifications": [asdict(m) for m in self.file_modifications],
        }
        return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"

    @classmethod
    def from_json(cls, raw: str) -> SafetyManifest:
        data = json.loads(raw)
        backups = [BackupRecord(**b) for b in data.get("backups", [])]
        renames = [RenameRecord(**r) for r in data.get("renames", [])]
        # Backward compatible: older manifests have no file_modifications
        # key at all (pre-#567); parse to an empty list so rollback still
        # runs for tree-states produced by earlier migrator versions.
        file_mods = [
            FileModification(**m)
            for m in data.get("file_modifications", [])
        ]
        return cls(
            version=str(data.get("version", "1")),
            migration_timestamp=str(data.get("migration_timestamp", "")),
            backups=backups,
            created_files=list(data.get("created_files", [])),
            created_dirs=list(data.get("created_dirs", [])),
            post_migration_stub_hashes=dict(
                data.get("post_migration_stub_hashes", {})
            ),
            renames=renames,
            file_modifications=file_mods,
        )

    def current_path_for(self, original: str) -> str:
        """Return the current on-disk path for a migrator-created ``original``.

        Consults :attr:`renames` and follows genuine A -> B -> C chains:
        each iteration looks up the *current* resolved path against the
        ``original`` field of every :class:`RenameRecord`. Within a single
        hop, the most recent rename (last in list) wins when multiple
        records target the same original. Terminates on a fixed-point or
        when the bounded iteration count is exceeded (defensive guard
        against pathological loops).

        Also returns ``original`` when no record matches (#528; Greptile
        #561 P2 clarified the chain contract).
        """
        resolved = original
        # A chain cannot be longer than the number of records in practice;
        # bound the loop to ``len(renames) + 1`` so a hypothetical cycle
        # aborts rather than spinning forever.
        for _ in range(len(self.renames) + 1):
            # Within one hop, scan every record that matches the current
            # ``resolved`` name; the last matching record wins so two
            # skills that both rename the same original land on the most
            # recent destination (same-original semantics). Chain hops
            # advance by looping again against the new ``resolved``.
            target = resolved
            for record in self.renames:
                if record.original == resolved:
                    target = record.current
            if target == resolved:
                break
            resolved = target
        return resolved


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


# Default deprecation redirect sentinel (mirrors migrate_vbrief.DEPRECATION_SENTINEL).
# Kept here to avoid an import cycle with migrate_vbrief.  A caller may override via
# plan_backups(..., deprecation_sentinel=...) if the project-root sentinel ever changes.
_DEPRECATION_SENTINEL_DEFAULT = "<!-- deft:deprecated-redirect -->"


def _is_deprecation_stub(path: Path, sentinel: str) -> bool:
    """Return True iff ``path`` already contains the deprecation redirect sentinel.

    Protects re-run recovery (Greptile #509 P1): if the operator re-invokes
    ``task migrate:vbrief`` on an already-migrated project, the root-level
    ``SPECIFICATION.md`` / ``PROJECT.md`` are redirect stubs rather than
    originals.  Backing them up would overwrite the real ``.premigrate.*``
    copies from the first run with stub bytes, destroying ``--rollback``
    recovery.  Files we cannot read (binary, permission-denied, missing
    mid-call) are treated as non-stubs so we do not silently skip backups
    that should have happened.
    """
    try:
        head = path.read_text(encoding="utf-8", errors="replace")[:4096]
    except OSError:
        return False
    return sentinel in head


def plan_backups(
    project_root: Path,
    *,
    deprecation_sentinel: str = _DEPRECATION_SENTINEL_DEFAULT,
) -> list[tuple[Path, Path]]:
    """Return the list of ``(source, backup)`` pairs the migrator will write.

    Only includes inputs that actually exist on disk so the caller can log and
    emit one BACKUP line per real file.

    Sources that already carry the deprecation redirect sentinel are skipped
    (re-run protection -- see ``_is_deprecation_stub`` docstring).
    """
    pairs: list[tuple[Path, Path]] = []
    for name in _ROOT_MD_INPUTS:
        src = project_root / name
        if src.is_file() and not _is_deprecation_stub(src, deprecation_sentinel):
            pairs.append((src, premigrate_sibling(src)))
    vbrief_dir = project_root / "vbrief"
    for name in _VBRIEF_JSON_INPUTS:
        src = vbrief_dir / name
        if src.is_file() and not _is_deprecation_stub(src, deprecation_sentinel):
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

    # 1b. Detect edited in-place file modifications unless force (#567).
    # Mirrors the stub-hash guard for the ``.gitignore`` append and any
    # future non-backup in-place edit the migrator records. A current
    # hash that matches neither ``pre_hash`` (already reverted -- safe to
    # skip) nor ``post_hash`` (untouched since migration -- safe to
    # reverse) means the operator edited the file post-migration; we
    # refuse to clobber those edits without ``--force``.
    edited_modifications: list[tuple[str, str, str, str]] = []
    for mod in manifest.file_modifications:
        current = sha256_of(project_root / mod.path)
        # operation == "create" + file absent post-rollback is fine; the
        # guard only fires when the file exists but the hash doesn't
        # match either snapshot.
        if not current:
            continue
        if current in {mod.pre_hash, mod.post_hash}:
            continue
        edited_modifications.append(
            (mod.path, mod.pre_hash, mod.post_hash, current)
        )
    if edited_modifications and not force:
        lines = [
            "ERROR: Migrator-modified file(s) have been edited since migration:"
        ]
        for rel, pre, post, current in edited_modifications:
            lines.append(
                f"  - {rel} (expected sha256 "
                f"{post[:12]}... or {pre[:12]}..., got "
                f"{current[:12]}...)"
            )
        lines.append(
            "Rollback would overwrite your edits. Re-run with --force to "
            "proceed anyway, or commit the file(s) before rolling back."
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

    # 3. Pre-flight: make sure every recorded backup file is still on disk
    # BEFORE we start restoring.  If any is missing we refuse the rollback
    # entirely rather than do a partial restore that would leave some sources
    # as deprecation stubs while also deleting the manifest (which would make
    # a retry impossible).  Greptile P1 on #497: the prior implementation
    # appended a warning and proceeded to (True, ...), printing a misleading
    # "Rollback completed successfully" while half the tree was still stubs.
    missing_backups = [
        record.backup
        for record in manifest.backups
        if not (project_root / record.backup).is_file()
    ]
    if missing_backups:
        lines = [
            "ERROR: Backup file(s) missing -- cannot restore all sources:",
            *[f"  - {p}" for p in missing_backups],
            (
                "Manifest preserved for investigation. Resolve the missing "
                ".premigrate.* file(s) (or restore from VCS) and retry "
                "`task migrate:vbrief -- --rollback`."
            ),
        ]
        return False, actions + lines

    for record in manifest.backups:
        backup_path = project_root / record.backup
        source_path = project_root / record.source
        source_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup_path, source_path)
        actions.append(
            f"RESTORE {record.source} <- {record.backup} ({record.size_bytes} bytes)"
        )

    # 4. Remove migrator-created files ONLY -- scoped strictly to
    # manifest.created_files so rollback of this wave's run never deletes
    # artefacts written by sibling waves that share `vbrief/migration/` or
    # `vbrief/legacy/` (Agent D #498 writes validation-failure output there;
    # Agent G #505 writes oversize legacy sections there).  Greptile P2 on
    # #497.  Sort deepest-first so directory-removal in step 5 has a chance
    # at emptying parents cleanly.
    for rel in sorted(manifest.created_files, key=lambda p: -p.count("/")):
        # #528: downstream skills (e.g. deft-directive-sync Phase 6c) may
        # rename migrator-created files. Resolve the current on-disk name
        # via manifest.renames before attempting removal so renamed files
        # do not get orphaned with their parent directory.
        current_rel = manifest.current_path_for(rel)
        path = project_root / current_rel
        if path.is_file():
            path.unlink()
            if current_rel != rel:
                actions.append(f"REMOVE {current_rel} (renamed from {rel})")
            else:
                actions.append(f"REMOVE {rel}")
        else:
            if current_rel != rel:
                actions.append(
                    f"SKIP   {current_rel} (already absent; renamed from {rel})"
                )
            else:
                actions.append(f"SKIP   {rel} (already absent)")

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

    # 5b. Reverse each recorded file_modification (#567). Runs BEFORE
    # removing backup files so the log order matches the operator's
    # mental model of "undo everything the forward pass did, then
    # clean up the .premigrate.* siblings".
    for mod in manifest.file_modifications:
        target = project_root / mod.path
        current = sha256_of(target)
        if mod.operation == "create":
            # Pre-migration state was "file absent". If the file is
            # already gone, rollback is a no-op. Otherwise delete it --
            # the force-path has already been gated on the hash guard
            # above so we only reach here when the file is either at
            # post_hash (created by us) or force is set.
            if current and target.is_file():
                target.unlink()
                actions.append(f"REMOVE {mod.path} (created by migrator)")
            else:
                actions.append(
                    f"SKIP   {mod.path} (already absent)"
                )
            continue
        if mod.operation == "append":
            if not current:
                # File deleted since migration -- nothing to reverse.
                actions.append(
                    f"SKIP   {mod.path} (file no longer exists; "
                    f"nothing to strip)"
                )
                continue
            if current == mod.pre_hash:
                # Already reverted (operator manually reset the file).
                actions.append(
                    f"SKIP   {mod.path} (already at pre-migration hash)"
                )
                continue
            try:
                body = target.read_text(encoding="utf-8")
            except OSError:
                actions.append(
                    f"SKIP   {mod.path} (unreadable; cannot strip append)"
                )
                continue
            if body.endswith(mod.appended_content):
                stripped = body[: -len(mod.appended_content)]
                target.write_text(stripped, encoding="utf-8")
                actions.append(
                    f"REVERT {mod.path} (stripped "
                    f"{len(mod.appended_content)} appended byte(s))"
                )
            else:
                # Post-hash matched the snapshot but suffix no longer
                # matches verbatim (rare: CRLF normalization after
                # commit, etc.). Surface a clear message rather than
                # silently leaving junk behind.
                actions.append(
                    f"SKIP   {mod.path} (content shape drifted; "
                    f"cannot strip append cleanly -- restore manually)"
                )
            continue
        # Unknown operation -- be conservative and skip rather than
        # mutating the file blindly.
        actions.append(
            f"SKIP   {mod.path} (unknown operation {mod.operation!r})"
        )

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
