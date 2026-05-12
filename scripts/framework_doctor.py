#!/usr/bin/env python3
"""framework_doctor.py -- local install-integrity probe (#1046 PR-B AC-3).

Pure stdlib, cross-platform. Mirrors :mod:`preflight_branch` (#747) and
:mod:`preflight_gh` (#1019) in shape:

- Three-state exit code: ``0`` clean / ``1`` drift detected / ``2`` config
  error.
- UTF-8 self-reconfigure (#814) at :func:`main` entry so the success-marker
  glyphs render correctly under Windows git hooks.
- ``--json`` mode emits a structured payload for programmatic consumers.
- ``--project-root`` override so tests / cron jobs can probe a sandboxed
  consumer project without ``chdir``.

Four checks:

1. ``quick-start-resolves`` -- the install path AGENTS.md claims (first
   ``Deft is installed in <root>/.`` declaration / ``Full guidelines:
   <root>/main.md`` line) joined with ``QUICK-START.md`` exists on disk.
2. ``skill-paths-resolve`` -- every ``<install>/skills/<name>/SKILL.md``
   referenced in AGENTS.md exists on disk and is not a deprecation-redirect
   stub. (Deprecation stubs carry ``<!-- deft:deprecated-redirect -->`` and
   are treated as "still a fail" because the install needs them resolvable
   for routing.)
3. ``manifest-agreement`` -- if ``<install>/VERSION`` (YAML provenance) AND
   ``<project-root>/.deft-version`` (bare derivative) both exist, the
   manifest's ``tag`` (with leading ``v`` stripped) MUST equal the bare
   file content (whitespace-stripped). On drift, the YAML manifest wins
   per the #1046 PR-B AC-4 fix-shape; the report says so.
4. ``install-path-consistency`` -- the install root AGENTS.md declares
   (first non-comment install-root declaration) MUST resolve to a real
   directory on disk. The cross-check that the YAML manifest is
   co-located at that root is intentionally owned by check #3
   (``manifest-agreement``) -- splitting responsibilities keeps each
   check independently actionable. See ``_check_install_path_consistency``
   for the rationale.

The probe is read-only. It NEVER mutates filesystem state -- ``cmd_upgrade``
remains the single mutation surface for the canonical install manifest.

Wired into:

- ``task framework:doctor`` Taskfile target (`tasks/framework.yml`).
- ``run::_check_upgrade_gate`` -> ``_maybe_run_framework_doctor`` -- the
  gate calls :func:`run_checks` and emits a one-line advisory on drift.
- Future ``run/cmd_gate`` integration (PR-A's Case K classifier will
  consult this surface in a follow-up evolution).

Story: #1046 PR-B AC-3.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

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

# Deprecation-redirect sentinel embedded in stub SKILL.md files (#411).
# A skill path that resolves but is a redirect stub is treated as still
# a fail -- the operator needs to act, not be told everything is fine.
_DEPRECATED_REDIRECT_SENTINEL = "<!-- deft:deprecated-redirect -->"


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
# Helpers
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


# ---------------------------------------------------------------------------
# Checks
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
        if text is not None and _DEPRECATED_REDIRECT_SENTINEL in text:
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
    """Check #3: <install>/VERSION YAML manifest agrees with <root>/.deft-version."""
    if install_root is None:
        return CheckResult(
            name="manifest-agreement",
            status="skip",
            detail="No install root declared in AGENTS.md; cannot locate manifest.",
        )
    manifest_path = project_root / install_root / "VERSION"
    bare_candidates = [
        project_root / "vbrief" / ".deft-version",
        project_root / ".deft-version",
    ]
    bare_path: Path | None = next((p for p in bare_candidates if p.is_file()), None)
    manifest_text = _read_text_safe(manifest_path)
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
                "manifest_path": str(manifest_path),
                "bare_path": str(bare_path) if bare_path else None,
            },
        )
    if manifest_text is None:
        return CheckResult(
            name="manifest-agreement",
            status="fail",
            detail=(
                f"Bare .deft-version exists at {bare_path} but YAML manifest "
                f"is missing at {manifest_path}. Run `task upgrade` to write "
                "the canonical manifest (#1046 PR-B AC-4). See UPGRADING.md "
                "for the v0.27.x -> v0.28 transition walkthrough."
            ),
            data={
                "manifest_path": str(manifest_path),
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
    for manifest_path in (
        project_root / ".deft" / "core" / "VERSION",
        project_root / "deft" / "VERSION",
    ):
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
        fallback_info_note = (
            f" INFO: manifest at {manifest_path} is missing install_root; "
            "fell back to the legacy AGENTS.md install-root parse."
        )
        # source stays "AGENTS.md" -- the manifest was found but did not
        # carry the install_root field, so the effective value still came
        # from the AGENTS.md parse.
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
# Top-level driver
# ---------------------------------------------------------------------------


def run_checks(project_root: Path) -> dict:
    """Run all four checks and return a structured payload.

    Public API consumed by ``run::_maybe_run_framework_doctor``. Returns
    the :class:`DoctorResult` dict shape directly so the gate-side hook
    can introspect ``exit_code`` and ``checks`` without importing the
    dataclass. Best-effort -- any individual check that fails to run
    converts to a ``error`` status and propagates to exit code 2.
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


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


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
            f"\u2713 deft framework:doctor -- all checks pass "
            f"(install_root={result.install_root!r})."
        )
    elif result.exit_code == EXIT_DRIFT:
        lines.append(
            f"\u26a0 deft framework:doctor -- drift detected "
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


__all__ = [
    "CheckResult",
    "DoctorResult",
    "EXIT_CLEAN",
    "EXIT_DRIFT",
    "EXIT_CONFIG_ERROR",
    "main",
    "run_checks",
]


if __name__ == "__main__":
    # Pure path-mod for direct invocation: keeps ``scripts`` importable
    # when this file is dispatched via ``python scripts/framework_doctor.py``.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
