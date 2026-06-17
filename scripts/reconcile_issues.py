#!/usr/bin/env python3
"""
reconcile_issues.py -- Reconcile GitHub issues against vBRIEF references.

Usage:
    uv run python scripts/reconcile_issues.py [options]

Options:
    --vbrief-dir DIR             Path to vbrief/ directory
    --repo OWNER/REPO            GitHub repo
    --format json|markdown       Output format
    --apply-lifecycle-fixes      Move non-terminal closed-issue vBRIEFs
                                 to completed/ (idempotent; #734)
    --report-unlinked            Emit the legacy three-section report
                                 including issues with no vBRIEF (#754)
    --max-open-issues N          Safety cap for --report-unlinked path
                                 (default 1000) (#754)

Reads all vBRIEF files in the lifecycle folders (proposed/, pending/, active/,
completed/, cancelled/) and extracts github-issue references from the
``references`` arrays.

Default path (#754): produces a two-section report via inverted lookup --
the scanner extracts the set of issue numbers referenced by vBRIEFs and
queries just those issues' states via batched ``gh api graphql`` (aliased
node queries). Cost scales by O(vBRIEF-referenced-issue-count), bounded
by the repo's vBRIEF count rather than total open-issue count. Sections:

    (a) linked        -- referenced issues with state ``OPEN``
    (c) no_open_issue -- referenced issues with state ``CLOSED`` /
                         ``NOT_FOUND`` (the apply-mode candidates)

The legacy section (b) ``unlinked`` (open issues with NO matching vBRIEF)
is NOT emitted in the default path because it requires fetching every
open issue in the repo -- which scales by O(repo-open-issue-count) and
caused #754's false-positive flood on a 225-open-issue repo (the prior
200-issue cap silently treated the tail as closed). The legacy three-
section report is available via ``--report-unlinked`` with a
``--max-open-issues`` safety cap.

When ``--apply-lifecycle-fixes`` (#734) is passed, Section (c) entries that
are not already in a terminal lifecycle folder (``completed/`` or
``cancelled/``) are auto-resolved: the vBRIEF JSON gains
``plan.status = "completed"``, ``vBRIEFInfo.updated`` is stamped with the
current UTC ISO timestamp, and the file is ``git mv``\'d (or filesystem-
moved) into ``completed/``. The flag is idempotent: a second run is a
no-op once every closed-issue vBRIEF lives in a terminal lifecycle folder.
Reverse mismatches (terminal vBRIEF whose issue was reopened) are
report-only -- never auto-reverse-moved.

Exit codes:
    0 -- report generated successfully (or apply-mode clean / all moves OK)
    1 -- error (missing dependencies, API failure, partial apply failure,
         --report-unlinked over the --max-open-issues cap)
    2 -- usage / configuration error

Story #322, RFC #309. Apply-mode: #734. Inverted-lookup scaling: #754.
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
TERMINAL_LIFECYCLE_FOLDERS: frozenset[str] = frozenset(
    {"completed", "cancelled"}
)

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

# #1290: GitHub ``stateReason`` values that route a CLOSED issue's vBRIEF
# to ``cancelled/`` rather than ``completed/``. ``COMPLETED`` (and a null
# reason / ``NOT_FOUND``) route to ``completed/`` -- the pre-#1290 default.
CANCELLED_STATE_REASONS: frozenset[str] = frozenset({"NOT_PLANNED", "DUPLICATE"})


class IssueState(str):
    """A ``str`` subclass carrying a GitHub issue's state plus stateReason.

    Phase A of #1290 extends ``fetch_issue_states`` to also fetch each
    issue's ``stateReason`` so apply-mode can route CLOSED+NOT_PLANNED /
    CLOSED+DUPLICATE to ``cancelled/`` while CLOSED+COMPLETED stays in
    ``completed/``. To avoid breaking the many existing callers (and
    tests) that compare the return value directly to the bare strings
    ``"OPEN"`` / ``"CLOSED"`` / ``"NOT_FOUND"`` -- including
    ``scripts/release.py::check_vbrief_lifecycle_sync`` -- the value is a
    ``str`` subclass: it still ``==`` the bare state string, so legacy
    code keeps working unchanged, while new code reads ``.state_reason``.
    """

    state_reason: str | None

    def __new__(cls, state: str, state_reason: str | None = None) -> "IssueState":
        obj = super().__new__(cls, state)
        obj.state_reason = state_reason
        return obj


def state_reason_of(value: object) -> str | None:
    """Return the ``stateReason`` carried by a state-map value, or None.

    Thin accessor so callers that hold a state-map value (which may be a
    plain ``str`` from a legacy/monkeypatched fetch or an ``IssueState``
    from the real fetch) can read the reason without an ``isinstance``
    dance. Returns ``None`` for plain strings / missing values (#1290).
    """
    return getattr(value, "state_reason", None)


def is_terminal_lifecycle_path(rel_path: str) -> bool:
    """Return True when a vBRIEF relative path is already terminal."""
    folder, sep, _filename = rel_path.partition("/")
    return sep == "/" and folder in TERMINAL_LIFECYCLE_FOLDERS


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

    # Item-level references (and nested subItems). Every container access
    # uses ``... or []`` rather than ``.get(key, [])``: a key present with an
    # explicit JSON ``null`` value returns ``None`` from ``.get(key, [])``
    # (the default only fires for ABSENT keys), and ``for x in None`` raises
    # ``TypeError`` (#924).
    def _walk_items(items: list | None) -> None:
        for item in items or []:
            if not isinstance(item, dict):
                continue
            for ref in item.get("references") or []:
                if isinstance(ref, dict):
                    refs.append(ref)
            _walk_items(item.get("subItems") or [])
            _walk_items(item.get("items") or [])

    _walk_items(plan.get("items") or [])
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


ISSUE_FETCH_LIMIT = 1000

# #754: GraphQL aliased-node batch size for ``fetch_issue_states``. GitHub's
# GraphQL ceiling is ~500 nodes per query; 200 keeps each query well under
# the limit and bounds query body size for repos with very large vBRIEF
# counts.
GRAPHQL_BATCH_SIZE = 200

# #754: paginated all-open-issues fetch limit for the ``--report-unlinked``
# opt-in path. ``gh issue list --limit 0`` fetches every open issue via
# native pagination (no per_page cap). Default operator-facing safety cap
# is 1000 -- raised via ``--max-open-issues N`` when the operator has
# acknowledged the cost.
DEFAULT_MAX_OPEN_ISSUES = 1000


def fetch_open_issues(repo: str, cwd: Path | None = None) -> list[dict] | None:
    """Fetch open issues from GitHub using gh CLI.

    Retained for the opt-in ``--report-unlinked`` path; the release-pipeline
    gate uses ``fetch_issue_states`` for inverted-lookup scaling (#754).

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


def fetch_all_open_issues(
    repo: str, cwd: Path | None = None
) -> list[dict] | None:
    """Fetch ALL open issues from GitHub using gh CLI native pagination (#754).

    Used by the ``--report-unlinked`` opt-in path. Invokes
    ``gh issue list --limit 0`` which paginates internally and returns
    every open issue regardless of count. The caller is responsible for
    enforcing ``--max-open-issues`` after this returns.

    Returns a list of dicts with keys: number, title, labels, url.
    Returns None on error (gh not found, timeout, API failure, parse error).
    """
    try:
        result = subprocess.run(
            [
                "gh", "issue", "list",
                "--repo", repo,
                "--state", "open",
                # ``--limit 0`` opts into gh's native unlimited pagination.
                "--limit", "0",
                "--json", "number,title,labels,url",
            ],
            capture_output=True,
            text=True,
            # 5 min ceiling -- a properly-paginated fetch on a 10k-open
            # repo completes inside this budget; anything beyond is a
            # real auth / network failure to surface cleanly.
            timeout=300,
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

    return issues


def _split_repo_slug(repo: str) -> tuple[str, str] | None:
    """Split ``OWNER/REPO`` into ``(owner, repo)``; None on malformed input."""
    parts = repo.split("/", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    return parts[0], parts[1]


def fetch_issue_states(
    repo: str,
    issue_numbers: set[int],
    cwd: Path | None = None,
    *,
    batch_size: int = GRAPHQL_BATCH_SIZE,
) -> dict[int, IssueState] | None:
    """Fetch GitHub issue states via batched ``gh api graphql`` (#754).

    Inverts the lookup direction relative to ``fetch_open_issues``:
    instead of fetching every open issue in the repo and filtering for
    the vBRIEF-referenced subset, this helper takes the subset directly
    (``issue_numbers``) and queries the state of just those issues. The
    cost therefore scales by ``O(len(issue_numbers))`` -- the
    vBRIEF-referenced-issue-count -- rather than
    ``O(repo-open-issue-count)``.

    Implementation: builds a GraphQL query with aliased nodes
    (``i100: issue(number: 100) { state }``), batched at ``batch_size``
    nodes per query (default 200; safe under GitHub's ~500 ceiling). One
    ``gh api graphql`` invocation per batch. Issues that don't exist in
    the repo are returned as ``"NOT_FOUND"`` (the corresponding aliased
    node is null in the GraphQL response).

    ``cwd`` is forwarded to ``subprocess.run`` so ``gh`` resolves its
    auth / config from the consumer project's directory (#538
    belt-and-suspenders).

    Returns a dict mapping issue_number -> ``IssueState`` (a ``str``
    subclass equal to ``"OPEN"`` / ``"CLOSED"`` / ``"NOT_FOUND"`` that
    additionally carries the GitHub ``stateReason`` via
    ``.state_reason``) when every batch resolved cleanly, ``None`` on
    subprocess error, parse error, or non-zero exit (mirrors
    ``fetch_open_issues``). An empty ``issue_numbers`` set returns an
    empty dict (no subprocess call). #1290 added the ``stateReason``
    selection so apply-mode can route NOT_PLANNED / DUPLICATE closures
    to ``cancelled/``; the ``str`` subclass keeps every existing caller
    (and the bare-string equality tests) working unchanged.

    Refs #754 (inverted-lookup gate fix), #1290 (stateReason); see also
    ``reconcile()`` and ``scripts/release.py::check_vbrief_lifecycle_sync``.
    """
    if not issue_numbers:
        return {}
    parsed = _split_repo_slug(repo)
    if parsed is None:
        print(
            f"Error: invalid repo slug {repo!r}; expected OWNER/REPO.",
            file=sys.stderr,
        )
        return None
    owner, name = parsed

    sorted_numbers = sorted(issue_numbers)
    states: dict[int, IssueState] = {}

    for start in range(0, len(sorted_numbers), batch_size):
        batch = sorted_numbers[start : start + batch_size]
        # Aliased-node block: each issue gets a unique alias (``i<N>``)
        # so the GraphQL response carries every state in a single query.
        # #1290: also select ``stateReason`` so apply-mode can route
        # NOT_PLANNED / DUPLICATE closures to ``cancelled/``.
        aliases = "\n    ".join(
            f"i{n}: issue(number: {n}) {{ state stateReason }}" for n in batch
        )
        query = (
            "query {\n"
            f'  repository(owner: "{owner}", name: "{name}") {{\n'
            f"    {aliases}\n"
            "  }\n"
            "}\n"
        )
        try:
            result = subprocess.run(
                ["gh", "api", "graphql", "-f", f"query={query}"],
                capture_output=True,
                text=True,
                timeout=60,
                cwd=str(cwd) if cwd is not None else None,
            )
        except FileNotFoundError:
            print(
                "Error: gh CLI not found. Install GitHub CLI.",
                file=sys.stderr,
            )
            return None
        except subprocess.TimeoutExpired:
            print("Error: gh CLI timed out.", file=sys.stderr)
            return None

        # Tolerate partial GraphQL errors: when an issue number actually
        # references a PR (or a deleted/transferred record) GitHub emits a
        # top-level ``errors[*]`` entry AND gh exits non-zero, but the
        # response ``data`` field is still populated (just with ``null``
        # for the offending alias). Treat that as a soft failure so the
        # caller can classify the missing aliases as NOT_FOUND. A truly
        # fatal error (auth, network, malformed query) leaves ``stdout``
        # empty / non-JSON and is still surfaced as ``None``.
        try:
            payload = json.loads(result.stdout) if result.stdout else None
        except json.JSONDecodeError:
            payload = None

        if result.returncode != 0:
            if payload is None or not isinstance(payload.get("data"), dict):
                print(
                    f"Error: gh CLI failed: {result.stderr.strip()}",
                    file=sys.stderr,
                )
                return None
            # Soft-failure path: surface the GraphQL errors as a single
            # warning line so operators see the partial-resolve trace,
            # then continue with whatever ``data`` came back.
            print(
                "Warning: gh GraphQL returned partial errors (likely PR "
                "numbers referenced as issues): "
                f"{result.stderr.strip().splitlines()[0] if result.stderr else ''}",
                file=sys.stderr,
            )

        if payload is None:
            print(
                "Error: failed to parse gh CLI graphql output.",
                file=sys.stderr,
            )
            return None

        repo_data = (payload.get("data") or {}).get("repository")
        if not isinstance(repo_data, dict):
            print(
                "Error: gh CLI graphql response missing repository payload.",
                file=sys.stderr,
            )
            return None

        for n in batch:
            node = repo_data.get(f"i{n}")
            if isinstance(node, dict) and isinstance(node.get("state"), str):
                reason = node.get("stateReason")
                states[n] = IssueState(
                    node["state"],
                    reason if isinstance(reason, str) else None,
                )
            else:
                # GraphQL returns null for non-existent issues; map to a
                # sentinel the caller can detect.
                states[n] = IssueState("NOT_FOUND", None)

    return states


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------


def reconcile(
    issue_to_vbriefs: dict[int, list[str]],
    issue_state_map: dict[int, str],
) -> dict:
    """Inverted-lookup reconciliation report (default path; #754).

    Classifies vBRIEF-referenced issues using the state map produced by
    ``fetch_issue_states``. Cost scales by
    ``O(len(issue_to_vbriefs))`` -- bounded by the repo's vBRIEF count
    rather than total open-issue count.

    Returns a dict with two sections:
        linked        -- referenced issues whose state is ``OPEN``
        no_open_issue -- referenced issues whose state is ``CLOSED`` /
                         ``NOT_FOUND`` / unknown (treated as the
                         apply-mode candidates)

    The legacy ``unlinked`` bucket (open issues with NO matching vBRIEF)
    is intentionally absent: it requires fetching every open issue in
    the repo, which is the failure mode #754 retired. The legacy
    three-section report is available via ``reconcile_with_unlinked``
    (surfaced through the ``--report-unlinked`` CLI flag).
    """
    linked: list[dict] = []
    no_open_issue: list[dict] = []

    for num in sorted(issue_to_vbriefs):
        state = issue_state_map.get(num, "NOT_FOUND")
        vbrief_files = issue_to_vbriefs[num]
        if state == "OPEN":
            linked.append({
                "issue_number": num,
                "vbrief_files": vbrief_files,
            })
        else:
            note = (
                "Issue is closed"
                if state == "CLOSED"
                else "Issue is closed or does not exist"
            )
            # #1290: surface state + stateReason so apply-mode can route
            # CLOSED+NOT_PLANNED / CLOSED+DUPLICATE to cancelled/.
            no_open_issue.append({
                "issue_number": num,
                "vbrief_files": vbrief_files,
                "note": note,
                "state": str(state),
                "state_reason": state_reason_of(state),
            })

    return {
        "linked": linked,
        "no_open_issue": no_open_issue,
        "summary": {
            "linked_count": len(linked),
            "vbriefs_no_open_issue_count": len(no_open_issue),
        },
    }


def reconcile_with_unlinked(
    issue_to_vbriefs: dict[int, list[str]],
    open_issues: list[dict],
) -> dict:
    """Legacy three-section reconciliation including the ``unlinked`` bucket.

    Surfaced via the ``--report-unlinked`` opt-in CLI flag (#754); the
    release-pipeline gate uses the inverted-lookup ``reconcile`` instead.

    Returns a dict with three sections:
        linked        -- open issues with matching vBRIEF provenance
        unlinked      -- open issues with NO matching vBRIEF
        no_open_issue -- vBRIEF references with no matching open issue
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
# Lifecycle anchor resolution (#1290 Phase B -- Axis B primary-reference filter)
# ---------------------------------------------------------------------------


def _parse_issue_ref_string(raw: object) -> int | None:
    """Parse a bare ``#N`` id or a full issue URL into an issue number.

    Shared by ``parse_plan_ref``, ``parse_parent_issue`` and
    ``parse_decomposition_origin`` (#1290 / #1319). Returns ``None`` for
    non-strings, empty strings, or strings that match neither shape.
    """
    if not isinstance(raw, str):
        return None
    candidate = raw.strip()
    m = ISSUE_ID_PATTERN.match(candidate)
    if m:
        return int(m.group("number"))
    m = ISSUE_URL_PATTERN.search(candidate)
    if m:
        return int(m.group("number"))
    return None


def _x_tracking(data: dict) -> dict:
    """Return the ``metadata.x-tracking`` dict for a vBRIEF, or ``{}`` (#1319).

    Decomposition children carry their tracking provenance under
    ``plan.metadata.x-tracking`` (the observed shape); a top-level
    ``metadata.x-tracking`` is also tolerated for robustness. Always
    returns a dict so callers can ``.get(...)`` without guards.
    """
    for container in (data.get("plan"), data):
        if not isinstance(container, dict):
            continue
        meta = container.get("metadata")
        if not isinstance(meta, dict):
            continue
        xt = meta.get("x-tracking")
        if isinstance(xt, dict):
            return xt
    return {}


def parse_plan_ref(data: dict) -> int | None:
    """Extract the canonical issue number from ``plan.planRef`` (#1290).

    ``planRef`` is the vBRIEF's own primary issue (e.g. ``"#1290"``). It
    is the canonical lifecycle anchor: a vBRIEF that merely *references*
    an unrelated closed umbrella in ``plan.references[]`` must NOT be
    dragged into that umbrella's terminal state. Accepts both the bare
    ``#N`` shape and a full issue URL. Returns ``None`` when the field is
    absent or unparseable, so callers can fall back to ``references[]``.
    """
    plan = data.get("plan", {})
    if not isinstance(plan, dict):
        return None
    return _parse_issue_ref_string(plan.get("planRef"))


def parse_parent_issue(data: dict) -> int | None:
    """Extract the vBRIEF's own issue from ``x-tracking.parent_issue`` (#1319).

    Decomposition children (carved from an umbrella via the decompose
    skill) record their OWN primary issue under
    ``metadata.x-tracking.parent_issue`` even when ``plan.planRef`` is
    absent. This is the canonical lifecycle anchor for those children:
    it is the issue whose closure means the child's work is done, NOT
    the umbrella it was carved from. Returns ``None`` when absent or
    unparseable.
    """
    return _parse_issue_ref_string(_x_tracking(data).get("parent_issue"))


def parse_decomposition_origin(data: dict) -> int | None:
    """Extract the umbrella issue from ``x-tracking.decomposition_origin`` (#1319).

    ``decomposition_origin`` is the (often closed) umbrella issue a child
    vBRIEF was carved out of. Its closure is NOT a completion signal for
    the child, so the references fallback in ``resolve_lifecycle_anchor``
    excludes it. Returns ``None`` when absent or unparseable.
    """
    return _parse_issue_ref_string(_x_tracking(data).get("decomposition_origin"))


def resolve_lifecycle_anchor(data: dict) -> tuple[int | None, str]:
    """Resolve a vBRIEF's canonical lifecycle anchor (#1290 Phase B / #1319).

    Returns ``(issue_number, axis)`` where ``axis`` is one of:
      - ``"planRef"``      -- ``plan.planRef`` resolved to an issue number.
      - ``"parent_issue"`` -- planRef absent; resolved the child's own
                              issue from ``x-tracking.parent_issue``.
      - ``"references"``   -- both absent; fell back to the first
                              github-issue entry in ``references[]`` that
                              is NOT the decomposition_origin umbrella.
      - ``"none"``         -- nothing yielded a github-issue number.

    The Axis B fix (#1290): ``plan.planRef`` is consulted FIRST so an
    umbrella close does not false-positive across a cohort whose own
    planRef issues are still open.

    The #1319 hardening: decomposition children carved from an umbrella
    frequently lack ``plan.planRef`` but DO record their own primary
    issue under ``x-tracking.parent_issue``. That is consulted next, so a
    closed umbrella never drags a child whose own issue is still open.
    The ``references[]`` fallback additionally EXCLUDES the
    ``x-tracking.decomposition_origin`` umbrella, so the closure of the
    parent the child was carved from can never -- on its own -- be read
    as the child's completion signal (the #742 / #1283 / #1284 / #1285 /
    #1291 recurrence).
    """
    num = parse_plan_ref(data)
    if num is not None:
        return num, "planRef"
    num = parse_parent_issue(data)
    if num is not None:
        return num, "parent_issue"
    decomposition_origin = parse_decomposition_origin(data)
    for ref in extract_references_from_vbrief(data):
        if ref.get("type") not in GITHUB_ISSUE_REF_TYPES:
            continue
        num = parse_issue_number(ref)
        if num is None:
            continue
        if decomposition_origin is not None and num == decomposition_origin:
            # The umbrella the child was carved from is not a completion
            # signal for the child (#1319). Skip it as an anchor candidate.
            continue
        return num, "references"
    return None, "none"


def scan_lifecycle_anchors(vbrief_dir: Path) -> list[dict]:
    """Resolve the canonical lifecycle anchor for every vBRIEF (#1290).

    Unlike ``scan_vbrief_dir`` (which maps each issue number to ALL the
    vBRIEFs that reference it, for the human report), this is vBRIEF-
    centric: each vBRIEF resolves to exactly one canonical anchor via
    ``resolve_lifecycle_anchor``. Returns a list of dicts with keys
    ``rel_path``, ``issue_number`` (``int`` or ``None``), and ``axis``.
    """
    anchors: list[dict] = []
    for folder in LIFECYCLE_FOLDERS:
        folder_path = vbrief_dir / folder
        if not folder_path.is_dir():
            continue
        for vbrief_file in sorted(folder_path.glob("*.vbrief.json")):
            try:
                data = json.loads(vbrief_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            num, axis = resolve_lifecycle_anchor(data)
            anchors.append({
                "rel_path": f"{folder}/{vbrief_file.name}",
                "issue_number": num,
                "axis": axis,
            })
    return anchors


def build_lifecycle_report(
    anchors: list[dict],
    issue_state_map: dict[int, str],
    *,
    log: bool = True,
) -> dict:
    """Build the apply-mode report from canonical anchors (#1290 Phase B).

    Each vBRIEF is classified by its OWN canonical anchor's state rather
    than by every issue it references. Emits a structured per-vBRIEF log
    line naming the resolved axis so a recovery audit can confirm the
    reconciler routed off the correct anchor. Returns the same two-section
    shape as ``reconcile`` (``linked`` / ``no_open_issue`` / ``summary``),
    with each ``no_open_issue`` entry carrying ``state`` + ``state_reason``
    for apply-mode routing.
    """
    linked: list[dict] = []
    no_open_issue: list[dict] = []

    for anchor in anchors:
        rel = anchor["rel_path"]
        num = anchor["issue_number"]
        axis = anchor["axis"]
        if num is None:
            if log:
                print(
                    f"[lifecycle-resolve] vbrief={rel} axis=none "
                    "anchor=none state=n/a stateReason=n/a",
                    file=sys.stderr,
                )
            continue
        value = issue_state_map.get(num)
        state = str(value) if value is not None else "NOT_FOUND"
        reason = state_reason_of(value)
        if log:
            print(
                f"[lifecycle-resolve] vbrief={rel} axis={axis} "
                f"anchor=#{num} state={state} stateReason={reason}",
                file=sys.stderr,
            )
        if state == "OPEN":
            linked.append({"issue_number": num, "vbrief_files": [rel]})
        else:
            note = (
                "Issue is closed"
                if state == "CLOSED"
                else "Issue is closed or does not exist"
            )
            no_open_issue.append({
                "issue_number": num,
                "vbrief_files": [rel],
                "note": note,
                "state": state,
                "state_reason": reason,
            })

    return {
        "linked": linked,
        "no_open_issue": no_open_issue,
        "summary": {
            "linked_count": len(linked),
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
    """Format report as Markdown.

    Handles both the inverted-lookup shape (default path; #754 -- two
    sections, no ``unlinked`` bucket) and the legacy three-section shape
    surfaced via ``--report-unlinked``. Section (b) is omitted when the
    report lacks an ``unlinked`` key.
    """
    lines: list[str] = []
    summary = report["summary"]
    has_unlinked = "unlinked" in report

    lines.append("# Issue Reconciliation Report")
    lines.append("")
    if has_unlinked:
        lines.append(f"- **Open issues**: {summary['total_open_issues']}")
    lines.append(f"- **Linked** (vBRIEF provenance): {summary['linked_count']}")
    if has_unlinked:
        lines.append(
            f"- **Unlinked** (no vBRIEF): {summary['unlinked_count']}"
        )
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
            # Legacy shape carries title/url; inverted shape omits both.
            title = entry.get("title", "")
            suffix = f" {title}" if title else ""
            lines.append(f"- #{entry['issue_number']}{suffix} -- {files}")
    else:
        lines.append("None.")
    lines.append("")

    # Section B: Unlinked (legacy three-section report only).
    if has_unlinked:
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


def _propagate_item_status(items: list, item_status: str, stamp: str) -> int:
    """Flip every item's ``status`` to ``item_status`` and stamp ``completed``.

    Walks ``plan.items[*]`` recursively -- including the nested ``subItems``
    and ``items`` arrays that ``extract_references_from_vbrief`` traverses --
    so a vBRIEF with sub-item trees lands fully consistent rather than only
    flipping the top level. Each touched item gets ``status = item_status``
    (``"completed"`` or ``"cancelled"``) and an item-level ISO-8601 UTC
    ``completed`` timestamp mirroring PR #921's hand-applied
    ``plan.items[*].completed`` pattern. Returns the number of items touched
    (#924).
    """
    touched = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        item["status"] = item_status
        item["completed"] = stamp
        touched += 1
        # ``.get(key) or []`` (not ``.get(key, [])``): a present key with an
        # explicit JSON ``null`` value returns ``None`` from ``.get(key, [])``
        # because the default only applies to ABSENT keys. Passing ``None``
        # into the recursion would raise ``TypeError: 'NoneType' object is
        # not iterable`` and abort the whole lifecycle-fix batch mid-loop
        # (#924 defensive hardening).
        touched += _propagate_item_status(
            item.get("subItems") or [], item_status, stamp
        )
        touched += _propagate_item_status(
            item.get("items") or [], item_status, stamp
        )
    return touched


def _destination_folder(state_reason: str | None) -> str:
    """Map a CLOSED issue's ``stateReason`` to a terminal folder (#1290).

    ``NOT_PLANNED`` and ``DUPLICATE`` route to ``cancelled/``; everything
    else (``COMPLETED``, a null reason, or the ``NOT_FOUND`` sentinel)
    routes to ``completed/`` -- the pre-#1290 default behaviour.
    """
    if state_reason in CANCELLED_STATE_REASONS:
        return "cancelled"
    return "completed"


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
    """Move non-terminal Section (c) entries to a terminal folder.

    Iterates ``report['no_open_issue']`` and for each vBRIEF file path
    that is NOT already in a terminal lifecycle folder:

    1. Read the JSON.
    2. Route by the entry's ``state_reason`` (#1290): CLOSED+NOT_PLANNED
       and CLOSED+DUPLICATE go to ``cancelled/`` (``plan.status =
       "cancelled"``); everything else (COMPLETED / null reason /
       NOT_FOUND) goes to ``completed/`` (``plan.status = "completed"``).
       Entries without a ``state_reason`` key (legacy callers / hand-built
       reports) default to ``completed/`` -- the pre-#1290 behaviour.
    3. Stamp ``vBRIEFInfo.updated`` with the current UTC ISO timestamp.
    4. Write the file back (UTF-8, no BOM, trailing newline).
    5. ``git mv`` (or filesystem-move) the file into the routed folder.

    The function is intentionally idempotent: a second call with a
    fresh report (where every entry already lives in ``completed/`` or
    ``cancelled/``) is a no-op. Reverse mismatches (vBRIEFs already in a
    terminal folder whose issue was reopened) are skipped silently here -- they are
    surfaced in the report's Section (a) / (c) split, but auto-reverse
    is intentionally NOT performed (operator decision per #734).

    Returns ``(moved, skipped, failures)`` where ``failures`` is a list
    of human-readable failure descriptions (empty on the happy path).

    #756: Section (c) entries are deduplicated by relative path BEFORE
    the move loop runs. A single vBRIEF that references multiple closed
    issues appears once per issue in the report; without dedup the
    second-and-later iterations attempt to re-move the same file --
    the first move succeeds, the rest fail with the spurious
    ``vBRIEF file missing`` diagnostic and the function exits with
    ``failures != []`` even though the lifecycle move itself was
    correct. The pre-computed unique set preserves the surfacing order
    of the report (each path is processed in first-seen order) so the
    ``[N/M] vBRIEFs reconciled`` summary keeps stable output across
    runs.
    """
    moved = 0
    skipped = 0
    failures: list[str] = []
    cwd = project_root if project_root is not None else vbrief_dir.parent

    # #756: pre-compute the unique candidate set in first-seen order so
    # a vBRIEF that references multiple closed issues lands in its
    # terminal folder exactly once. ``dict`` preserves insertion order
    # while collapsing duplicates; the value records the first-seen
    # ``state_reason`` so #1290 routing is stable across duplicate
    # entries for the same path.
    rel_reasons: dict[str, str | None] = {}
    for entry in report.get("no_open_issue", []):
        reason = entry.get("state_reason")
        for rel_path in entry.get("vbrief_files", []):
            if rel_path not in rel_reasons:
                rel_reasons[rel_path] = reason

    for rel_path, state_reason in rel_reasons.items():
        try:
            folder, filename = rel_path.split("/", 1)
        except ValueError:
            failures.append(
                f"unexpected vBRIEF path shape (no folder): {rel_path!r}"
            )
            continue
        if is_terminal_lifecycle_path(rel_path):
            # Already terminal; no-op.
            skipped += 1
            continue

        # #1290: route by stateReason. NOT_PLANNED / DUPLICATE ->
        # cancelled/; COMPLETED / null / NOT_FOUND -> completed/.
        dest_folder = _destination_folder(state_reason)
        src = vbrief_dir / folder / filename
        dst = vbrief_dir / dest_folder / filename
        if not src.is_file():
            failures.append(f"vBRIEF file missing: {rel_path}")
            continue

        try:
            data = json.loads(src.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            failures.append(f"failed to parse {rel_path}: {exc}")
            continue

        # Greptile P1: check for a destination conflict BEFORE
        # mutating the source file on disk. Previously the
        # write-back happened before ``dst.exists()`` so a
        # collision left the source vBRIEF in an inconsistent
        # half-completed state (status stamped on disk but the file
        # still in its original lifecycle folder). Now the conflict
        # guard fires before any write, so the source file stays
        # byte-identical when the move cannot proceed.
        (vbrief_dir / dest_folder).mkdir(parents=True, exist_ok=True)
        if dst.exists():
            failures.append(
                f"target already exists in {dest_folder}/: {filename}"
            )
            continue

        # Stamp status + updated. cancelled/ vBRIEFs get
        # plan.status="cancelled"; completed/ get "completed".
        plan = data.setdefault("plan", {})
        terminal_status = (
            "cancelled" if dest_folder == "cancelled" else "completed"
        )
        plan["status"] = terminal_status
        stamp = _utc_now_iso()
        info = data.setdefault("vBRIEFInfo", {})
        info["updated"] = stamp
        # Mirror the migrator pattern: also stamp ``plan.updated`` so
        # downstream tooling that prefers the plan-level field stays
        # current. Pre-existing files without the key gain it.
        plan["updated"] = stamp
        # #924: propagate the terminal status down to every
        # plan.items[*] (recursively, incl. subItems/items) and stamp an
        # item-level ISO-8601 UTC ``completed`` timestamp. Without this
        # the on-disk record is internally inconsistent (plan.status
        # flipped, items still "proposed"/"pending") and the next
        # reconcile/refinement pass re-flags the file as drifted.
        # ``.get("items") or []`` guards against an explicit ``"items": null``
        # in the on-disk JSON (the ``.get(key, [])`` default only applies to
        # ABSENT keys, so a present null would otherwise reach the recursion
        # as ``None`` and abort the batch).
        _propagate_item_status(plan.get("items") or [], terminal_status, stamp)

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

        if not _git_mv(src, dst, cwd=cwd):
            failures.append(f"failed to move {rel_path} -> {dest_folder}/")
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
            "Apply Section (c) fixes: move non-terminal closed-issue "
            "vBRIEFs to completed/, stamp plan.status=completed and "
            "vBRIEFInfo.updated. Idempotent on re-run. Reverse "
            "mismatches (terminal vBRIEF + reopened issue) are "
            "report-only -- never auto-reverse-moved. (#734)"
        ),
    )
    parser.add_argument(
        "--report-unlinked",
        action="store_true",
        default=False,
        help=(
            "Emit the legacy three-section report including the "
            "``unlinked`` bucket (open issues with no matching vBRIEF). "
            "Requires fetching every open issue in the repo, which "
            "scales by O(repo-open-issue-count). Default invocation "
            "uses the inverted-lookup path (#754) and emits only "
            "sections (a) and (c)."
        ),
    )
    parser.add_argument(
        "--max-open-issues",
        type=int,
        default=DEFAULT_MAX_OPEN_ISSUES,
        metavar="N",
        help=(
            f"Safety cap for the --report-unlinked path (default "
            f"{DEFAULT_MAX_OPEN_ISSUES}). When the paginated open-issue "
            "fetch exceeds N, abort cleanly with exit 1 and a "
            "diagnostic. Raise the cap explicitly when invoking "
            "--report-unlinked on a large repo. (#754)"
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

    # #754: branch on ``--report-unlinked``. The default path uses the
    # inverted-lookup helper -- O(vBRIEF-referenced-issue-count) cost,
    # no truncation possible. The opt-in legacy path fetches every open
    # issue and emits the three-section report; capped by
    # ``--max-open-issues`` so a 15k-open-issue repo cannot surprise
    # operators with a 30s+ fetch.
    # #1290 Phase B: resolve each vBRIEF's canonical lifecycle anchor
    # (planRef-first) so apply-mode never drags a cohort member into a
    # closed umbrella's terminal state. Computed only when apply-mode is
    # requested; the state fetch then covers both the reference-based
    # scan (human report) and the canonical anchors (apply candidates),
    # so a planRef issue absent from references[] still gets its state.
    anchors: list[dict] = []
    needed = set(issue_to_vbriefs.keys())
    if args.apply_lifecycle_fixes:
        anchors = scan_lifecycle_anchors(vbrief_dir)
        needed |= {
            a["issue_number"] for a in anchors if a["issue_number"] is not None
        }

    issue_state_map: dict[int, IssueState] | None = None
    if args.report_unlinked:
        open_issues = fetch_all_open_issues(repo, cwd=project_root)
        if open_issues is None:
            return 1
        if len(open_issues) > args.max_open_issues:
            print(
                f"Error: {len(open_issues)} open issues exceeds "
                f"--max-open-issues={args.max_open_issues}; raise the "
                "cap or drop --report-unlinked",
                file=sys.stderr,
            )
            return 1
        report = reconcile_with_unlinked(issue_to_vbriefs, open_issues)
        # Apply-mode still needs anchor states even on the legacy path.
        if args.apply_lifecycle_fixes:
            issue_state_map = fetch_issue_states(
                repo, needed, cwd=project_root
            )
            if issue_state_map is None:
                return 1
    else:
        # Inverted lookup: query just the vBRIEF-referenced subset.
        issue_state_map = fetch_issue_states(repo, needed, cwd=project_root)
        if issue_state_map is None:
            return 1
        report = reconcile(issue_to_vbriefs, issue_state_map)

    # Output
    if args.format == "json":
        print(format_json(report))
    else:
        print(format_markdown(report))

    # #734/#1290: apply mode -- move non-terminal closed-issue vBRIEFs to
    # their terminal folder (completed/ or cancelled/, routed by
    # stateReason). The apply candidate set is built from the canonical
    # anchors (Phase B), NOT the reference-based human report.
    if args.apply_lifecycle_fixes:
        apply_report = build_lifecycle_report(anchors, issue_state_map or {})
        candidates = sum(
            1
            for entry in apply_report.get("no_open_issue", [])
            for rel in entry.get("vbrief_files", [])
            if not is_terminal_lifecycle_path(rel)
        )
        moved, skipped, failures = apply_lifecycle_fixes(
            vbrief_dir, apply_report, project_root=project_root
        )
        total = moved + skipped + len(failures)
        print(
            f"[{moved}/{candidates}] vBRIEFs reconciled "
            f"(moved={moved}, already-terminal={skipped}, "
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
