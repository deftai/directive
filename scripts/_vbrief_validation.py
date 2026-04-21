r"""Shared validation and slug-safe ID helpers for the vBRIEF migrator (#498).

Extracted from ``scripts/migrate_vbrief.py`` so the migrator stays under the
1000-line hard cap documented in ``deft/coding/coding.md`` while still
hard-blocking on schema-invalid output (per #506 D8).

Public API
----------
* ``slugify_id(raw, existing=None)`` -- single sanitiser used for BOTH the
  filename slug component AND every in-JSON identifier
  (``plan.items[*].id``, ``plan.id``, scope-registry ids) emitted by the
  migrator. Conforms to the schema-locked ID regex
  ``^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$`` (shared conventions #506) by
  restricting output to lowercase ASCII letters, digits, and hyphens only.
  Also satisfies the stricter lifecycle-folder filename validator
  (``^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.vbrief\.json$``) which
  disallows underscores and dots -- hyphen-only output keeps a single
  implementation that passes both surfaces.
* ``slug_fallback_id(item)`` -- resolve the logical identifier source for a
  roadmap/scope ``item`` dict in the preference order used by both filename
  construction and the PROJECT-DEFINITION scope registry, so both surfaces
  compute the same slug input from the same item.
* ``validate_migration_output(vbrief_dir)`` -- thin wrapper around
  ``vbrief_validate.validate_all`` scoped to the migrator's emitted-file set.
  Returns ``(errors, warnings)`` with full per-file diagnostics.
* ``isolate_invalid_output(project_root, vbrief_dir)`` -- on validation
  failure, move the emitted ``vbrief/`` tree to ``vbrief.invalid/`` (with a
  numeric suffix on collision) so the operator can inspect the partial
  output without it blocking subsequent migrator runs. Pre-migration
  ``.premigrate.*`` backups (Agent C, #497) are left untouched.
* ``finalize_migration(project_root, vbrief_dir, actions)`` -- terminal
  validate + isolate step the migrator plugs in at the end of its body.
* ``RECOVERY_HINT`` -- canonical CLI recovery hint printed on failure.

Story: #498 (migrate:vbrief self-validation + slug-safe IDs + golden tests).
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

# Ensure sibling ``vbrief_validate`` is importable whether this module is
# imported from a test harness (which inserts ``scripts/`` onto sys.path) or
# from ``scripts/migrate_vbrief.py`` itself (which performs the same insert
# at the top of its module).
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import vbrief_validate  # noqa: E402  (import after sys.path mutation)

__all__ = [
    "RECOVERY_HINT",
    "slugify_id",
    "slug_fallback_id",
    "validate_migration_output",
    "isolate_invalid_output",
    "finalize_migration",
    "ID_MAX_LENGTH",
    "HASH_SUFFIX_LENGTH",
]

# Canonical recovery hint surfaced when the migrator hard-blocks on
# schema-invalid output (#506 D8). Agent C (#497) owns the ``--rollback`` flag
# implementation; this module only references the flag by name.
RECOVERY_HINT = "Restore with: task migrate:vbrief -- --rollback"

# Per #498: slug-safe IDs truncate to 80 characters. The optional 6-char hash
# suffix reserves ``1 + 6 = 7`` characters so the base slug before the suffix
# is 73 characters max -- keeps total length <= 80 for collision-disambiguated
# values.
ID_MAX_LENGTH = 80
HASH_SUFFIX_LENGTH = 6


def slugify_id(raw: str, existing: set[str] | None = None) -> str:
    """Return a slug-safe id for filenames and in-JSON id fields (#498).

    Rules (per #498 acceptance criteria and #506 shared conventions):

    * lowercase ASCII letters, digits, and hyphens only
    * runs of any non-allowed character collapse to a single hyphen
    * leading/trailing hyphens are stripped
    * truncate to ``ID_MAX_LENGTH`` (80) characters
    * when ``existing`` is provided and the resulting slug collides,
      append a stable 6-char hex suffix derived from the raw input so
      repeated migrations produce the same disambiguated value; if that
      still collides, perturb the hash deterministically until unique

    Parameters
    ----------
    raw:
        The raw input text to slugify. ``None`` and empty values are
        normalised to ``"untitled"``.
    existing:
        Optional mutable set used as the "already-emitted" registry. When
        provided, the returned slug is added to the set so subsequent calls
        can detect collisions. Pass ``None`` for one-shot slug computation
        (no collision tracking).

    Returns
    -------
    str
        A slug matching ``^[a-z0-9]+(-[a-z0-9]+)*$`` -- conforms to both the
        schema ID regex and the lifecycle filename regex.
    """
    text = (raw or "").strip()
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    if not slug:
        slug = "untitled"
    if len(slug) > ID_MAX_LENGTH:
        slug = slug[:ID_MAX_LENGTH].rstrip("-") or slug[:ID_MAX_LENGTH]

    if existing is None:
        return slug

    if slug not in existing:
        existing.add(slug)
        return slug

    # Collision path -- append a stable 6-char hash suffix. Seed from the
    # original raw input (falls back to the computed slug when raw is empty)
    # so repeated migrations with the same content yield the same suffix.
    digest_seed = text or slug
    base_max = ID_MAX_LENGTH - 1 - HASH_SUFFIX_LENGTH  # "-" + 6 hex chars
    base = slug[:base_max].rstrip("-") or slug[:base_max] or "id"
    h = hashlib.sha1(digest_seed.encode("utf-8")).hexdigest()[:HASH_SUFFIX_LENGTH]
    candidate = f"{base}-{h}"

    attempt = 0
    while candidate in existing and attempt < 1000:
        attempt += 1
        h2 = hashlib.sha1(
            f"{digest_seed}|{attempt}".encode()
        ).hexdigest()[:HASH_SUFFIX_LENGTH]
        candidate = f"{base}-{h2}"

    existing.add(candidate)
    return candidate


def slug_fallback_id(item: dict) -> str:
    """Return the logical identifier source for a scope ``item`` dict.

    Preference order mirrors the filename construction in Step 4 / 4b so
    both surfaces (PROJECT-DEFINITION scope registry id AND scope vBRIEF
    filename) resolve the same logical identifier from the same item:

    1. GitHub issue ``number``
    2. Explicit ``task_id``
    3. ``synthetic_id`` (assigned by the ROADMAP parser fallback)
    4. ``title`` (used when nothing else is available)

    Returns the raw (un-slugified) string; callers are expected to pipe the
    result through :func:`slugify_id`.
    """
    number = str(item.get("number", "") or "")
    if number:
        return number
    task_id = str(item.get("task_id", "") or "")
    if task_id:
        return task_id
    synthetic = str(item.get("synthetic_id", "") or "")
    if synthetic:
        return synthetic
    return str(item.get("title", "") or "untitled")


def validate_migration_output(
    vbrief_dir: Path,
) -> tuple[list[str], list[str]]:
    """Validate every file emitted by the migrator under ``vbrief_dir``.

    Delegates the heavy lifting to :func:`vbrief_validate.validate_all`,
    which already implements the full D2/D3/D4/D7/D11 rule set plus schema
    validation for scope vBRIEFs and PROJECT-DEFINITION.vbrief.json.

    Returns
    -------
    (errors, warnings):
        ``errors`` is a list of human-readable diagnostic strings; when
        non-empty the migrator MUST exit non-zero per #506 D8 (hard-block on
        schema-invalid output). ``warnings`` are surfaced but do NOT block
        success -- they follow the same semantics as
        ``scripts/vbrief_validate.py`` (e.g. D11 origin provenance warnings
        for pending/active without a github-issue reference).
    """
    if not vbrief_dir.is_dir():
        # Nothing emitted -- fail loudly so the caller reports something
        # useful rather than silently accepting an empty migration.
        return (
            [f"{vbrief_dir}: expected vbrief directory does not exist"],
            [],
        )

    errors, warnings, _scope_count = vbrief_validate.validate_all(vbrief_dir)
    return list(errors), list(warnings)


def isolate_invalid_output(
    project_root: Path, vbrief_dir: Path
) -> Path | None:
    """Move the emitted ``vbrief/`` tree to ``vbrief.invalid/`` on failure.

    Per #506 D8: schema-invalid migration output must be isolated from
    ``vbrief/`` so downstream tasks (``task check`` / ``task scope:*`` /
    renders) don't consume broken state. Agent C's ``.premigrate.*`` backups
    remain untouched at the project root so ``task migrate:vbrief --
    --rollback`` can restore the pre-migration state.

    Returns the destination path, or ``None`` when ``vbrief_dir`` does not
    exist (nothing to move).

    Collision handling: if ``vbrief.invalid/`` already exists (e.g. from a
    prior failed migration), increment a numeric suffix -- ``vbrief.invalid.2``,
    ``vbrief.invalid.3``, etc. -- so operators retain the history of failed
    attempts instead of overwriting.
    """
    if not vbrief_dir.exists():
        return None

    target = project_root / "vbrief.invalid"
    idx = 1
    while target.exists():
        idx += 1
        target = project_root / f"vbrief.invalid.{idx}"

    vbrief_dir.rename(target)
    return target


def finalize_migration(
    project_root: Path,
    vbrief_dir: Path,
    actions: list[str],
) -> tuple[bool, list[str]]:
    """Run validation + isolation as the migrator's terminal gate (#498).

    Designed as a drop-in terminal step for ``scripts/migrate_vbrief.py::
    migrate`` so the migrator body stays under the 1000-line hard cap.
    Pipes diagnostics to stderr and returns the final ``(ok, actions)``
    tuple that the migrator should propagate to its CLI entry point:

    * On success: returns ``(True, actions)`` untouched -- caller prints its
      normal success message ("Migration completed successfully.").
    * On failure: prints per-file diagnostics to stderr, moves ``vbrief/``
      to ``vbrief.invalid/`` (isolation), appends failure diagnostics and a
      ``Restore with: task migrate:vbrief -- --rollback`` recovery hint to a
      copy of ``actions``, and returns ``(False, failure_actions)``.

    The ``actions`` list passed in is NOT mutated so callers can reuse it
    for downstream logging independent of migration outcome.
    """
    errors, _warnings = validate_migration_output(vbrief_dir)
    if not errors:
        return True, actions

    print(
        f"ERROR: Migration produced invalid output ({len(errors)} "
        f"file-level error(s)):",
        file=sys.stderr,
    )
    for err in errors:
        print(f"  {err}", file=sys.stderr)

    invalid_dir = isolate_invalid_output(project_root, vbrief_dir)

    failure_actions: list[str] = list(actions)
    failure_actions.append(
        f"FAIL  migration produced {len(errors)} schema validation error(s)"
    )
    for err in errors:
        failure_actions.append(f"  {err}")
    if invalid_dir is not None:
        try:
            rel_invalid = invalid_dir.relative_to(project_root)
        except ValueError:
            rel_invalid = invalid_dir
        failure_actions.append(
            f"MOVE  vbrief/ -> {rel_invalid}/ (isolated from vbrief/)"
        )
        print(
            f"Isolated partial output to: {rel_invalid}",
            file=sys.stderr,
        )
    failure_actions.append(RECOVERY_HINT)
    print(RECOVERY_HINT, file=sys.stderr)
    return False, failure_actions
