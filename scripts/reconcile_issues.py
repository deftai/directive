#!/usr/bin/env python3
"""
reconcile_issues.py -- Reconcile GitHub issues against vBRIEF references.

Usage:
    uv run python scripts/reconcile_issues.py [options]

Options:
    --vbrief-dir DIR             Path to vbrief/ directory
    --repo OWNER/REPO            GitHub repo
    --format json|markdown       Output format
    --apply-lifecycle-fixes      Move closed-issue vBRIEFs to completed/
                                 (idempotent; #734)

Reads all vBRIEF files in the lifecycle folders (proposed/, pending/, active/,
completed/, cancelled/) and extracts github-issue references from the
``references`` arrays. Fetches open GitHub issues from the repo using ``gh api``.
Produces a structured report with three sections:

    (a) Open issues with matching vBRIEF provenance (linked)
    (b) Open issues with NO matching vBRIEF (unlinked)
    (c) vBRIEFs with NO matching open issue (potentially resolved)

When ``--apply-lifecycle-fixes`` (#734) is passed, Section (c) entries that
are not already in ``completed/`` are auto-resolved: the vBRIEF JSON gains
``plan.status = "completed"``, ``vBRIEFInfo.updated`` is stamped with the
current UTC ISO timestamp, and the file is ``git mv``\'d (or filesystem-
moved) into ``completed/``. The flag is idempotent: a second run is a
no-op once every closed-issue vBRIEF lives in ``completed/``. Reverse
mismatches (vBRIEF in ``completed/`` whose issue was reopened) are
report-only -- never auto-reverse-moved.

Exit codes:
    0 -- report generated successfully (or apply-mode clean / all moves OK)
    1 -- error (missing dependencies, API failure, partial apply failure)
    2 -- usage / configuration error

Story #322, RFC #309. Apply-mode: #734.
"""

import datetime as _dt
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Make sibling ``_stdio_utf8`` / ``_project_context`` importable when run
# as ``__main__`` and when imported by tests that preload sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _project_context import resolve_project_repo, resolve_project_root  # noqa: E402
from _stdio_utf8 import reconfigure_stdio  # noqa: E402

reconfigure_stdio()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LIFECYCLE_FOLDERS = ("proposed", "pending", "active", "completed", "cancelled")

ISSUE_URL_PATTERN = re.compile(
    r"https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/issues/(?P<number>\d+)"
)
ISSUE_ID_PATTERN = re.compile(r"^#(?P<number>\d+)$")

# Reference-type strings that identify a GitHub issue origin. The migrator
# emits the canonical v0.6 ``x-vbrief/github-issue`` type (#613); legacy
# vBRIEFs produced by earlier migrator runs (or hand-authored pre-v0.20
# fixtures) use the bare ``github-issue`` string. Both shapes are accepted
# here so the reconciler stays idempotent across the transition.
GITHUB_ISSUE_REF_TYPES: frozenset[str] = frozenset(
    {"github-issue", "x-vbrief/github-issue"}
)


# ---------------------------------------------------------------------------
# vBRIEF scanning
# ---------------------------------------------------------------------------


def extract_references_from_vbrief(data: dict) -> list[dict]:
    """Extract all references from a vBRIEF data structure.

    Walks plan.references and each item's references recursively.
    """
    refs: list[dict] = []
    plan = data.get("plan", {})

    # Top-level plan references
    for ref in plan.get("references", []):
        if isinstance(ref, dict):
            refs.append(ref)

    # Item-level references (and nested subItems)
    def _walk_items(items: list) -> None:
        for item in items:
            if not isinstance(item, dict):
                continue
            for ref in item.get("references", []):
                if isinstance(ref, dict):
                    refs.append(ref)
            _walk_items(item.get("subItems", []))
            _walk_items(item.get("items", []))

    _walk_items(plan.get("items", []))
    return refs


