#!/usr/bin/env python3
"""
reconcile_issues.py -- Reconcile GitHub issues against vBRIEF references.

Usage:
    uv run python scripts/reconcile_issues.py [options]

Options:
    --vbrief-dir DIR       Path to vbrief/ directory
    --repo OWNER/REPO      GitHub repo
    --format json|markdown Output format

Reads all vBRIEF files in the lifecycle folders (proposed/, pending/, active/,
completed/, cancelled/) and extracts github-issue references from the
``references`` arrays. Fetches open GitHub issues from the repo using ``gh api``.
Produces a structured report with three sections:

    (a) Open issues with matching vBRIEF provenance (linked)
    (b) Open issues with NO matching vBRIEF (unlinked)
    (c) vBRIEFs with NO matching open issue (potentially resolved)

Exit codes:
    0 -- report generated successfully
    1 -- error (missing dependencies, API failure, etc.)
    2 -- usage error

Story #322, RFC #309.
"""

import json
import re
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
