#!/usr/bin/env python3
"""
issue_ingest.py -- Ingest GitHub issues into vBRIEF lifecycle folders.

Every post-GA issue would otherwise live only on GitHub and reappear in the
``task reconcile:issues`` unlinked section monotonically -- this script lets a
maintainer (or an agent running the refinement skill) materialise an issue as a
scope vBRIEF with origin provenance so the rest of the framework can reason
about it. Single-issue mode fetches one issue number and writes one scope
vBRIEF; bulk mode scans all open issues (optionally filtered by label) and
ingests anything not already referenced by an existing vBRIEF.

Usage:
    uv run python scripts/issue_ingest.py <N> [--status proposed|pending|active]
    uv run python scripts/issue_ingest.py --all [--label LABEL]
                                         [--status STATUS] [--dry-run]
    uv run python scripts/issue_ingest.py [--vbrief-dir DIR] [--repo OWNER/REPO] ...

Exit codes:
    0 -- ingest completed successfully
    1 -- duplicate (single-issue mode; the issue already has a vBRIEF)
    2 -- external error (missing gh, API failure, usage error)

Story: #454 (task issue:ingest).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# Make sibling scripts importable both when run as __main__ and when imported
# by tests that pre-populate sys.path with the ``scripts/`` directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _project_context import resolve_project_repo, resolve_project_root  # noqa: E402
from _stdio_utf8 import reconfigure_stdio  # noqa: E402
from _vbrief_build import EMITTED_VBRIEF_VERSION, TODAY, slugify  # noqa: E402
from reconcile_issues import (  # noqa: E402
    detect_repo,
    fetch_open_issues,
    scan_vbrief_dir,
)

reconfigure_stdio()

# --- Constants --------------------------------------------------------------

# Allowed target lifecycle folders for ingestion. The rest (``completed/``,
# ``cancelled/``) are terminal states; a freshly ingested issue doesn't belong
# there.
INGEST_STATUSES: tuple[str, ...] = ("proposed", "pending", "active")

# Map status keyword -> (folder, plan.status) pair used in the generated
# scope vBRIEF file.
_STATUS_MAP: dict[str, tuple[str, str]] = {
    "proposed": ("proposed", "proposed"),
    "pending": ("pending", "pending"),
    "active": ("active", "running"),
}


# --- Helpers ----------------------------------------------------------------


def _build_issue_vbrief(
    issue: dict, status: str, repo_url: str
) -> tuple[dict, str]:
    """Build a scope vBRIEF dict (and the target lifecycle folder) from a GitHub issue dict.

    ``issue`` is the JSON payload returned by ``gh api repos/.../issues/N`` or
    one element of the ``gh issue list --json number,title,labels,url`` array.

    Emits canonical vBRIEF v0.6 output (#639):
      - ``vBRIEFInfo.version = EMITTED_VBRIEF_VERSION`` (``"0.6"``) -- the
        canonical schema pin (const ``"0.6"`` in
        ``vbrief/schemas/vbrief-core.schema.json``).
      - ``plan.references`` uses the canonical
        ``VBriefReference`` shape ``{uri, type: "x-vbrief/github-issue",
        title: "Issue #{N}: {title}"}`` documented in
        ``conventions/references.md`` (matches ``scripts/_vbrief_build.py::
        create_scope_vbrief``). The legacy bare
        ``{type: "github-issue", id: "#N", url}`` shape is NEVER emitted.
      - When no browser URL can be resolved (neither the issue payload's
        ``url`` nor a non-empty ``repo_url``) the reference is omitted --
        ``VBriefReference`` requires ``uri``, so we cannot honestly emit
        one. The caller still has the issue number in ``plan.narratives["Origin"]``.
    """
    number = int(issue["number"])
    title = str(issue.get("title", f"Issue #{number}")) or f"Issue #{number}"
    url = str(issue.get("url", "")) or (
        f"{repo_url}/issues/{number}" if repo_url else ""
    )
    labels = issue.get("labels", []) or []
    label_names = [
        (lbl.get("name") if isinstance(lbl, dict) else str(lbl))
        for lbl in labels
        if (isinstance(lbl, dict) and lbl.get("name")) or isinstance(lbl, str)
    ]
    folder, plan_status = _STATUS_MAP[status]

    narratives: dict[str, str] = {
        "Description": title,
        "Origin": f"Ingested from {url}" if url else f"Ingested from issue #{number}",
    }
    if label_names:
        narratives["Labels"] = ", ".join(label_names)

    plan: dict = {
        "title": title,
        "status": plan_status,
        "narratives": narratives,
        "items": [],
    }

    # #639: canonical v0.6 VBriefReference shape. Only emit when we have a
    # resolvable URL -- the schema requires ``uri`` and we must not forge
    # one. Matches ``scripts/_vbrief_build.py::create_scope_vbrief`` and
    # ``conventions/references.md``.
    if url:
        plan["references"] = [
            {
                "uri": url,
                "type": "x-vbrief/github-issue",
                "title": f"Issue #{number}: {title}",
            }
        ]

    return {
        "vBRIEFInfo": {
            "version": EMITTED_VBRIEF_VERSION,
            "description": f"Scope vBRIEF ingested from GitHub issue #{number}",
        },
        "plan": plan,
    }, folder


def _target_filename(number: int, title: str) -> str:
    """Build the ``YYYY-MM-DD-<N>-<slug>.vbrief.json`` filename for an issue."""
    slug = slugify(title) or f"issue-{number}"
    return f"{TODAY}-{number}-{slug}.vbrief.json"


def _fetch_single_issue(
    repo: str,
    number: int,
    *,
    cwd: Path | None = None,
) -> dict | None:
    """Fetch a single issue via ``gh api repos/{repo}/issues/{number}``.

    Returns the parsed issue dict on success, ``None`` on error (with the
    reason printed to stderr).
    """
    try:
        result = subprocess.run(
            ["gh", "api", f"repos/{repo}/issues/{number}"],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(cwd) if cwd is not None else None,
        )
    except FileNotFoundError:
        print("Error: gh CLI not found. Install GitHub CLI.", file=sys.stderr)
        return None
    except subprocess.TimeoutExpired:
        print("Error: gh CLI timed out.", file=sys.stderr)
        return None

    if result.returncode != 0:
        print(
            f"Error: gh CLI failed fetching #{number}: {result.stderr.strip()}",
            file=sys.stderr,
        )
        return None
    try:
        issue = json.loads(result.stdout)
    except json.JSONDecodeError:
        print(
            f"Error: failed to parse gh CLI output for #{number}.",
            file=sys.stderr,
        )
        return None
    # gh api uses "html_url"; normalise to "url" for uniformity with fetch_open_issues.
    if "url" not in issue and "html_url" in issue:
        issue["url"] = issue["html_url"]
    return issue


# --- Core actions -----------------------------------------------------------


def ingest_one(
    issue: dict,
    *,
    vbrief_dir: Path,
    status: str,
    repo_url: str,
    dry_run: bool = False,
    existing_refs: dict[int, list[str]] | None = None,
) -> tuple[str, Path | None, str]:
    """Ingest a single issue dict.

    Returns ``(result, path, message)`` where ``result`` is one of ``"created"``,
    ``"dryrun"``, or ``"duplicate"``. ``path`` is the written (or would-be) file
    path; for ``duplicate`` it points at the pre-existing vBRIEF that already
    references this issue.
    """
    number = int(issue["number"])
    refs = existing_refs if existing_refs is not None else scan_vbrief_dir(vbrief_dir)
    if number in refs:
        existing = refs[number][0]
        return "duplicate", vbrief_dir / existing, f"#{number} already ingested at {existing}"

    vbrief, folder = _build_issue_vbrief(issue, status, repo_url)
    filename = _target_filename(number, str(issue.get("title", "")))
    target = vbrief_dir / folder / filename

    if dry_run:
        return "dryrun", target, f"DRY-RUN would write {folder}/{filename}"

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(vbrief, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return "created", target, f"CREATED {folder}/{filename}"


def ingest_bulk(
    issues: list[dict],
    *,
    vbrief_dir: Path,
    status: str,
    repo_url: str,
    label: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Ingest a list of issues.

    Filters by ``label`` first (if provided), then delegates to
    ``ingest_one`` for each remaining issue. Returns a summary dict:
    ``{"created": [...], "duplicate": [...], "dryrun": [...], "total": N}``.
    """
    if label:
        filtered = []
        for issue in issues:
            for lbl in issue.get("labels", []) or []:
                name = lbl.get("name") if isinstance(lbl, dict) else str(lbl)
                if name == label:
                    filtered.append(issue)
                    break
        issues = filtered

    refs = scan_vbrief_dir(vbrief_dir)

    # Values are list[str] for the three bucket keys and int for "total",
    # hence the union annotation.
    summary: dict[str, list[str] | int] = {"created": [], "duplicate": [], "dryrun": []}
    for issue in issues:
        result, path, _msg = ingest_one(
            issue,
            vbrief_dir=vbrief_dir,
            status=status,
            repo_url=repo_url,
            dry_run=dry_run,
            existing_refs=refs,
        )
        summary[result].append(str(path.relative_to(vbrief_dir)) if path else "")
        # After a real write the refs map would now contain this number;
        # update in place so duplicates inside the same batch are detected.
        if result == "created":
            refs.setdefault(int(issue["number"]), []).append(
                str(path.relative_to(vbrief_dir))
            )

    summary["total"] = len(issues)
    return summary


# --- CLI --------------------------------------------------------------------


def _resolve_repo_url(repo: str) -> str:
    """Produce a browser URL from an OWNER/REPO pair (or empty if none)."""
    if not repo:
        return ""
    if repo.startswith(("http://", "https://")):
        return repo.rstrip("/")
    if re.match(r"^[^/]+/[^/]+$", repo):
        return f"https://github.com/{repo}"
    return ""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Ingest GitHub issues as scope vBRIEFs in vbrief/ lifecycle folders.",
    )
    parser.add_argument(
        "number",
        nargs="?",
        type=int,
        help="GitHub issue number to ingest (single-issue mode)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Bulk mode -- ingest all open issues (optionally filtered by --label)",
    )
    parser.add_argument(
        "--label",
        default=None,
        help="Only ingest issues carrying this label (bulk mode)",
    )
    parser.add_argument(
        "--status",
        default="proposed",
        choices=INGEST_STATUSES,
        help="Target lifecycle folder / plan.status (default: proposed)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be written without creating files",
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
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.number is None and not args.all:
        parser.error("Provide an issue number or --all")

    if args.number is not None and args.all:
        parser.error("Use either a single issue number OR --all, not both")

    vbrief_dir = Path(args.vbrief_dir).resolve()
    if not vbrief_dir.exists():
        vbrief_dir.mkdir(parents=True, exist_ok=True)

    project_root = resolve_project_root(args.project_root)
    repo = resolve_project_repo(args.repo, project_root=project_root)
    # Fall back to the legacy CWD-scoped ``detect_repo`` only when no
    # project root could be inferred; that path still exists because
    # some in-process test suites monkeypatch ``detect_repo`` directly.
    if not repo:
        repo = detect_repo()
    if not repo:
        print(
            "Error: could not detect repo. "
            "Pass --repo OWNER/NAME, set $DEFT_PROJECT_REPO, or run from "
            "a directory tree whose git remote origin is the consumer "
            "repo (#538).",
            file=sys.stderr,
        )
        return 2
    repo_url = _resolve_repo_url(repo)

    if args.all:
        issues = fetch_open_issues(repo, cwd=project_root)
        if issues is None:
            return 2
        summary = ingest_bulk(
            issues,
            vbrief_dir=vbrief_dir,
            status=args.status,
            repo_url=repo_url,
            label=args.label,
            dry_run=args.dry_run,
        )
        print(
            "issue:ingest bulk summary: "
            f"{len(summary['created'])} created, "
            f"{len(summary['duplicate'])} duplicate, "
            f"{len(summary['dryrun'])} dry-run "
            f"(total considered: {summary['total']})"
        )
        for entry in summary["created"]:
            print(f"  CREATED {entry}")
        for entry in summary["dryrun"]:
            print(f"  DRY-RUN {entry}")
        for entry in summary["duplicate"]:
            print(f"  SKIP    {entry} (already has scope vBRIEF)")
        return 0

    # Single-issue mode
    issue = _fetch_single_issue(repo, args.number, cwd=project_root)
    if issue is None:
        return 2
    result, path, msg = ingest_one(
        issue,
        vbrief_dir=vbrief_dir,
        status=args.status,
        repo_url=repo_url,
        dry_run=args.dry_run,
    )
    print(msg)
    if result == "duplicate":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