def parse_issue_number(ref: dict) -> int | None:
    """Extract a GitHub issue number from a vBRIEF reference dict.

    Accepts both the canonical v0.6 shape ``{uri, type, title}`` (#613) and
    the legacy pre-v0.20 shapes ``{type, url}`` / ``{type, id}`` so mixed-
    shape trees (projects partway through the migrator flip) reconcile
    cleanly. The URL-bearing keys (``uri`` and ``url``) are searched first
    because they disambiguate the owner/repo; ``id`` is the last-resort
    fallback used by the legacy migrator output.
    """
    for key in ("uri", "url"):
        value = ref.get(key, "")
        if isinstance(value, str) and value:
            m = ISSUE_URL_PATTERN.search(value)
            if m:
                return int(m.group("number"))

    ref_id = ref.get("id", "")
    if isinstance(ref_id, str):
        m = ISSUE_ID_PATTERN.match(ref_id)
        if m:
            return int(m.group("number"))
    return None


def scan_vbrief_dir(vbrief_dir: Path) -> dict[int, list[str]]:
    """Scan all lifecycle folders for vBRIEF files and extract issue references.

    Returns:
        Mapping of issue_number -> list of vBRIEF file paths (relative to vbrief_dir).
    """
    issue_to_vbriefs: dict[int, list[str]] = {}

    for folder in LIFECYCLE_FOLDERS:
        folder_path = vbrief_dir / folder
        if not folder_path.is_dir():
            continue
        for vbrief_file in sorted(folder_path.glob("*.vbrief.json")):
            try:
                data = json.loads(vbrief_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            refs = extract_references_from_vbrief(data)
            rel_path = f"{folder}/{vbrief_file.name}"
            for ref in refs:
                # #613: accept both the canonical v0.6 type
                # (``x-vbrief/github-issue``) and the legacy bare
                # ``github-issue`` so scans over partially-migrated
                # trees find every GitHub-issue origin.
                if ref.get("type") not in GITHUB_ISSUE_REF_TYPES:
                    continue
                num = parse_issue_number(ref)
                if num is not None:
                    issue_to_vbriefs.setdefault(num, []).append(rel_path)

    return issue_to_vbriefs


# ---------------------------------------------------------------------------
# GitHub issue fetching
# ---------------------------------------------------------------------------


ISSUE_FETCH_LIMIT = 200


def fetch_open_issues(repo: str, cwd: Path | None = None) -> list[dict] | None:
    """Fetch open issues from GitHub using gh CLI.

    ``cwd`` is passed to ``subprocess.run`` so that ``gh`` resolves its
    auth / config from the consumer project's directory rather than
    whichever directory the included Taskfile happens to be in (#538).
    Explicit ``--repo`` already targets the correct repository; ``cwd``
    is a belt-and-suspenders guard for any future path-sensitive checks.

    Returns a list of dicts with keys: number, title, labels, url.
    Returns None on error (gh not found, timeout, API failure, parse error).
    """
    try:
        result = subprocess.run(
            [
                "gh", "issue", "list",
                "--repo", repo,
                "--state", "open",
                "--limit", str(ISSUE_FETCH_LIMIT),
                "--json", "number,title,labels,url",
            ],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(cwd) if cwd is not None else None,
        )
    except FileNotFoundError:
        print("Error: gh CLI not found. Install GitHub CLI.", file=sys.stderr)
        return None
    except subprocess.TimeoutExpired:
        print("Error: gh CLI timed out.", file=sys.stderr)
        return None

    if result.returncode != 0:
        print(f"Error: gh CLI failed: {result.stderr.strip()}", file=sys.stderr)
        return None

    try:
        issues: list[dict] = json.loads(result.stdout)
    except json.JSONDecodeError:
        print("Error: failed to parse gh CLI output.", file=sys.stderr)
        return None

    if len(issues) >= ISSUE_FETCH_LIMIT:
        print(
            f"Warning: fetched {len(issues)} issues (limit {ISSUE_FETCH_LIMIT}). "
            "Report may be incomplete.",
            file=sys.stderr,
        )

    return issues


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------


def reconcile(
    issue_to_vbriefs: dict[int, list[str]],
    open_issues: list[dict],
) -> dict:
    """Produce a reconciliation report.

    Returns a dict with three sections:
        linked: open issues with matching vBRIEF provenance
        unlinked: open issues with no matching vBRIEF
        no_open_issue: vBRIEF references with no matching open issue
    """
    open_issue_numbers = {i["number"] for i in open_issues}

    linked = []
    unlinked = []
    no_open_issue = []

    # Classify open issues
    for issue in sorted(open_issues, key=lambda i: i["number"]):
        num = issue["number"]
        if num in issue_to_vbriefs:
            linked.append({
                "issue_number": num,
                "title": issue.get("title", ""),
                "url": issue.get("url", ""),
                "vbrief_files": issue_to_vbriefs[num],
            })
        else:
            unlinked.append({
                "issue_number": num,
                "title": issue.get("title", ""),
                "url": issue.get("url", ""),
            })

    # vBRIEF references with no open issue
    for num, vbrief_files in sorted(issue_to_vbriefs.items()):
        if num not in open_issue_numbers:
            no_open_issue.append({
                "issue_number": num,
                "vbrief_files": vbrief_files,
                "note": "Issue is closed or does not exist",
            })

    return {
        "linked": linked,
        "unlinked": unlinked,
        "no_open_issue": no_open_issue,
        "summary": {
            "total_open_issues": len(open_issues),
            "linked_count": len(linked),
            "unlinked_count": len(unlinked),
            "vbriefs_no_open_issue_count": len(no_open_issue),
        },
    }


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def format_json(report: dict) -> str:
    """Format report as JSON."""
    return json.dumps(report, indent=2, ensure_ascii=False)


def format_markdown(report: dict) -> str:
    """Format report as Markdown."""
    lines: list[str] = []
    summary = report["summary"]

    lines.append("# Issue Reconciliation Report")
    lines.append("")
    lines.append(f"- **Open issues**: {summary['total_open_issues']}")
    lines.append(f"- **Linked** (vBRIEF provenance): {summary['linked_count']}")
    lines.append(f"- **Unlinked** (no vBRIEF): {summary['unlinked_count']}")
    lines.append(
        f"- **vBRIEFs without open issue**: {summary['vbriefs_no_open_issue_count']}"
    )
    lines.append("")

    # Section A: Linked
    lines.append("## (a) Open issues with matching vBRIEF provenance")
    lines.append("")
    if report["linked"]:
        for entry in report["linked"]:
            files = ", ".join(f"`{f}`" for f in entry["vbrief_files"])
            lines.append(f"- #{entry['issue_number']} {entry['title']} -- {files}")
    else:
        lines.append("None.")
    lines.append("")

    # Section B: Unlinked
    lines.append("## (b) Open issues with NO matching vBRIEF (unlinked)")
    lines.append("")
    if report["unlinked"]:
        for entry in report["unlinked"]:
            lines.append(f"- #{entry['issue_number']} {entry['title']}")
    else:
        lines.append("None.")
    lines.append("")

    # Section C: No open issue
    lines.append("## (c) vBRIEFs with NO matching open issue (potentially resolved)")
    lines.append("")
    if report["no_open_issue"]:
        for entry in report["no_open_issue"]:
            files = ", ".join(f"`{f}`" for f in entry["vbrief_files"])
            lines.append(
                f"- #{entry['issue_number']} -- {files} ({entry['note']})"
            )
    else:
        lines.append("None.")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Apply-mode helpers (#734 -- --apply-lifecycle-fixes)
# ---------------------------------------------------------------------------


def _utc_now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string with ``Z`` suffix.

    The shape matches the existing migrator / refinement-skill stamp format
    (``2026-04-29T22:48:22Z``). Seconds-precision is sufficient -- the
    field is human-auditable, not a high-resolution timestamp.
    """
    return _dt.datetime.now(_dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _git_mv(src: Path, dst: Path, *, cwd: Path | None = None) -> bool:
    """Move ``src`` -> ``dst`` using ``git mv`` when possible.

    Falls back to ``shutil.move`` when ``git`` is not on PATH or the
    project is not a git repo (e.g. a synthetic test fixture). Returns
    True on success. Raises no exception -- the caller maps a False
    return to a per-file failure for the apply-mode summary.
    """
    if shutil.which("git") is None:
        try:
            shutil.move(str(src), str(dst))
            return True
        except OSError:
            return False
    try:
        result = subprocess.run(
            ["git", "mv", str(src), str(dst)],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(cwd) if cwd is not None else None,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        try:
            shutil.move(str(src), str(dst))
            return True
        except OSError:
            return False
    if result.returncode != 0:
        # Fall back to filesystem move (synthetic fixtures / non-git
        # trees). This keeps the apply-mode robust against partial
        # repo layouts while still preferring git semantics when
        # available.
        try:
            shutil.move(str(src), str(dst))
            return True
        except OSError:
            return False
    return True


def apply_lifecycle_fixes(
    vbrief_dir: Path,
    report: dict,
    *,
    project_root: Path | None = None,
) -> tuple[int, int, list[str]]:
    """Move Section (c) entries to ``completed/`` and stamp status / updated.

    Iterates ``report['no_open_issue']`` and for each vBRIEF file path
    that is NOT already in ``completed/``:

    1. Read the JSON.
    2. Set ``plan.status = "completed"``.
    3. Stamp ``vBRIEFInfo.updated`` with the current UTC ISO timestamp.
    4. Write the file back (UTF-8, no BOM, trailing newline).
    5. ``git mv`` (or filesystem-move) the file into ``completed/``.

    The function is intentionally idempotent: a second call with a
    fresh report (where every entry already lives in ``completed/``)
    is a no-op. Reverse mismatches (vBRIEFs already in ``completed/``
    whose issue was reopened) are skipped silently here -- they are
    surfaced in the report's Section (a) / (c) split, but auto-reverse
    is intentionally NOT performed (operator decision per #734).

    Returns ``(moved, skipped, failures)`` where ``failures`` is a list
    of human-readable failure descriptions (empty on the happy path).
    """
    moved = 0
    skipped = 0
    failures: list[str] = []
    cwd = project_root if project_root is not None else vbrief_dir.parent

    for entry in report.get("no_open_issue", []):
        for rel_path in entry.get("vbrief_files", []):
            try:
                folder, filename = rel_path.split("/", 1)
            except ValueError:
                failures.append(
                    f"unexpected vBRIEF path shape (no folder): {rel_path!r}"
                )
                continue
            if folder == "completed":
                # Already terminal; no-op.
                skipped += 1
                continue

            src = vbrief_dir / folder / filename
            dst = vbrief_dir / "completed" / filename
            if not src.is_file():
                failures.append(f"vBRIEF file missing: {rel_path}")
                continue

            try:
                data = json.loads(src.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                failures.append(f"failed to parse {rel_path}: {exc}")
                continue

            # Stamp status + updated.
            plan = data.setdefault("plan", {})
            plan["status"] = "completed"
            stamp = _utc_now_iso()
            info = data.setdefault("vBRIEFInfo", {})
            info["updated"] = stamp
            # Mirror the migrator pattern: also stamp ``plan.updated`` so
            # downstream tooling that prefers the plan-level field stays
            # current. Pre-existing files without the key gain it.
            plan["updated"] = stamp

            # Write back (UTF-8, no BOM, trailing newline; matches the
            # canonical writer style elsewhere in the script).
            try:
                src.write_text(
                    json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8",
                )
            except OSError as exc:
                failures.append(f"failed to write {rel_path}: {exc}")
                continue

            # Ensure target folder exists; then git mv.
            (vbrief_dir / "completed").mkdir(parents=True, exist_ok=True)
            if dst.exists():
                # Conflict: a file with the same name already lives in
                # completed/. Surface as a failure so the operator can
                # disambiguate manually.
                failures.append(
                    f"target already exists in completed/: {filename}"
                )
                continue
            if not _git_mv(src, dst, cwd=cwd):
                failures.append(f"failed to move {rel_path} -> completed/")
                continue
            moved += 1

    return moved, skipped, failures


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Reconcile GitHub issues against vBRIEF references."
    )
    parser.add_argument(
        "--vbrief-dir",
        default="./vbrief",
        help="Path to vbrief/ directory (default: ./vbrief)",
    )
    parser.add_argument(
        "--repo",
        default=None,
        help=(
            "GitHub repo in OWNER/REPO format. Highest precedence; beats "
            "$DEFT_PROJECT_REPO and git-remote detection. Without a flag, "
            "env var, or git remote in the project root the script FAILS "
            "loudly rather than silently falling back to deft's own remote "
            "(#538)."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=None,
        help=(
            "Consumer project root. Used as CWD for git-remote detection "
            "so ``gh`` / ``git`` queries target the consumer repo, not "
            "deftai/directive (#538)."
        ),
    )
    parser.add_argument(
        "--format",
        choices=["json", "markdown"],
        default="markdown",
        help="Output format (default: markdown)",
    )
    parser.add_argument(
        "--apply-lifecycle-fixes",
        action="store_true",
        default=False,
        help=(
            "Apply Section (c) fixes: move closed-issue vBRIEFs to "
            "completed/, stamp plan.status=completed and "
            "vBRIEFInfo.updated. Idempotent on re-run. Reverse "
            "mismatches (completed/ vBRIEF + reopened issue) are "
            "report-only -- never auto-reverse-moved. (#734)"
        ),
    )

    args = parser.parse_args()
    vbrief_dir = Path(args.vbrief_dir).resolve()

    if not vbrief_dir.is_dir():
        print(f"Error: vbrief directory not found: {vbrief_dir}", file=sys.stderr)
        return 1

    # Resolve repo using the shared precedence: --repo > $DEFT_PROJECT_REPO >
    # git-remote in the (resolved) project root > legacy CWD-scoped
    # ``detect_repo()`` fallback. Never silently fall through to deft's own
    # origin (#538).
    project_root = resolve_project_root(args.project_root)
    repo = resolve_project_repo(args.repo, project_root=project_root)
    if repo is None:
        repo = detect_repo()
    if repo is None:
        print(
            "Error: could not detect repo. "
            "Pass --repo OWNER/NAME, set $DEFT_PROJECT_REPO, or run from "
            "a directory tree whose git remote origin is the consumer "
            "repo (#538).",
            file=sys.stderr,
        )
        # Exit 2 for this usage-style error keeps reconcile:issues
        # consistent with issue_ingest.py and scope_lifecycle.py, so
        # CI scripts/shell conditionals can treat "no repo detected"
        # as a single exit-code bucket (Greptile P2 on #562).
        return 2

    # Scan vBRIEFs
    issue_to_vbriefs = scan_vbrief_dir(vbrief_dir)

    # Fetch open issues -- run gh from the resolved project root so auth
    # context + any future path-sensitive checks target the consumer
    # repo, not deft's own tree (#538).
    open_issues = fetch_open_issues(repo, cwd=project_root)
    if open_issues is None:
        return 1

    # Reconcile
    report = reconcile(issue_to_vbriefs, open_issues)

    # Output
    if args.format == "json":
        print(format_json(report))
    else:
        print(format_markdown(report))

    # #734: apply mode -- move Section (c) vBRIEFs to completed/.
    if args.apply_lifecycle_fixes:
        candidates = sum(
            1
            for entry in report.get("no_open_issue", [])
            for rel in entry.get("vbrief_files", [])
            if not rel.startswith("completed/")
        )
        moved, skipped, failures = apply_lifecycle_fixes(
            vbrief_dir, report, project_root=project_root
        )
        total = moved + skipped + len(failures)
        print(
            f"[{moved}/{candidates}] vBRIEFs reconciled "
            f"(moved={moved}, already-completed={skipped}, "
            f"failures={len(failures)})",
            file=sys.stderr,
        )
        for f in failures:
            print(f"  -- FAIL: {f}", file=sys.stderr)
        if failures:
            return 1
        # Suppress unused-name warning for ``total``; kept for log clarity.
        del total

    return 0


def detect_repo() -> str | None:
    """Auto-detect OWNER/REPO from git remote origin.

    Legacy fallback kept for backwards compatibility with in-process tests
    that monkeypatch this symbol directly; the primary repo-resolution
    path goes through ``_project_context.resolve_project_repo``. Uses the
    same ``.git``-suffix-aware regex as ``_normalise_repo_slug`` so a
    dotted repo name (``acme/my.project``) isn't silently truncated to
    ``acme/my`` when this fallback IS reached (Greptile P2 on #562).
    """
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None

    if result.returncode != 0:
        return None

    url = result.stdout.strip()
    # Mirrors ``_normalise_repo_slug`` -- the legacy fallback used to
    # share its bug (``[^/.]+`` truncates dotted names).
    m = re.search(
        r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?(?:\s|$)",
        url,
    )
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    return None


if __name__ == "__main__":
    raise SystemExit(main())
