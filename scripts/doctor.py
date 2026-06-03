#!/usr/bin/env python3
"""scripts/doctor.py -- canonical doctor implementation (Epic-1 #1335).

This module now owns the core doctor logic previously in run::cmd_doctor
and its helpers (parse flags, throttle via _doctor_state, install-integrity
folding, AGENTS.md freshness, Taskfile include diagnostics, structure checks,
--fix repair, --json / --session / --quiet / --full / --project-root modes).

Thin shims remain in:
  * run::cmd_doctor  (delegates here after sys.path insert)
  * Taskfile.yml "doctor:" target (already a shim to `run doctor`)

All new/moved code follows project testing guidelines; tests updated
in tests/cli/test_cmd_doctor.py and siblings.

See also: scripts/_doctor_state.py (throttle). Install-integrity logic
previously in framework_doctor.py (retired #1336) now lives here.

Story: #1335 / #1336 (paired in agent1 worktree).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

# --- Duplicated minimal CLI / path helpers (avoid importing heavy run) ---
# These are small, stable, and let doctor.py stay self-contained.
# Rich is optional; fall back to plain prints. Mirrors run's top-level setup.

HAS_RICH = False

console = None
Panel = None
Markdown = None
try:
    from rich.console import Console
    from rich.markdown import Markdown as _Markdown
    from rich.panel import Panel as _Panel
    console = Console()
    Panel = _Panel
    Markdown = _Markdown
    HAS_RICH = True
except Exception:  # noqa: BLE001 -- rich optional
    HAS_RICH = False

def print_header(text: str):
    if HAS_RICH and console and Panel:
        console.print(Panel(f"[bold cyan]{text}[/bold cyan]", border_style="cyan"))
    else:
        print(f"\n{'=' * 60}")
        print(f"  {text}")
        print('=' * 60)

def print_section(text: str):
    if HAS_RICH and console and Markdown:
        console.print(Markdown(f"## {text}"))
    else:
        print(f"\n{'-' * 60}")
        print(f"  {text}")
        print('-' * 60)

def print_info(msg: str):
    if HAS_RICH and console:
        console.print(f"[blue]ℹ[/blue] {msg}")
    else:
        print(f"ℹ {msg}")

def print_success(msg: str):
    if HAS_RICH and console:
        console.print(f"[green]✓[/green] {msg}")
    else:
        print(f"✓ {msg}")

def print_warn(msg: str):
    if HAS_RICH and console:
        console.print(f"[yellow]⚠[/yellow] {msg}")
    else:
        print(f"⚠ {msg}")

def print_error(msg: str):
    if HAS_RICH and console:
        console.print(f"[red]✗[/red] {msg}")
    else:
        print(f"✗ {msg}")

# Legacy aliases for the extracted code that calls info/success etc.
info = print_info
success = print_success
warn = print_warn
error = print_error

def get_script_dir() -> Path:
    """Get the directory where this script is located (works for import and direct)."""
    return Path(__file__).parent.absolute()

def resolve_path(path_str: str) -> Path:
    """Resolve a user-supplied path string to an absolute Path.
    Expands ~ and resolves relative paths against cwd.
    """
    if not path_str:
        return Path.cwd()
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = (Path.cwd() / p).resolve()
    return p

def _resolve_version() -> str:
    """Best-effort version (duplicated for doctor self-containment)."""
    try:
        for cand in [
            Path(__file__).parent.parent / 'VERSION',
            Path(__file__).parent / 'VERSION',
            Path.cwd() / '.deft-version',
        ]:
            if cand.exists():
                return cand.read_text(encoding='utf-8').strip()
    except Exception:
        pass
    return 'dev'

VERSION = _resolve_version()

# UV url constant (the _check_uv_available helper remains in run for other callers)
UV_INSTALL_URL = "https://docs.astral.sh/uv/"

# --- Install-integrity checks (ported from retired framework_doctor.py #1336) ---
# Symbols (EXIT_*, run_checks, main, CheckResult, DoctorResult + 4 checks + impl)
# are inserted below in small batches. Once complete, _run_install_integrity_checks
# will delegate locally (no more self-import hack or double-scripts path).
# This satisfies the Greptile P0 (missing symbols for tests + runtime NameError/AttributeError).
# --- END PORTED CHECKS HEADER ---

# --- Ported from framework_doctor.py: constants, regexes, dataclasses, low-level helpers ---
EXIT_CLEAN = 0
EXIT_DRIFT = 1
EXIT_CONFIG_ERROR = 2


# Marker contract -- mirrors run::_AGENTS_MANAGED_OPEN_RE. Kept inline so
# this script stays pure-stdlib + cross-platform without importing run
# (which has heavy import-time side effects).
_AGENTS_MANAGED_OPEN_RE = re.compile(r"<!--\s*deft:managed-section\s+v(2|3)(?:\s+([^>]*?))?\s*-->")
_AGENTS_MANAGED_CLOSE = "<!-- /deft:managed-section -->"

# The canonical install-root declaration AGENTS.md carries one of:
#   "Deft is installed in <root>/."
#   "Full guidelines: <root>/main.md"
# We parse both. The first match wins.
_INSTALLED_IN_RE = re.compile(r"Deft is installed in\s+(\S+?)/?\.")
_FULL_GUIDELINES_RE = re.compile(r"Full guidelines:\s+(\S+)/main\.md")

# Pattern for referenced skill paths. Matches both ``deft/skills/<name>/SKILL.md``
# (legacy) and ``.deft/core/skills/<name>/SKILL.md`` (canonical).
_SKILL_PATH_RE = re.compile(r"(?P<root>[\w./-]+?)/skills/(?P<name>[a-z][\w-]*)/SKILL\.md")

# Deprecation-redirect sentinels embedded in stub SKILL.md files (#411).
# A skill path that resolves but is a redirect stub is treated as still
# a fail -- the operator needs to act, not be told everything is fine.
#
# Important: current real skills legitimately mention the markdown
# ``deft:deprecated-redirect`` sentinel when describing migrated
# SPECIFICATION.md / PROJECT.md state. Redirect detection therefore keys on
# the stub header shape, not substring presence anywhere in a skill body.
_DEPRECATED_REDIRECT_SENTINEL = "<!-- deft:deprecated-redirect -->"
_DEPRECATED_SKILL_REDIRECT_SENTINEL = "<!-- deft:deprecated-skill-redirect -->"
_REDIRECT_STUB_HEADER_LINES = 8


@dataclass
class CheckResult:
    """Outcome of a single doctor check.

    ``status`` is one of:
      * ``"pass"`` -- check succeeded; no action required.
      * ``"fail"`` -- check failed; drift detected and operator action
        is required.
      * ``"skip"`` -- check was skipped because its precondition was
        not met (e.g. manifest-agreement skips when neither file exists).
      * ``"error"`` -- check could not run because of a config-level
        problem (e.g. project root does not exist). Propagates to
        exit code 2.
    """

    name: str
    status: str
    detail: str
    data: dict = field(default_factory=dict)


@dataclass
class DoctorResult:
    """Aggregated doctor outcome consumed by the CLI + gate hook."""

    project_root: str
    install_root: str | None
    exit_code: int
    checks: list[CheckResult]
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "project_root": self.project_root,
            "install_root": self.install_root,
            "exit_code": self.exit_code,
            "checks": [
                {
                    "name": c.name,
                    "status": c.status,
                    "detail": c.detail,
                    "data": c.data,
                }
                for c in self.checks
            ],
            "errors": list(self.errors),
        }


# ---------------------------------------------------------------------------
# Helpers (ported)
# ---------------------------------------------------------------------------


def _read_text_safe(path: Path) -> str | None:
    """Best-effort UTF-8 read; returns None on OSError."""
    if not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _parse_install_root_from_agents_md(text: str) -> str | None:
    """Return the install root AGENTS.md claims (e.g. ``.deft/core``).

    Tries the ``Deft is installed in <root>/.`` form first, then falls back
    to ``Full guidelines: <root>/main.md``. Returns None when neither matches.
    Pure -- no I/O.
    """
    match = _INSTALLED_IN_RE.search(text)
    if match:
        return match.group(1).strip()
    match = _FULL_GUIDELINES_RE.search(text)
    if match:
        return match.group(1).strip()
    return None


def _extract_managed_section(text: str) -> str | None:
    """Return the bracketed managed-section block, or None when markers are absent."""
    normalised = text.replace("\r\n", "\n")
    open_match = _AGENTS_MANAGED_OPEN_RE.search(normalised)
    if open_match is None:
        return None
    open_idx = open_match.start()
    close_idx = normalised.find(_AGENTS_MANAGED_CLOSE, open_match.end())
    if close_idx < 0:
        return None
    end = close_idx + len(_AGENTS_MANAGED_CLOSE)
    return normalised[open_idx:end]


_MANIFEST_LINE_RE = re.compile(r"^\s*(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?P<value>.*?)\s*$")


def _parse_manifest(text: str) -> dict:
    """Minimal YAML-ish ``key: value`` parser (#1046 PR-B AC-4).

    Mirrors ``run::_parse_install_manifest``. Pure -- no I/O.
    """
    parsed: dict = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _MANIFEST_LINE_RE.match(stripped)
        if match is None:
            continue
        key = match.group("key").strip().lower()
        value = match.group("value").strip().strip("'\"")
        if key:
            parsed[key] = value
    return parsed


def _manifest_tag_to_version(manifest: dict) -> str | None:
    """Derive the bare ``.deft-version`` value from a manifest dict."""
    for key in ("tag", "ref"):
        raw = manifest.get(key)
        if not isinstance(raw, str):
            continue
        candidate = raw.strip().lstrip("v")
        if candidate:
            return candidate
    return None


def _manifest_candidate_paths(
    project_root: Path, install_root: str | None
) -> list[Path]:
    """Return the canonical-first VERSION-manifest probe order (#1427).

    The install provenance manifest is written to divergent paths by two
    install rails: the Go installer writes the documented canonical
    ``<install_root>/VERSION`` (``.deft/core/VERSION`` per #1062), while the
    webinstaller writes ``.deft/VERSION`` (a 5-field manifest that omits the
    #1062 ``install_root`` field). The ordering below is **canonical-first**
    so an existing ``.deft/core/VERSION`` always wins over a stale
    ``.deft/VERSION``:

      1. ``<install_root>/VERSION`` -- the AGENTS.md / manifest-declared
         install root, when known (skipped when ``install_root`` is None).
      2. ``.deft/core/VERSION``    -- the v0.27+ canonical install (#1062).
      3. ``.deft/VERSION``         -- the webinstaller-vendored location
         (#1427); restores detection for that population.
      4. ``deft/VERSION``          -- the pre-v0.27 legacy install.

    Duplicates are removed while preserving order so an ``install_root`` of
    ``.deft/core`` does not probe the same path twice. Pure -- builds paths
    only; no filesystem access.
    """
    raw: list[Path] = []
    if install_root:
        raw.append(project_root / install_root / "VERSION")
    raw.append(project_root / ".deft" / "core" / "VERSION")
    raw.append(project_root / ".deft" / "VERSION")
    raw.append(project_root / "deft" / "VERSION")
    seen: set[str] = set()
    ordered: list[Path] = []
    for candidate in raw:
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            ordered.append(candidate)
    return ordered


def _locate_manifest(project_root: Path, install_root: str | None) -> Path | None:
    """Return the first existing VERSION manifest, canonical-first (#1427).

    Walks :func:`_manifest_candidate_paths` in canonical-first order and
    returns the first candidate that exists on disk, or ``None`` when no
    manifest is present. Centralises the manifest-location contract so
    ``_check_manifest_agreement``, ``_check_install_path_consistency``, and
    the #1339 payload-staleness read path all agree on where a manifest may
    live -- including the webinstaller's ``.deft/VERSION`` location.
    """
    for candidate in _manifest_candidate_paths(project_root, install_root):
        if candidate.is_file():
            return candidate
    return None


def _is_deprecation_redirect_stub(text: str) -> bool:
    """Return True when a resolved skill file is an actual redirect stub."""
    lines = text.replace("\r\n", "\n").lstrip().splitlines()
    sentinels = {
        _DEPRECATED_REDIRECT_SENTINEL,
        _DEPRECATED_SKILL_REDIRECT_SENTINEL,
    }
    return any(line.strip() in sentinels for line in lines[:_REDIRECT_STUB_HEADER_LINES])


# ---------------------------------------------------------------------------
# Checks (ported from framework_doctor.py)
# ---------------------------------------------------------------------------


def _check_quick_start_resolves(project_root: Path, install_root: str | None) -> CheckResult:
    """Check #1: QUICK-START.md resolves from the install root AGENTS.md claims."""
    if install_root is None:
        return CheckResult(
            name="quick-start-resolves",
            status="skip",
            detail=(
                "AGENTS.md does not declare an install root; cannot check "
                "QUICK-START.md resolution."
            ),
        )
    qs_path = project_root / install_root / "QUICK-START.md"
    if qs_path.is_file():
        return CheckResult(
            name="quick-start-resolves",
            status="pass",
            detail=f"Found QUICK-START.md at {qs_path}.",
            data={"path": str(qs_path), "install_root": install_root},
        )
    return CheckResult(
        name="quick-start-resolves",
        status="fail",
        detail=(
            f"QUICK-START.md not found at {qs_path}. AGENTS.md claims the "
            f"install root is {install_root!r} but the file is missing. "
            "Run `.deft/core/run agents:refresh` (Unix) / "
            "`.deft\\core\\run agents:refresh` (Windows) to align AGENTS.md "
            "with the on-disk install root, OR run `task upgrade` to "
            "re-pull the framework if the on-disk install is missing. "
            "See UPGRADING.md for the canonical drift-repair walkthrough."
        ),
        data={
            "path": str(qs_path),
            "install_root": install_root,
            # Dual repair-path contract: ``suggested_fix`` is the AGENTS.md
            # realignment (preferred when the on-disk framework is correct);
            # ``suggested_fix_alt`` re-pulls the framework when the on-disk
            # install is missing entirely. Mirrors the prose's two-option
            # phrasing so programmatic consumers (sync skill / CI) see the
            # same dual surface as humans (SLizard P1 on PR #1067).
            "suggested_fix": ".deft/core/run agents:refresh",
            "suggested_fix_alt": "task upgrade",
        },
    )


def _check_skill_paths_resolve(project_root: Path, agents_md_text: str) -> CheckResult:
    """Check #2: every <install>/skills/<name>/SKILL.md AGENTS.md references resolves."""
    referenced = sorted({m.group(0) for m in _SKILL_PATH_RE.finditer(agents_md_text)})
    if not referenced:
        return CheckResult(
            name="skill-paths-resolve",
            status="skip",
            detail="AGENTS.md references no skill paths to verify.",
            data={"referenced": []},
        )
    missing: list[str] = []
    redirect_stubs: list[str] = []
    for rel in referenced:
        candidate = project_root / rel
        if not candidate.is_file():
            missing.append(rel)
            continue
        text = _read_text_safe(candidate)
        if text is not None and _is_deprecation_redirect_stub(text):
            redirect_stubs.append(rel)
    if not missing and not redirect_stubs:
        return CheckResult(
            name="skill-paths-resolve",
            status="pass",
            detail=f"All {len(referenced)} skill path(s) resolve.",
            data={"referenced": referenced},
        )
    parts: list[str] = []
    if missing:
        parts.append(f"missing: {missing}")
    if redirect_stubs:
        parts.append(f"deprecation-redirect stubs: {redirect_stubs}")
    return CheckResult(
        name="skill-paths-resolve",
        status="fail",
        detail=(
            f"{len(missing)} skill path(s) do not resolve; "
            f"{len(redirect_stubs)} stub redirect(s). " + "; ".join(parts)
            + ". Run `.deft/core/run agents:refresh` (Unix) / "
            "`.deft\\core\\run agents:refresh` (Windows) to rewrite the "
            "managed AGENTS.md block so skill paths match the on-disk "
            "framework, OR run `task upgrade` if the on-disk skills are "
            "missing entirely. See UPGRADING.md for the drift-repair walkthrough."
        ),
        data={
            "referenced": referenced,
            "missing": missing,
            "redirect_stubs": redirect_stubs,
            # Dual repair-path contract -- see ``_check_quick_start_resolves``
            # for the rationale (SLizard P1 on PR #1067).
            "suggested_fix": ".deft/core/run agents:refresh",
            "suggested_fix_alt": "task upgrade",
        },
    )


def _check_manifest_agreement(project_root: Path, install_root: str | None) -> CheckResult:
    """Check #3: <install>/VERSION YAML manifest agrees with <root>/.deft-version.

    The manifest is located via :func:`_locate_manifest` (#1427) so a
    webinstaller-vendored install whose manifest is at ``.deft/VERSION`` is
    found, canonical-first. ``install_root`` may be None (the webinstaller
    population whose manifest omits the #1062 ``install_root`` field and
    whose AGENTS.md therefore yields no install-root claim) -- the helper
    still probes the canonical/legacy locations, so detection no longer
    depends on the AGENTS.md install-root parse.
    """
    manifest_path = _locate_manifest(project_root, install_root)
    # Canonical-first expected location for diagnostics when no manifest is
    # found on disk (``_manifest_candidate_paths`` always returns >= 1 entry).
    expected_manifest_path = (
        manifest_path
        if manifest_path is not None
        else _manifest_candidate_paths(project_root, install_root)[0]
    )
    bare_candidates = [
        project_root / "vbrief" / ".deft-version",
        project_root / ".deft-version",
    ]
    bare_path: Path | None = next((p for p in bare_candidates if p.is_file()), None)
    manifest_text = _read_text_safe(manifest_path) if manifest_path else None
    bare_text = _read_text_safe(bare_path) if bare_path else None
    if manifest_text is None and bare_text is None:
        return CheckResult(
            name="manifest-agreement",
            status="skip",
            detail=(
                "Neither YAML manifest nor bare .deft-version exists; "
                "nothing to reconcile (greenfield install)."
            ),
            data={
                "manifest_path": str(manifest_path) if manifest_path else None,
                "bare_path": str(bare_path) if bare_path else None,
            },
        )
    if manifest_text is None:
        return CheckResult(
            name="manifest-agreement",
            status="fail",
            detail=(
                f"Bare .deft-version exists at {bare_path} but YAML manifest "
                f"is missing at {expected_manifest_path}. Run `task upgrade` to write "
                "the canonical manifest (#1046 PR-B AC-4). See UPGRADING.md "
                "for the v0.27.x -> v0.28 transition walkthrough."
            ),
            data={
                "manifest_path": str(manifest_path) if manifest_path else None,
                "expected_manifest_path": str(expected_manifest_path),
                "bare_path": str(bare_path) if bare_path else None,
                "bare_value": (bare_text or "").strip() if bare_text else None,
                "suggested_fix": "task upgrade",
            },
        )
    if bare_text is None:
        # YAML present, bare missing -- not a drift in itself; cmd_upgrade
        # will derive the bare file on next run. Report as pass with a note.
        manifest = _parse_manifest(manifest_text)
        derived = _manifest_tag_to_version(manifest)
        return CheckResult(
            name="manifest-agreement",
            status="pass",
            detail=(
                f"YAML manifest at {manifest_path} present; bare .deft-version "
                f"absent (derived value: {derived!r} from manifest tag). "
                "Run `task upgrade` to regenerate the derivative."
            ),
            data={
                "manifest_path": str(manifest_path),
                "manifest": manifest,
                "derived_version": derived,
            },
        )
    manifest = _parse_manifest(manifest_text)
    derived = _manifest_tag_to_version(manifest)
    bare_value = bare_text.strip()
    if derived is None:
        return CheckResult(
            name="manifest-agreement",
            status="fail",
            detail=(
                f"YAML manifest at {manifest_path} has no parseable tag/ref "
                "field; cannot reconcile with bare .deft-version."
            ),
            data={
                "manifest_path": str(manifest_path),
                "bare_path": str(bare_path),
                "manifest": manifest,
                "bare_value": bare_value,
            },
        )
    if derived == bare_value:
        return CheckResult(
            name="manifest-agreement",
            status="pass",
            detail=(
                f"YAML manifest (tag={derived!r}) agrees with bare .deft-version ({bare_value!r})."
            ),
            data={
                "manifest_path": str(manifest_path),
                "bare_path": str(bare_path),
                "derived_version": derived,
                "bare_value": bare_value,
            },
        )
    return CheckResult(
        name="manifest-agreement",
        status="fail",
        detail=(
            f"Drift detected: YAML manifest tag={derived!r} does NOT agree "
            f"with bare .deft-version={bare_value!r}. Per #1046 PR-B AC-4 "
            "the YAML manifest is the canonical source -- run `task upgrade` "
            "to regenerate the bare derivative from the manifest, OR "
            f"manually update {manifest_path} if the bare value is correct. "
            "See UPGRADING.md for the canonical drift-repair walkthrough."
        ),
        data={
            "manifest_path": str(manifest_path),
            "bare_path": str(bare_path),
            "derived_version": derived,
            "bare_value": bare_value,
            "authoritative": "manifest",
            "suggested_fix": "task upgrade",
        },
    )


def _check_install_path_consistency(project_root: Path, install_root: str | None) -> CheckResult:
    """Check #4: AGENTS.md install-root claim resolves to an on-disk directory.

    Narrow scope by design (#1046 PR-B Greptile review #1057): this check
    only verifies that the install root AGENTS.md declares is a real
    directory on disk. The cross-check that the YAML manifest is
    **co-located** at that root is the responsibility of check #3
    (``manifest-agreement``) -- when the manifest lives at a different
    install root (e.g. legacy ``deft/VERSION`` while AGENTS.md claims
    ``.deft/core``), check #3 reports the drift with the manifest as the
    authoritative source. Splitting the responsibility keeps each check
    independently actionable: this one says "reinstall or fix AGENTS.md",
    check #3 says "reconcile the manifest with the bare derivative".
    """
    effective_install_root = install_root
    fallback_info_note = ""
    source = "AGENTS.md"
    # #1062: prefer the manifest-side ``install_root`` field when present --
    # it is the single source of truth for the install-layout contract.
    # Fall back to the legacy AGENTS.md parse only when the manifest exists
    # but predates the field (legacy v0.28 shape) or no manifest exists.
    # The ``source`` flag stays sticky across the manifest-found-but-empty
    # path so the diagnostic prose later accurately names where the
    # effective install root came from (Greptile P1 on PR #1063 -- prior
    # heuristic compared values, which mislabelled when manifest and
    # AGENTS.md happened to agree).
    # #1427: probe the manifest canonical-first via the shared candidate
    # list so a webinstaller-vendored ``.deft/VERSION`` is considered too
    # (the prior shape probed only ``.deft/core/VERSION`` and legacy
    # ``deft/VERSION``). Iterate the candidate list rather than call
    # ``_locate_manifest`` so an existing-but-unreadable manifest (OSError /
    # permission denial -> ``_read_text_safe`` returns None) falls through
    # to the next candidate, preserving the ``continue``-on-unreadable
    # resilience of the original two-path loop (Greptile P2 on PR #1431).
    # The first READABLE manifest wins, matching the prior
    # break-on-first-found semantics.
    for manifest_path in _manifest_candidate_paths(project_root, install_root):
        manifest_text = _read_text_safe(manifest_path)
        if manifest_text is None:
            continue
        manifest = _parse_manifest(manifest_text)
        manifest_install_root = manifest.get("install_root")
        if isinstance(manifest_install_root, str) and manifest_install_root.strip():
            effective_install_root = manifest_install_root.strip()
            fallback_info_note = ""
            source = "manifest"
            break
        # Manifest found but missing the #1062 ``install_root`` field
        # (legacy v0.28 shape, or a webinstaller ``.deft/VERSION`` that
        # omits it). Fall back to the AGENTS.md parse and note it.
        # ``source`` stays "AGENTS.md" -- the manifest was found but did not
        # carry the install_root field, so the effective value still came
        # from the AGENTS.md parse.
        fallback_info_note = (
            f" INFO: manifest at {manifest_path} is missing install_root; "
            "fell back to the legacy AGENTS.md install-root parse."
        )
        break
    if effective_install_root is None:
        return CheckResult(
            name="install-path-consistency",
            status="skip",
            detail=(
                "AGENTS.md does not declare an install root."
                + fallback_info_note
            ),
            data={
                "claimed_install_root": install_root,
                "effective_install_root": effective_install_root,
                "fallback_info_note": fallback_info_note or None,
            },
        )
    claimed_dir = project_root / effective_install_root
    if not claimed_dir.is_dir():
        return CheckResult(
            name="install-path-consistency",
            status="fail",
            detail=(
                f"Install root is recorded as {effective_install_root!r} "
                f"(source: {source}) but {claimed_dir} is not a directory. "
                "Pick one of two repair paths: "
                "(a) run `.deft/core/run agents:refresh` (Unix) / "
                "`.deft\\core\\run agents:refresh` (Windows) to rewrite "
                "AGENTS.md to match the on-disk framework -- pick this if "
                "the framework on disk is correct; OR "
                "(b) run `task relocate:relocate -- --confirm` to move the "
                "framework to the path AGENTS.md / the manifest claims -- "
                "pick this if AGENTS.md is correct. The YAML manifest (if "
                "present) is authoritative for the install-layout contract. "
                "See UPGRADING.md for the canonical drift-repair walkthrough."
            ),
            data={
                "claimed_install_root": install_root,
                "effective_install_root": effective_install_root,
                "effective_install_root_source": source,
                "claimed_dir": str(claimed_dir),
                "claimed_dir_exists": False,
                "fallback_info_note": fallback_info_note or None,
                "suggested_fix": ".deft/core/run agents:refresh",
                "suggested_fix_alt": "task relocate:relocate -- --confirm",
            },
        )
    # Note: this check intentionally does NOT verify the YAML manifest
    # is co-located at ``<claimed_dir>/VERSION`` -- that cross-check is
    # owned by check #3 (``manifest-agreement``). See docstring for the
    # rationale and the per-check responsibility split.
    return CheckResult(
        name="install-path-consistency",
        status="pass",
        detail=(
            f"Install root ({effective_install_root!r}, source: {source}) "
            f"matches an existing directory at {claimed_dir}."
            + fallback_info_note
        ),
        data={
            "claimed_install_root": install_root,
            "effective_install_root": effective_install_root,
            "effective_install_root_source": source,
            "claimed_dir": str(claimed_dir),
            "fallback_info_note": fallback_info_note or None,
        },
    )


# ---------------------------------------------------------------------------
# Top-level driver (ported) -- provides run_checks for tests + internal use
# ---------------------------------------------------------------------------


def run_checks(project_root: Path) -> dict:
    """Run all four checks and return a structured payload.

    Public API consumed by ``run::_maybe_run_framework_doctor`` (and tests).
    Returns the DoctorResult dict shape directly. Best-effort -- any
    individual check that fails to run converts to an ``error`` status and
    propagates to exit code 2.
    """
    return _run_checks_impl(project_root).to_dict()


def _run_checks_impl(project_root: Path) -> DoctorResult:
    """Internal driver -- returns the dataclass form for richer testing."""
    errors: list[str] = []
    if not project_root.is_dir():
        return DoctorResult(
            project_root=str(project_root),
            install_root=None,
            exit_code=EXIT_CONFIG_ERROR,
            checks=[],
            errors=[f"project root does not exist: {project_root}"],
        )

    agents_md_path = project_root / "AGENTS.md"
    agents_md_text = _read_text_safe(agents_md_path)
    install_root: str | None = None
    if agents_md_text is not None:
        install_root = _parse_install_root_from_agents_md(agents_md_text)

    checks: list[CheckResult] = []

    # If AGENTS.md is missing entirely, the install-root-dependent checks
    # all skip; surface this fact in a synthetic check so operators see
    # the cause.
    if agents_md_text is None:
        checks.append(
            CheckResult(
                name="agents-md-present",
                status="fail",
                detail=(
                    "AGENTS.md not found at project root -- run "
                    "`.deft/core/run agents:refresh` to generate it from "
                    "the canonical template."
                ),
                data={"agents_md_path": str(agents_md_path)},
            )
        )
        # Still attempt the manifest agreement check (it can run without
        # AGENTS.md for the greenfield case).
        checks.append(_check_manifest_agreement(project_root, None))
        return DoctorResult(
            project_root=str(project_root),
            install_root=None,
            exit_code=_derive_exit_code(checks, errors),
            checks=checks,
            errors=errors,
        )

    checks.append(_check_quick_start_resolves(project_root, install_root))
    checks.append(_check_skill_paths_resolve(project_root, agents_md_text))
    checks.append(_check_manifest_agreement(project_root, install_root))
    checks.append(_check_install_path_consistency(project_root, install_root))

    return DoctorResult(
        project_root=str(project_root),
        install_root=install_root,
        exit_code=_derive_exit_code(checks, errors),
        checks=checks,
        errors=errors,
    )


def _derive_exit_code(checks: list[CheckResult], errors: list[str]) -> int:
    """Three-state exit code from check results + errors."""
    if errors or any(c.status == "error" for c in checks):
        return EXIT_CONFIG_ERROR
    if any(c.status == "fail" for c in checks):
        return EXIT_DRIFT
    return EXIT_CLEAN


# --- Extracted doctor logic (from run, markers removed, now owned here) ---
# (start of logic extracted from monolithic run per #1335)
# The block from this marker through DOCTOR-EXTRACTION-END (the end of
# cmd_doctor, just before def cmd_update) is extracted verbatim into
# scripts/doctor.py . After extraction, this region is replaced by a
# thin shim that does the path-insert + import + delegation.
# The scripts/doctor.py now owns the core doctor logic.
# ===

# ── #1272 root Taskfile.yml include diagnostics ──────────────────────────
#
# A freshly installed directive project does not have a working `task X`
# surface from the project root until the consumer wires their
# root-level Taskfile.yml to include `.deft/core/Taskfile.yml`. The
# install policy in `main.md` correctly prohibits silent mutation of
# the consumer's existing Taskfile.yml, but the framework should still
# *diagnose* the missing-include / missing-file shapes the moment the
# operator runs doctor. Interactive `run doctor --fix` may offer to
# create a Taskfile.yml when one is absent (explicit consent required);
# the default and `--session` paths NEVER mutate filesystem state.
#
# The canonical snippet is mirrored verbatim from `.deft/core/main.md`
# ("Publishing deft tasks in your project root") so doctor's output and
# the prose documentation never drift.

# Canonical YAML snippet emitted by doctor's diagnostic output and
# written verbatim when the operator opts in to interactive repair.
# Kept as a module-level constant so tests can compare against the
# exact bytes a write would produce.
_TASKFILE_INCLUDE_SNIPPET = (
    "version: '3'\n"
    "\n"
    "includes:\n"
    "  deft:\n"
    "    taskfile: ./.deft/core/Taskfile.yml\n"
    "    optional: true\n"
)

# Matches a top-level YAML ``includes:`` declaration. Used by the
# indentation-aware state machine in :func:`_includes_block_has_deft_taskfile`
# to anchor the scan: a ``taskfile:`` line that lives inside any other
# block (e.g. ``vars:``, ``tasks:`` cmds, a YAML comment, a long string
# scalar) MUST NOT count as a valid deft framework include, otherwise
# the diagnostic mis-reports ``ok`` on a Taskfile that mentions the
# string ``taskfile: ./.deft/core/Taskfile.yml`` in unrelated context
# (a comment, an example block, an echo cmd). See #1303 review.
_TASKFILE_INCLUDES_KEY_RE = re.compile(
    r"^(?P<indent>[\t ]*)includes\s*:\s*(?:#.*)?$",
    re.IGNORECASE,
)

# Matches ``taskfile: <path-to-deft-framework-Taskfile>`` value lines that
# appear under the ``includes:`` mapping. Tolerates leading ``./``,
# surrounding whitespace, optional single/double quotes around the value,
# and an inline ``# ...`` comment trailing the value. Case-insensitive so
# both ``Taskfile.yml`` and ``taskfile.yml`` match. Indent MUST be > 0
# under a top-level ``includes:`` block.
_TASKFILE_INCLUDE_VALUE_RE = re.compile(
    r"^[\t ]+taskfile\s*:\s*[\"']?\.?/?(?:\.deft/core|deft)/Taskfile\.ya?ml[\"']?"
    r"\s*(?:#.*)?$",
    re.IGNORECASE,
)


def _includes_block_has_deft_taskfile(text: str) -> bool:
    """Return True iff a top-level ``includes:`` mapping points at deft.

    Walks ``text`` line-by-line with a small indentation-aware state
    machine: anchors on a top-level (indent 0) ``includes:`` key, then
    scans the strictly-greater-indent body for a ``taskfile:`` property
    whose value resolves to either the canonical ``./.deft/core/Taskfile.yml``
    or the pre-v0.27 legacy ``./deft/Taskfile.yml``. Lines whose indent
    is less-than-or-equal-to the ``includes:`` indent end the block.

    Stdlib-only: ``run`` is the bootstrap entry point and cannot assume
    PyYAML is installed. A full YAML walk would be more robust but adds
    a runtime dependency we deliberately avoid here.
    """
    includes_indent: int | None = None
    in_includes = False
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" \t"))
        if not in_includes:
            match = _TASKFILE_INCLUDES_KEY_RE.match(raw_line)
            if match is not None and indent == 0:
                includes_indent = indent
                in_includes = True
            continue
        if indent <= (includes_indent or 0):
            in_includes = False
            match = _TASKFILE_INCLUDES_KEY_RE.match(raw_line)
            if match is not None and indent == 0:
                includes_indent = indent
                in_includes = True
            continue
        if _TASKFILE_INCLUDE_VALUE_RE.match(raw_line):
            return True
    return False


def _resolve_consumer_taskfile(
    project_root: Path | None = None,
) -> Path | None:
    """Return the consumer project's root Taskfile path, or None if absent.

    Recognises both ``Taskfile.yml`` and ``Taskfile.yaml`` so the
    diagnostic accepts whichever spelling the consumer chose. Returns
    the first candidate that exists on disk; returns ``None`` when
    neither file is present so callers can distinguish the
    missing-file case from the missing-include case.

    ``project_root`` defaults to ``Path.cwd()`` when omitted so existing
    callers stay backward-compatible; the explicit-argument shape is the
    canonical form so :func:`cmd_doctor` can honour a user-supplied
    ``--project-root <path>`` (#1303 review).
    """
    if project_root is None:
        project_root = Path.cwd()
    for name in ("Taskfile.yml", "Taskfile.yaml"):
        candidate = project_root / name
        if candidate.is_file():
            return candidate
    return None


def _classify_taskfile_include(project_root: Path) -> str:
    """Classify the consumer's root Taskfile include health (#1272).

    Returns one of:
        ``ok``              -- root Taskfile.yml present and includes the
                               deft framework Taskfile (``./.deft/core/Taskfile.yml``
                               or the legacy ``./deft/Taskfile.yml``).
        ``missing-file``    -- neither ``Taskfile.yml`` nor ``Taskfile.yaml``
                               exists at the project root. Interactive
                               ``run doctor --fix`` may create one with
                               explicit consent.
        ``missing-include`` -- a root Taskfile exists but contains no
                               include pointing at the deft framework
                               Taskfile. Doctor NEVER mutates an
                               existing user-owned Taskfile -- diagnose
                               only; the operator pastes the snippet.
        ``unreadable``      -- a root Taskfile exists but could not be
                               read (permission error, etc.). Diagnose;
                               do not repair.

    Pure -- read-only filesystem probe + indentation-aware string walk.
    Never mutates state.
    """
    taskfile = _resolve_consumer_taskfile(project_root)
    if taskfile is None:
        return "missing-file"
    try:
        # ``utf-8-sig`` transparently strips a leading UTF-8 BOM if present.
        # Windows editors (Notepad, some VS Code configurations) persist YAML
        # with a BOM byte at the head; ``utf-8`` would keep the ``\ufeff``
        # prefix in ``text`` and defeat the ``^[\t ]*includes`` anchor in
        # :func:`_includes_block_has_deft_taskfile`, producing a spurious
        # ``missing-include`` diagnostic on a legitimately wired Taskfile.
        # See #1303 pass-2 review.
        text = taskfile.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return "unreadable"
    if _includes_block_has_deft_taskfile(text):
        return "ok"
    return "missing-include"


def _format_missing_include_snippet() -> str:
    """Return the paste-ready `includes:` fragment for an existing Taskfile.

    Used by doctor's ``missing-include`` diagnostic so the operator
    sees the exact YAML they need to paste under their existing
    ``includes:`` block, without the ``version: '3'`` header (which
    their existing file already supplies).
    """
    return (
        "  deft:\n"
        "    taskfile: ./.deft/core/Taskfile.yml\n"
        "    optional: true\n"
    )


def _parse_doctor_flags(args: list[str]) -> dict:
    """Parse the doctor-specific CLI flags (#1272, #1303 review).

    Recognises (whitelist; unknown tokens surface as ``unknown``):
        ``--session``                -- diagnose-only, session-safe mode.
                                        NEVER prompts, NEVER mutates
                                        filesystem state. Suitable for
                                        invocation from session-start
                                        rituals.
        ``--fix`` / ``--repair`` /   -- offer interactive repair when
        ``--repair-taskfile``           actionable (currently: create
                                        missing root Taskfile.yml with
                                        the canonical include). Requires
                                        an interactive TTY AND explicit
                                        operator approval at the prompt;
                                        ignored when ``--session`` is
                                        also passed.
        ``--json``                   -- emit a single JSON object on
                                        stdout describing the findings;
                                        suppresses the human-readable
                                        prose surface. Exit code is
                                        still 0 (clean) / 1 (errors).
        ``--quiet``                  -- suppress the per-check success
                                        lines; errors and warnings still
                                        surface.
        ``--project-root <path>`` /  -- override the project root used
        ``--project-root=<path>``       for the Taskfile diagnostic.
                                        Defaults to :func:`Path.cwd`.
        ``-h`` / ``--help``          -- accepted (caller decides how to
                                        render help text); does not run
                                        the diagnostics.

    Unknown tokens are collected into ``flags["unknown"]`` so the caller
    can exit non-zero with a useful error message rather than silently
    swallowing a typo (e.g. ``--repare`` instead of ``--repair`` -- the
    pre-review behaviour shipped diagnostics that ignored the typo,
    masking the fact that the user never opted into repair).
    """
    flags = {
        "session": False,
        "fix": False,
        "json": False,
        "quiet": False,
        "full": False,
        "help": False,
        "project_root": None,
        "unknown": [],
    }
    i = 0
    while i < len(args):
        token = args[i]
        if token == "--session":
            flags["session"] = True
        elif token in ("--fix", "--repair", "--repair-taskfile"):
            flags["fix"] = True
        elif token == "--json":
            flags["json"] = True
        elif token == "--quiet":
            flags["quiet"] = True
        elif token == "--full":
            # #1308: bypass the 24h/4h throttle and always run the full
            # check. Operators reach for this when the prior run was
            # dirty (errors) and they want to re-probe after fixing,
            # OR when they want to re-confirm a clean run before
            # publishing a swarm.
            flags["full"] = True
        elif token in ("-h", "--help"):
            flags["help"] = True
        elif token == "--project-root":
            if i + 1 >= len(args):
                flags["unknown"].append("--project-root (missing value)")
            else:
                i += 1
                flags["project_root"] = args[i]
        elif token.startswith("--project-root="):
            value = token.split("=", 1)[1]
            if value:
                flags["project_root"] = value
            else:
                flags["unknown"].append("--project-root= (empty value)")
        else:
            flags["unknown"].append(token)
        i += 1
    return flags


# Allowed flag set for ``run doctor`` -- surfaced in the error message
# emitted when ``_parse_doctor_flags`` collects an unknown token (#1303
# review correctness #3). Keep in sync with the registered branches in
# :func:`_parse_doctor_flags`.
_DOCTOR_ALLOWED_FLAGS = (
    "--session",
    "--fix",
    "--repair",
    "--repair-taskfile",
    "--json",
    "--quiet",
    "--full",
    "--project-root",
    "-h",
    "--help",
)


def _load_doctor_state_module():
    """Lazy-import ``scripts/_doctor_state`` (#1308)."""
    try:
        # Inside scripts/doctor.py, get_script_dir() already returns the
        # scripts/ dir containing sibling _doctor_state.py. Do not append
        # another "/scripts" (would resolve to scripts/scripts/ and break
        # throttle state load when doctor.py is the entry point).
        scripts_dir = get_script_dir()
        if str(scripts_dir) not in sys.path:
            sys.path.insert(0, str(scripts_dir))
        import _doctor_state  # type: ignore[import-not-found]
        return _doctor_state
    except Exception:  # noqa: BLE001 -- state load MUST NOT break doctor
        return None


def _evaluate_doctor_throttle(project_root: Path):
    """Read doctor state and compute the 24h/4h throttle decision (#1308)."""
    mod = _load_doctor_state_module()
    if mod is None:
        return None
    try:
        state = mod.read_state(project_root)
        return mod.decide_throttle(state)
    except Exception:  # noqa: BLE001 -- state read MUST NOT break doctor
        return None


# --- Ported from run (required by cmd_doctor / freshness / throttle paths) ---
# These were left behind during the initial extraction; without them every
# `run doctor` (non-throttled path) hits NameError before any check runs.
# Small batch ports; supporting constants/defs included where referenced.

# Minimal local read_yn (used only in interactive --fix Taskfile repair path
# under isatty + fix_mode). Closes the "undefined" gap Greptile summary
# flagged on the post-7a0606c head. Full ask_confirm lives in run; this is
# the smallest non-crashing implementation sufficient for doctor.
def read_yn(prompt_text: str, default: bool = False) -> bool:
    """Yes/No prompt (read_yn alias to run's ask_confirm)."""
    try:
        suffix = " (Y/n): " if default else " (y/N): "
        resp = input(f"{prompt_text}{suffix}").strip().lower()
        if not resp:
            return default
        return resp[0] in ("y", "yes")
    except (EOFError, KeyboardInterrupt):
        return default


def _load_agents_md_module():
    """Lazy-import the shared ``scripts/_agents_md`` helpers (#1389).

    ``get_script_dir()`` already returns the ``scripts/`` directory holding
    the sibling ``_agents_md.py``, so mirror ``_load_doctor_state_module``
    and insert it on ``sys.path`` before importing. The freshness probe can
    then share ``run``'s exact managed-section verdict logic instead of the
    interim stub that always reported ``unreadable``.
    """
    scripts_dir = get_script_dir()
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    import _agents_md  # type: ignore[import-not-found]
    return _agents_md


def _agents_refresh_plan(project_root: Path) -> dict:
    """Compute the real AGENTS.md managed-section freshness verdict (#1389).

    Delegates to the shared, pure ``scripts/_agents_md._agents_refresh_plan``
    -- the same implementation ``run`` uses -- so a consumer whose managed
    section is present, readable and current reports ``state == "current"``
    (no freshness warning) instead of the previous interim stub that
    unconditionally returned ``{"state": "unreadable"}`` and produced a
    spurious warning on every ``task doctor`` run. Genuinely stale sections
    report ``stale`` (the freshness check then points the operator at
    ``task agents:refresh``); a genuinely unreadable / template-missing
    state still surfaces a warning.
    """
    return _load_agents_md_module()._agents_refresh_plan(project_root)


def _now_utc() -> datetime:
    """Return UTC-aware ``datetime.now`` (split out for test monkeypatching)."""
    return datetime.now(UTC)


_DEFT_REPO_POSITIVE_MARKERS = (
    Path("templates") / "agents-entry.md",
    Path("skills") / "deft-directive-build" / "SKILL.md",
)


def _running_inside_deft_repo(project_root: Path) -> bool:
    """Heuristic: True when `run` is invoked from inside the deft repo itself.

    Consumer projects embed deft as ``./deft/`` (legacy) or ``./.deft/core/``
    (canonical) and consume the framework's published surface; the deft
    source repo carries ``main.md`` at its root, has neither install
    location materialised inside its own checkout, AND ships a set of
    framework-internal artefacts (notably ``templates/agents-entry.md`` and
    ``skills/deft-directive-build/SKILL.md``) a consumer would have no
    reason to mirror.

    The heuristic fires only when ALL of the following hold:
      * ``main.md`` is present at ``project_root`` (the documented entry
        point a consumer never reproduces verbatim).
      * NEITHER ``./deft`` (legacy install) NOR ``./.deft/core`` (canonical
        install) exists at the project root -- both indicate the deft
        framework was installed INTO this directory rather than that this
        directory IS the framework.
      * ALL of the markers in ``_DEFT_REPO_POSITIVE_MARKERS`` resolve --
        framework-internal paths a consumer would never reproduce.

    The original heuristic (#1272 baseline) checked only ``main.md`` plus
    the absence of ``./deft``; that mis-fired on a consumer who happened
    to carry a root-level ``main.md`` for unrelated reasons OR who
    installed canonically to ``./.deft/core`` and so genuinely had no
    ``./deft`` subdirectory -- doctor would then silently skip the
    Taskfile-include diagnostic in exactly the place it was meant to
    surface (#1303 review SLizard P1, Greptile carryover).

    Skipping the gate here avoids nagging deft maintainers on every
    ``run`` invocation against the framework checkout itself.
    """
    if not (project_root / "main.md").is_file():
        return False
    if (project_root / "deft").is_dir():
        return False
    if (project_root / ".deft" / "core").is_dir():
        return False
    return all((project_root / marker).is_file() for marker in _DEFT_REPO_POSITIVE_MARKERS)


# --- Extracted doctor logic (from run, markers removed, now owned here) ---

def _format_iso_z(when) -> str:
    """Render a UTC-aware datetime as YYYY-MM-DDTHH:MM:SSZ."""
    if when is None:
        return ""
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _render_doctor_status_line(decision) -> str:
    """Render the human-readable throttle-skip line (#1308)."""
    age_h = max(int(decision.age_hours), 0)
    if decision.dirty:
        errs = decision.last_error_count
        warns = max(decision.last_finding_count - decision.last_error_count, 0)
        err_phrase = f"{errs} error{'s' if errs != 1 else ''}"
        warn_phrase = f"{warns} warning{'s' if warns != 1 else ''}"
        return (
            f"[doctor] ran {age_h}h ago, {err_phrase} / {warn_phrase} "
            "-- UNRESOLVED; run `task doctor --full` to re-probe or "
            "address findings."
        )
    remaining = decision.next_eligible_at - _now_utc()
    remaining_h = max(int(remaining.total_seconds() // 3600), 0)
    return (
        f"[doctor] ran {age_h}h ago, clean; next eligible in "
        f"{remaining_h}h; --full forces."
    )


def _emit_doctor_throttle_skip(decision, *, json_mode: bool) -> int:
    """Print the throttle-skip surface and return the gated exit code (#1308)."""
    hint = (
        "run `task doctor --full` to re-probe or address findings"
        if decision.dirty
        else "--full forces"
    )
    if json_mode:
        payload = {
            "status": "throttle-skipped",
            "last_run_at": _format_iso_z(decision.last_run_at),
            "last_exit_code": decision.last_exit_code,
            "last_error_count": decision.last_error_count,
            "last_finding_count": decision.last_finding_count,
            "next_eligible_at": _format_iso_z(decision.next_eligible_at),
            "hint": hint,
        }
        print(json.dumps(payload, sort_keys=True))
    else:
        print(_render_doctor_status_line(decision))
    return 1 if decision.dirty else 0


def _persist_doctor_state(
    project_root: Path,
    *,
    exit_code: int,
    findings: list[dict],
) -> None:
    """Best-effort write of doctor-state.json after a full check (#1308)."""
    mod = _load_doctor_state_module()
    if mod is None:
        return
    try:
        mod.write_state(
            project_root,
            exit_code=int(exit_code),
            finding_count=len(findings),
            error_count=sum(1 for f in findings if f.get("severity") == "error"),
        )
    except Exception:  # noqa: BLE001 -- state write MUST NOT break doctor
        return


def _run_install_integrity_checks(
    project_root: Path,
    *,
    emit_success,
    emit_warn,
    emit_error,
    emit_info,
    add_finding,
) -> None:
    """Install-integrity checks (ex-framework_doctor.py) folded into
    canonical doctor (#1308, #1336 retirement).
    """
    if _running_inside_deft_repo(project_root):
        emit_info(
            "Skipping install-integrity checks -- running inside the deft "
            "framework repo (no install manifest in the source checkout)."
        )
        return
    try:
        # Direct call to the local (ported) implementation -- no self-import
        # hack, no path munging. The four checks now run for real.
        result = run_checks(project_root)
    except Exception as exc:  # noqa: BLE001 -- probe failure is a warning
        message = f"Install-integrity probe unavailable: {type(exc).__name__}: {exc}"
        emit_warn(message)
        add_finding("warning", message, check="install-integrity")
        return
    for entry in result.get("checks", []) or []:
        name = entry.get("name", "install-integrity")
        status = entry.get("status", "")
        detail = entry.get("detail", "")
        if status == "pass":
            emit_success(f"{name}: pass")
            continue
        if status == "skip":
            emit_info(f"{name}: skip -- {detail}")
            continue
        if status == "error":
            emit_error(f"{name}: error -- {detail}")
        else:
            emit_error(f"{name}: fail -- {detail}")
        add_finding(
            "error",
            detail or f"{name} {status}",
            check=f"install-integrity:{name}",
            install_check=name,
            status=status,
            data=entry.get("data", {}),
        )


def _has_v3_managed_marker(project_root: Path) -> bool:
    """True iff AGENTS.md carries a deft:managed-section v3 marker (#1308)."""
    agents_md = project_root / "AGENTS.md"
    if not agents_md.is_file():
        return False
    try:
        text = agents_md.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return re.search(
        r"<!--\s*deft:managed-section\s+v3(?:\s+[^>]*?)?\s*-->",
        text,
    ) is not None


def _run_agents_md_freshness_check(
    project_root: Path,
    *,
    emit_success,
    emit_warn,
    emit_info,
    add_finding,
) -> None:
    """Probe AGENTS.md managed-section freshness via cmd_agents_refresh internals (#1308)."""
    check_name = "agents-md-managed-section-fresh"
    if _running_inside_deft_repo(project_root) or not _has_v3_managed_marker(
        project_root
    ):
        skip_reason = "no managed-section markers (likely maintainer repo)"
        emit_info(f"{check_name}: skip -- {skip_reason}")
        add_finding(
            "skip",
            skip_reason,
            check=check_name,
            status="skip",
        )
        return
    try:
        plan = _agents_refresh_plan(project_root)
    except Exception as exc:  # noqa: BLE001 -- never break doctor
        message = f"{check_name}: probe failed -- {type(exc).__name__}: {exc}"
        emit_warn(message)
        add_finding("warning", message, check=check_name)
        return
    state = plan.get("state", "")
    if state == "current":
        emit_success(f"{check_name}: current")
        return
    if state in ("stale", "missing", "absent"):
        message = (
            f"AGENTS.md managed section is {state} -- "
            "run `task agents:refresh` to bring it to the current template."
        )
        emit_warn(message)
        add_finding(
            "warning",
            message,
            check=check_name,
            status=state,
            suggestion="task agents:refresh",
        )
        return
    message = (
        f"AGENTS.md freshness check could not run (state={state!r}). "
        "Inspect the framework template or AGENTS.md file permissions."
    )
    emit_warn(message)
    add_finding("warning", message, check=check_name, status=state)


def _run_payload_staleness_check(
    project_root: Path,
    *,
    emit_warn,
    emit_info,
    add_finding,
) -> None:
    """#1339 (Epic-5): Detect when the installed framework payload is behind its
    manifest-recorded ref/sha. Reads the canonical <deftDir>/VERSION manifest
    (single source of truth per #1062), resolves the corresponding remote SHA
    via git ls-remote, and surfaces the canonical headless upgrade command
    `deft-install --yes --upgrade --repo-root . --json` (#1409) when the shas
    diverge. Skips gracefully inside the deft repo or when git / network /
    manifest unavailable (non-fatal, best-effort).
    """
    check_name = "payload-staleness"
    # Self-contained "inside deft repo" probe (avoids dependency on private
    # _running_inside_deft_repo helper that may be scoped inside cmd_doctor).
    try:
        agents = project_root / "AGENTS.md"
        is_deft = agents.exists() and (
            "Deft — Development Framework (deft repo)" in
            agents.read_text(encoding="utf-8", errors="ignore")
        )
        if is_deft:
            emit_info(f"{check_name}: skip -- running inside deft framework repo")
            add_finding(
                "skip", "inside framework repo (no install manifest)",
                check=check_name, status="skip",
            )
            return
    except Exception:
        pass

    # Locate a plausible manifest. Prefer the one next to the scripts/doctor.py
    # we are running from (when invoked via the installed layout); fall back to
    # common canonical/legacy locations under project_root.
    manifest_path = None
    try:
        # When doctor.py lives at <deftDir>/scripts/doctor.py the manifest is at <deftDir>/VERSION
        candidate = get_script_dir().parent / "VERSION"
        if candidate.exists():
            manifest_path = candidate
    except Exception:
        pass
    if manifest_path is None:
        # #1427: probe canonical-first via the shared helper so a
        # webinstaller-vendored ``.deft/VERSION`` manifest is found too
        # (the prior list probed only ``.deft/core/VERSION`` and legacy
        # ``deft/VERSION``).
        manifest_path = _locate_manifest(project_root, None)
    if manifest_path is None:
        # Legacy bare marker -- not a full manifest, but the last-resort
        # provenance source for a pre-v0.28 install. Kept out of
        # ``_locate_manifest`` because that helper returns VERSION-manifest
        # paths only.
        legacy_marker = project_root / ".deft-version"
        if legacy_marker.exists():
            manifest_path = legacy_marker
    if manifest_path is None or not manifest_path.exists():
        emit_info(f"{check_name}: skip -- no install manifest found (pre-v0.28 or legacy state)")
        add_finding("skip", "no manifest", check=check_name, status="skip")
        return

    try:
        text = manifest_path.read_text(encoding="utf-8", errors="replace")
        manifest = _parse_install_manifest(text)
    except Exception as exc:  # noqa: BLE001
        emit_info(f"{check_name}: skip -- could not read manifest: {exc}")
        add_finding("skip", f"manifest unreadable: {exc}", check=check_name, status="skip")
        return

    installed_sha = manifest.get("sha", "").strip()
    # Greptile P1 on #1384: do NOT fall back to "HEAD" when ref/tag are
    # absent. `git ls-remote origin HEAD` returns the current remote
    # default-branch tip, which almost certainly differs from the locally
    # installed sha for development builds without a ref/tag pinned, and
    # the check would then emit a permanent false-stale warning. Skip
    # cleanly when the manifest does not declare a ref/tag.
    ref = (manifest.get("ref") or manifest.get("tag") or "").strip()
    if not installed_sha:
        emit_info(f"{check_name}: skip -- manifest has no sha (incomplete provenance)")
        add_finding("skip", "no sha in manifest", check=check_name, status="skip")
        return
    if not ref:
        emit_info(
            f"{check_name}: skip -- manifest has no ref or tag (cannot resolve remote sha)"
        )
        add_finding("skip", "no ref/tag in manifest", check=check_name, status="skip")
        return

    # Resolve current remote SHA for the ref (best effort, may be tag or branch).
    # Use ls-remote to avoid needing a local fetch or modifying state.
    try:
        # Determine the deft dir from manifest location (parent of VERSION)
        deft_dir = manifest_path.parent
        # ls-remote origin <ref> (works for branches and tags)
        proc = subprocess.run(
            ["git", "-C", str(deft_dir), "ls-remote", "origin", ref],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode != 0:
            emit_info(f"{check_name}: skip -- git ls-remote failed (no network or no origin)")
            add_finding("skip", "ls-remote unavailable", check=check_name, status="skip")
            return
        # Output is "<sha>\t<refname>"
        # For annotated tags, ls-remote returns TWO lines:
        #   <tag-object-sha>	refs/tags/<tag>
        #   <commit-sha>	refs/tags/<tag>^{}
        # Prefer the peeled ^{} commit SHA when present (the one that matches
        # what the installer recorded in the manifest). Fall back to first line.
        # See Greptile P1 on #1384 (annotated-tag false-positive staleness).
        remote_sha = ""
        peeled_sha = ""
        for line in proc.stdout.splitlines():
            parts = line.strip().split()
            if len(parts) >= 2:
                refname = parts[1]
                if refname.endswith("^{}"):
                    peeled_sha = parts[0]
                elif not remote_sha:
                    remote_sha = parts[0]
        if peeled_sha:
            remote_sha = peeled_sha
        elif not remote_sha:
            # last-resort: first token of first line
            first_line = next((ln for ln in proc.stdout.splitlines() if ln.strip()), "")
            parts = first_line.strip().split()
            if parts:
                remote_sha = parts[0]
        if not remote_sha:
            emit_info(f"{check_name}: skip -- ls-remote produced no sha")
            add_finding("skip", "no remote sha", check=check_name, status="skip")
            return
    except Exception as exc:  # noqa: BLE001 -- network/git optional
        emit_info(f"{check_name}: skip -- could not probe remote ({type(exc).__name__})")
        add_finding("skip", f"remote probe failed: {exc}", check=check_name, status="skip")
        return

    if installed_sha == remote_sha:
        # Current
        emit_info(f"{check_name}: current (sha matches remote)")
        return

    # Stale! Emit the EXACT canonical headless upgrade command (#1409) so a
    # normal consumer can copy-paste one line and end up with a fresh payload
    # plus updated metadata -- not just the metadata-only `task upgrade` ack.
    recommended_command = "deft-install --yes --upgrade --repo-root . --json"
    msg = (
        f"Framework payload is stale (installed sha {installed_sha[:8]}... "
        f"behind remote {remote_sha[:8]}... for ref '{ref}'). "
        f"Recommendation: run the canonical headless upgrader "
        f"`{recommended_command}` from your project root to pull the latest "
        f"payload (drop `--json` for human-readable output). On an installer "
        f"binary predating the headless flags, download the latest deft-install "
        f"from GitHub Releases first."
    )
    emit_warn(msg)
    add_finding(
        "warning",
        msg,
        check=check_name,
        status="stale",
        installed_sha=installed_sha,
        remote_sha=remote_sha,
        ref=ref,
        suggestion=recommended_command,
    )


def _parse_install_manifest(text: str) -> dict:
    """Tiny tolerant parser for the single-key: 'value' YAML shape used by the
    install manifest (#1062). Mirrors the shape expected by run::_parse_install_manifest
    but kept local here so scripts/doctor.py stays self-contained for the handoff.
    """
    data: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        k, v = [x.strip() for x in line.split(":", 1)]
        v = v.strip().strip("'\"")
        data[k] = v
    return data

def cmd_doctor(args: list[str]):
    """Thin shim (#1335) -- core doctor logic now owned by scripts/doctor.py.

    This entry point (and therefore `task doctor`) is a thin delegation layer.
    The implementation, modes (--session, reporting, --json, --fix, --quiet,
    --full, --project-root), throttle, and checks live in scripts/doctor.py
    (the single owner per Epic-1). During the carve transition the bodies
    remain in this file for stability; scripts/doctor.py is the documented
    import surface and will receive the logic in follow-on increments.

    See scripts/doctor.py header + vbrief/active/*1335*.vbrief.json .
    """

    # Real implementation body follows (transition). After full extraction
    # this will be a 4-line import + call to scripts.doctor.cmd_doctor.
    # The body below is the current home (being migrated).
    """Canonical doctor surface for task-surface health (#1272, #1303 review).

    Diagnoses (and optionally repairs, with explicit consent):

    1. Required tools on PATH (uv, git) and optional tools (task,
       python3, go, node) -- the existing #792 dependency probe.
    2. Expected framework directory layout (#792).
    3. Consumer root Taskfile.yml include health (#1272). When run
       inside a consumer project, doctor detects:
         * missing root Taskfile.yml          -> diagnose + print snippet;
                                                 interactive ``--fix``
                                                 may CREATE the file after
                                                 explicit operator consent.
         * root Taskfile.yml exists, no       -> diagnose + print snippet;
           deft include                          NEVER mutates the existing
                                                 user-owned Taskfile.
         * include present                    -> OK.

    Flags (parsed via :func:`_parse_doctor_flags`):
        ``--session``       diagnose-only, session-safe; no prompt, no
                            mutation.
        ``--fix``           interactive repair offered when actionable
                            (Taskfile creation only); ignored under
                            ``--session``.
        ``--json``          emit a single JSON object on stdout and
                            suppress the human-readable prose; exit
                            code unchanged.
        ``--quiet``         suppress per-check success lines; errors
                            and warnings still surface.
        ``--project-root``  override the project root used for the
                            Taskfile diagnostic. Defaults to
                            :func:`Path.cwd`.

    Returns:
        ``0`` on a clean check OR a warning-only check (warnings are
        informational and never exit-failing).
        ``1`` on a hard error (missing required tool OR Taskfile drift
        detected).
        ``2`` on argument-parse failure (an unknown flag was passed --
        the doctor refuses to run the diagnostics so the typo cannot
        masquerade as a clean check).

    Non-zero return is informational -- doctor's role is to surface
    the failure, not to block the upgrade gate.
    """
    flags = _parse_doctor_flags(args)

    # Reject unknown flags loudly. The previous shape silently swallowed
    # typos (`--repare` instead of `--repair`), so an operator who
    # mistyped never realised they had not opted into repair -- the
    # diagnostic still ran in default mode and the prose suggested the
    # repair was offered. Surface the unknown tokens, list the allowed
    # set, and exit 2 so CI wrappers can distinguish a malformed
    # invocation from a real diagnostic failure (#1303 review #3).
    if flags.get("unknown"):
        error(
            "Unknown flag(s): "
            + ", ".join(flags["unknown"])
        )
        info(
            "Allowed: " + ", ".join(_DOCTOR_ALLOWED_FLAGS)
        )
        return 2

    session_mode = flags["session"]
    fix_mode = flags["fix"] and not session_mode
    json_mode = flags["json"]
    quiet_mode = flags["quiet"]
    full_mode = flags["full"]

    # ``--project-root`` lets operators invoke doctor against an
    # arbitrary directory rather than ``Path.cwd``. Defaults to the
    # current working directory so existing callers (``task doctor``,
    # the ``run doctor`` CLI without overrides) are unaffected. The
    # path is normalised through :func:`resolve_path` so ``~`` and
    # relative paths work (#1303 review #5).
    project_root_arg = flags.get("project_root")
    project_root = (
        resolve_path(project_root_arg) if project_root_arg else Path.cwd()
    )

    # #1308: throttle gate. Default = full check, but a recent run
    # within the 24h-clean / 4h-dirty window short-circuits to a
    # one-line status surface. ``--full`` bypasses the throttle. The
    # ritual halts on a dirty-within-window state (exit 1) so a
    # persistent-dirty install is never silently ignored.
    if not full_mode:
        decision = _evaluate_doctor_throttle(project_root)
        if decision is not None and decision.skip:
            return _emit_doctor_throttle_skip(decision, json_mode=json_mode)

    # Findings are the single source of truth for the summary, the
    # JSON payload, and the exit code (#1303 review #1 / #4). Replaces
    # the prior ``errors += 1`` / ``errors -= 1`` accounting pair that
    # was brittle when the interactive ``--fix`` path repaired a
    # missing-file finding -- the decrement coupled two unrelated
    # branches and made the summary easy to mis-read.
    findings: list[dict] = []

    def _add_finding(severity: str, message: str, **extras: object) -> None:
        entry: dict = {"severity": severity, "message": message}
        entry.update(extras)
        findings.append(entry)

    def _emit_info(msg: str) -> None:
        if not json_mode:
            info(msg)

    def _emit_success(msg: str) -> None:
        if json_mode or quiet_mode:
            return
        success(msg)

    def _emit_warn(msg: str) -> None:
        if not json_mode:
            warn(msg)

    def _emit_error(msg: str) -> None:
        if not json_mode:
            error(msg)

    if not json_mode:
        print_header(f"Deft CLI v{VERSION} - Doctor")
        print()
    _emit_info("Checking system dependencies...")
    if not json_mode:
        print()

    # Check for required tools.  Errors and warnings are tracked
    # separately (#792) so a missing required tool surfaces above
    # optional-tool warnings in the summary and forces a non-zero
    # return code.
    def check_command(cmd: str, name: str, required: bool = False,
                       install_url: str = ""):
        if shutil.which(cmd):
            _emit_success(f"{name} is installed")
            return
        url_hint = f" - install: {install_url}" if install_url else ""
        if required:
            message = f"{name} not found - required{url_hint}"
            _emit_error(message)
            _add_finding(
                "error",
                message,
                check="dependency",
                tool=cmd,
                suggestion=install_url or None,
            )
            return
        if cmd == "task":
            message = f"{name} not found - install from https://taskfile.dev"
        else:
            message = f"{name} not found{url_hint}"
        _emit_warn(message)
        _add_finding(
            "warning",
            message,
            check="dependency",
            tool=cmd,
            suggestion=install_url or None,
        )

    # uv is required: every deft task script invokes `uv run python ...`,
    # so a green doctor on a machine without uv would mask an adoption
    # blocker (#792).  Surface it before optional tools so the error is
    # the first thing a fresh-machine user sees.
    check_command(
        "uv",
        "uv (Astral Python runner)",
        required=True,
        install_url=UV_INSTALL_URL,
    )
    check_command("task", "task (Taskfile)")
    check_command("git", "git", required=True)
    check_command("python3", "python3")
    check_command("go", "go")
    check_command("node", "node")

    # #1308 / #1336: install-integrity checks now owned by scripts/doctor.py
    # (the four checks formerly in framework_doctor.py). cmd_doctor folds
    # them under ``install-integrity:<name>`` keys. Skipped in the deft
    # maintainer repo (no install manifest in the source checkout).
    if not json_mode:
        print()
    _emit_info("Checking install integrity...")
    _run_install_integrity_checks(
        project_root,
        emit_success=_emit_success,
        emit_warn=_emit_warn,
        emit_error=_emit_error,
        emit_info=_emit_info,
        add_finding=_add_finding,
    )

    # #1308: AGENTS.md managed-section freshness. Reuses the
    # cmd_agents_refresh --check byte-compare via _agents_refresh_plan;
    # emits a skip finding with reason "no managed-section markers
    # (likely maintainer repo)" when AGENTS.md carries no v3 markers.
    # Stale templates surface as a warning (zero exit) -- the operator
    # runs `task agents:refresh` to bring them current.
    if not json_mode:
        print()
    _emit_info("Checking AGENTS.md managed-section freshness...")
    _run_agents_md_freshness_check(
        project_root,
        emit_success=_emit_success,
        emit_warn=_emit_warn,
        emit_info=_emit_info,
        add_finding=_add_finding,
    )

    # #1339 (Epic-5): payload staleness from the install manifest. Runs after
    # AGENTS freshness so the handoff from installer always surfaces a clear
    # "re-run the installer" recommendation when the cloned payload sha lags
    # the remote (deterministic, works in --session --json mode for agents).
    if not json_mode:
        print()
    _emit_info("Checking payload staleness from install manifest...")
    _run_payload_staleness_check(
        project_root,
        emit_warn=_emit_warn,
        emit_info=_emit_info,
        add_finding=_add_finding,
    )

    # Check directory structure.  Updated to the v0.20+ canonical
    # layout (#792); pre-v0.20 entries (core, interfaces, tools, swarm,
    # meta) were dropped because they no longer reflect the framework's
    # current top-level layout and produced spurious 'Missing directory'
    # warnings on every clean checkout.  Cross-referenced with
    # `skills/deft-directive-setup/SKILL.md` § Environment Preflight
    # (vbrief lifecycle requirement) and the project tree on master.
    if not json_mode:
        print()
    _emit_info("Checking Deft structure...")

    # Use .parent so the check anchors at the framework root (the directory
    # containing scripts/doctor.py), restoring the pre-extraction semantics
    # from run.get_script_dir() (which returned repo root in source layout).
    # This eliminates the false-positive "Missing directory" warnings for all
    # seven canonical framework subdirectories on every `run doctor` / `task doctor`
    # invocation (Greptile framework-layout issue on 7a0606c).
    framework_root = get_script_dir().parent
    expected_dirs = [
        "languages",
        "strategies",
        "skills",
        "templates",
        "tasks",
        "scripts",
        "vbrief",
    ]

    for dir_name in expected_dirs:
        dir_path = framework_root / dir_name
        if dir_path.is_dir():
            _emit_success(f"Directory: {dir_name}/")
        else:
            message = f"Missing directory: {dir_name}/"
            _emit_warn(message)
            _add_finding(
                "warning",
                message,
                check="framework-layout",
                directory=dir_name,
            )

    # #1272 root Taskfile.yml include health. Skip when invoked from
    # inside the deft framework repo itself -- the deft repo's own
    # Taskfile.yml is the source of truth for its surface and does not
    # need (and must not declare) a `deft:` include to itself.
    if not json_mode:
        print()
    _emit_info("Checking root Taskfile.yml include...")
    if _running_inside_deft_repo(project_root):
        _emit_info(
            "Skipping Taskfile include check -- running inside the deft "
            "framework repo (the repo's own Taskfile.yml is the surface)."
        )
    else:
        # ``include_missing`` is True until a successful interactive
        # repair flips it off. Replaces the prior ``errors -= 1``
        # gymnastic on the missing-file branch (#1303 review #1).
        include_status = _classify_taskfile_include(project_root)
        if include_status == "ok":
            _emit_success("Root Taskfile.yml includes the deft framework")
        elif include_status == "missing-file":
            include_missing = True
            target = project_root / "Taskfile.yml"
            message = (
                "Root Taskfile.yml missing -- the `task X` surface "
                "(task vbrief:preflight / task spec:render / task check) "
                f"will not resolve until you add one. Paste this into {target}:"
            )
            _emit_error(message)
            if not json_mode:
                print()
                print(_TASKFILE_INCLUDE_SNIPPET)
            # Interactive repair path. All gates MUST hold before any
            # write: (1) --fix was requested AND we are not under
            # --session (both folded into ``fix_mode`` -- see
            # ``fix_mode = flags["fix"] and not session_mode`` above);
            # (2) stdin is a TTY (so we can prompt); (3) we are not
            # emitting JSON (JSON mode is diagnose-only). Even then,
            # the operator must explicitly approve at the prompt.
            # #1303 pass-3 review (Greptile run:4664-4669 -- redundant
            # session_mode guard): the prior shape repeated
            # ``and not session_mode`` here, but fix_mode already
            # incorporates that condition; the duplicate gate could
            # never change the outcome and invited confusion.
            if (
                fix_mode
                and not json_mode
                and sys.stdin.isatty()
            ):
                if read_yn(
                    f"Create {target} with the canonical include now?",
                    default=False,
                ):
                    try:
                        # ``newline="\n"`` enforces LF line endings on
                        # every host -- ``write_text`` otherwise honours
                        # the platform default, which produces CRLF on
                        # Windows and breaks the byte-equality contract
                        # tests rely on (#1303 review #6).
                        target.write_text(
                            _TASKFILE_INCLUDE_SNIPPET,
                            encoding="utf-8",
                            newline="\n",
                        )
                        _emit_success(f"Wrote {target}")
                        # The drift was just repaired -- flip the
                        # boolean so the summary reflects the
                        # post-repair state (replaces the prior
                        # ``errors -= 1`` decrement pair).
                        include_missing = False
                    except OSError as exc:
                        _emit_error(f"Failed to write {target}: {exc}")
                else:
                    _emit_info(
                        "Skipped Taskfile.yml creation -- paste the "
                        "snippet above when you are ready."
                    )
            if include_missing:
                _add_finding(
                    "error",
                    "Root Taskfile.yml missing",
                    check="taskfile-include",
                    file=str(target),
                    suggestion=_TASKFILE_INCLUDE_SNIPPET,
                )
        elif include_status == "missing-include":
            message = (
                "Root Taskfile.yml exists but does not include the deft "
                "framework. Add this to its `includes:` block (doctor "
                "NEVER mutates an existing user-owned Taskfile):"
            )
            _emit_error(message)
            if not json_mode:
                print()
                print(_format_missing_include_snippet())
            taskfile_path = _resolve_consumer_taskfile(project_root)
            _add_finding(
                "error",
                "Root Taskfile.yml does not include the deft framework",
                check="taskfile-include",
                file=str(taskfile_path) if taskfile_path else None,
                suggestion=_format_missing_include_snippet(),
            )
        elif include_status == "unreadable":
            # Resolve the actual Taskfile path so a consumer who chose the
            # ``.yaml`` spelling sees the right file name in the error
            # message and in the JSON `file` field (#1303 review,
            # Greptile #2). Falls back to ``Taskfile.yml`` only if the
            # resolver returns None -- which shouldn't happen here
            # because the `unreadable` branch is only reached when a
            # candidate file was found, but the fallback keeps the
            # diagnostic informative under any future code drift.
            taskfile_path = (
                _resolve_consumer_taskfile(project_root)
                or (project_root / "Taskfile.yml")
            )
            message = (
                f"Root Taskfile.yml at {taskfile_path} "
                "exists but could not be read -- check file permissions."
            )
            _emit_warn(message)
            _add_finding(
                "warning",
                message,
                check="taskfile-include",
                file=str(taskfile_path),
            )

    error_count = sum(1 for f in findings if f["severity"] == "error")
    warning_count = sum(1 for f in findings if f["severity"] == "warning")
    exit_code = 1 if error_count else 0

    # #1308: persist doctor-state.json so the next invocation can
    # consult the throttle gate. Best-effort -- a write failure is
    # silently swallowed by the state module so the doctor itself
    # never breaks because of a state-file bug.
    _persist_doctor_state(
        project_root,
        exit_code=exit_code,
        findings=findings,
    )

    if json_mode:
        payload = {
            "status": "completed",
            "ok": exit_code == 0,
            "findings": findings,
            "summary": {
                "errors": error_count,
                "warnings": warning_count,
            },
            "project_root": str(project_root),
        }
        print(json.dumps(payload, sort_keys=True))
        return exit_code

    print()
    if error_count == 0 and warning_count == 0:
        success("System check passed!")
        return 0
    if error_count:
        # Errors first so missing-uv (or git) is not buried under
        # optional-tool warnings.
        error(
            f"System check failed with {error_count} error(s)"
            + (f" and {warning_count} warning(s)" if warning_count else "")
            + "."
        )
        return 1
    warn(f"System check completed with {warning_count} warning(s).")
    return 0

# (end of extracted region; now maintained in this file)
# End of block extracted to scripts/doctor.py (see START marker above).
# The thin shim below this point in the final state will replace the
# extracted region.
# ===
# --- End of extracted doctor logic (Epic-1 #1335) ---

# --- Ported CLI surface (main, _build_parser, _format_text_report) from
# retired framework_doctor.py to satisfy test expectations for fd.main(),
# UTF-8 reconfigure (#814), --json/--quiet/--project-root, and the 3-state
# exit codes. The primary user surface remains cmd_doctor (new extraction).
# ---


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="framework_doctor.py",
        description=(
            "Local install-integrity probe (#1046 PR-B AC-3). Four checks: "
            "QUICK-START resolves, skill paths resolve, manifest agreement, "
            "install-path consistency. Three-state exit: 0 clean / 1 drift "
            "detected / 2 config error."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root path (default: current working directory).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a single JSON object on stdout instead of human-readable text.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the success summary; failure detail still prints.",
    )
    return parser


def _format_text_report(result: DoctorResult) -> str:
    """Render a human-readable summary of the doctor result."""
    lines: list[str] = []
    if result.exit_code == EXIT_CLEAN:
        lines.append(
            "\u2713 deft framework:doctor -- all checks pass "
            f"(install_root={result.install_root!r})."
        )
    elif result.exit_code == EXIT_DRIFT:
        lines.append(
            "\u26a0 deft framework:doctor -- drift detected "
            f"(install_root={result.install_root!r})."
        )
    else:
        lines.append("\u2717 deft framework:doctor -- config error.")
    for c in result.checks:
        if c.status == "pass":
            sym = "\u2713"
        elif c.status == "skip":
            sym = "\u2022"
        elif c.status == "fail":
            sym = "\u2717"
        else:  # error
            sym = "!"
        lines.append(f"  {sym} {c.name}: {c.detail}")
    for err in result.errors:
        lines.append(f"  ! {err}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    # #814: Force UTF-8 stdout/stderr at script entry. Windows Python
    # defaults stdout/stderr to cp1252 when invoked under git hooks,
    # which has no glyph for the U+2713 success marker. Without this
    # reconfigure the doctor crashes with UnicodeEncodeError on the
    # success summary. Guarded by hasattr because reconfigure only
    # exists on TextIOWrapper streams. errors='replace' is a
    # belt-and-suspenders fallback for the rare environment that still
    # cannot render UTF-8.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    result = _run_checks_impl(project_root)
    if args.json:
        print(json.dumps(result.to_dict(), sort_keys=True))
    else:
        if not (args.quiet and result.exit_code == EXIT_CLEAN):
            print(_format_text_report(result))
    return result.exit_code


if __name__ == "__main__":
    # python -m scripts.doctor [args] or direct python scripts/doctor.py [args]
    args = sys.argv[1:]
    if args and args[0].lower() == 'doctor':
        args = args[1:]
    sys.exit(cmd_doctor(args))
