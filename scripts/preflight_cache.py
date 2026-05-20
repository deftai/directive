#!/usr/bin/env python3
"""preflight_cache.py -- detection-bound cache-freshness gate (#1127, D5 of #1119).

Pure stdlib, cross-platform. Invoked from:

- ``task verify:cache-fresh`` (aggregated into ``task check``)
- Dispatcher pre-``start_agent`` invocations -- the dispatcher MUST run
  ``task verify:cache-fresh --for-issue <N>`` before any ``start_agent``
  and refuse dispatch on any non-zero exit (see
  ``templates/agent-prompt-preamble.md`` § 12).

Mirrors ``scripts/preflight_branch.py`` (#747) in shape: pure-stdlib so it
can run from a fresh git hook or a minimal CI runner before ``uv sync``
has produced an environment.

Exit codes (three-state):

- ``0`` -- cache fresh AND no blocking defer conditions.
- ``1`` -- cache stale OR blocking conditions found; prints remediation
  to stderr (names ``task triage:bootstrap`` and ``task cache:fetch-all``
  per the issue body).
- ``2`` -- config error: ``.deft-cache/`` missing entirely, or
  ``vbrief/.eval/candidates.jsonl`` missing. The config-error class is
  distinct from "cache stale" so a dispatcher can distinguish a never-
  -bootstrapped project (operator runs ``task triage:bootstrap``) from
  a stale-cache project (operator runs ``task cache:fetch-all``).

State machine (#1240):

Three user-visible states the OK message must distinguish post-#1240
because ``task triage:bootstrap`` now seeds an empty audit log:

1. **No cache yet** -- ``.deft-cache/<source>/`` absent. This is the
   never-bootstrapped state; the gate exits 2 (or 0 + bootstrap-state
   message when ``--allow-missing-bootstrap`` is passed).
2. **Cache present + audit log empty** -- consumer just ran
   ``task triage:bootstrap`` but has not yet executed any triage
   action. The gate exits 0 with a ``fresh bootstrap, no triage
   actions yet`` message. Pre-#1240 this state was unreachable because
   bootstrap left the audit log absent -- the gate fell through to
   the config-error branch and printed ``treating as bootstrap state``
   on a freshly-bootstrapped consumer.
3. **Cache present + audit log non-empty** -- canonical fresh state.
   The gate exits 0 with the ``actively triaging`` message.

Subscription-awareness (#1131 / D12 of #1119):

The freshness check is scoped to the consumer's
``plan.policy.triageScope[]`` subscription -- read via the D12 surface
:mod:`triage_scope` -- so a consumer with a tightened scope is not
gated by stale entries the operator has explicitly chosen not to track.
When ``--for-issue <N>`` is given the gate ALSO verifies the issue is
in scope; an out-of-scope issue exits 1 with a pointer to
``task triage:scope``.

Override paths:

- ``--allow-stale`` -- exit 0 with an audit-trail warning on stderr.
  Per-shell only; never persisted. Same shape as
  ``DEFT_ALLOW_DEFAULT_BRANCH_COMMIT`` from #747.
- ``--max-age-hours N`` / ``DEFT_CACHE_MAX_AGE_HOURS=N`` -- override the
  default 24h freshness window (env honoured when the flag is absent).
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import subprocess
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# Make sibling ``scripts`` modules importable when invoked via
# ``python scripts/preflight_cache.py`` from any working directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure (#814) -- error / OK messages include the ✓ /
# ⚠ / ❌ glyphs that cp1252 cannot encode.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

#: Cache directory name (mirrors ``scripts/cache.py::DEFAULT_CACHE_ROOT``).
CACHE_DIR_NAME: str = ".deft-cache"

#: Source the gate inspects. v1 ships ``github-issue`` only -- the same
#: scoping decision documented in #1127 "Not in scope".
DEFAULT_SOURCE: str = "github-issue"

#: Candidates audit log (mirrors ``scripts/candidates_log.py::DEFAULT_LOG_PATH``).
CANDIDATES_RELPATH: Path = Path("vbrief") / ".eval" / "candidates.jsonl"

#: Default freshness window in hours; configurable via flag / env.
DEFAULT_MAX_AGE_HOURS: int = 24

#: Env var override for the freshness window (parsed as int hours).
ENV_MAX_AGE_HOURS: str = "DEFT_CACHE_MAX_AGE_HOURS"

#: Env var honoured for repo inference when --repo is absent (mirrors
#: ``scripts/triage_bootstrap.py::DEFT_TRIAGE_REPO``).
ENV_TRIAGE_REPO: str = "DEFT_TRIAGE_REPO"

#: Decision verdict required for ``--for-issue`` to clear the gate. Any
#: other latest decision (``defer`` / ``reject`` / ``needs-ac`` /
#: ``mark-duplicate`` / ``reset``) blocks dispatch.
REQUIRED_DECISION: str = "accept"


# ---------------------------------------------------------------------------
# Result dataclass + helpers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GateResult:
    """Pure-data result of :func:`evaluate`. ``code`` is the exit code."""

    code: int
    message: str


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _parse_iso(stamp: str) -> datetime:
    """Parse an ISO-8601 timestamp; accepts trailing ``Z``."""
    text = stamp.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


# ---------------------------------------------------------------------------
# Repo discovery
# ---------------------------------------------------------------------------


def _infer_repo_from_git(project_root: Path) -> str | None:
    """Best-effort: read ``git remote get-url origin`` inside ``project_root``.

    Returns ``"owner/name"`` on success, ``None`` otherwise. A stuck git
    proxy (corporate VPN re-auth) is bounded by a 10s timeout so the
    gate never hangs the dispatcher.
    """
    try:
        proc = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    url = proc.stdout.strip()
    if not url:
        return None
    # github.com/owner/name(.git) -- accepts ssh / https / git protocol.
    cleaned = url.rstrip("/")
    if cleaned.endswith(".git"):
        cleaned = cleaned[: -len(".git")]
    if "github.com" not in cleaned:
        return None
    tail = cleaned.split("github.com", 1)[1].lstrip(":/")
    parts = tail.split("/")
    if len(parts) >= 2 and parts[0] and parts[1]:
        return f"{parts[0]}/{parts[1]}"
    return None


def _scan_cache_for_single_repo(cache_root: Path, source: str) -> str | None:
    """Return ``owner/name`` when the cache contains exactly one repo, else None."""
    base = cache_root / source
    if not base.is_dir():
        return None
    pairs: list[tuple[str, str]] = []
    for owner_dir in sorted(base.iterdir()):
        if not owner_dir.is_dir():
            continue
        for repo_dir in sorted(owner_dir.iterdir()):
            if repo_dir.is_dir():
                pairs.append((owner_dir.name, repo_dir.name))
    if len(pairs) == 1:
        owner, name = pairs[0]
        return f"{owner}/{name}"
    return None


def _resolve_repo(
    project_root: Path,
    cache_root: Path,
    source: str,
    *,
    explicit: str | None,
) -> str | None:
    """Resolve the repo slug in priority order: flag > env > git > single-cache-repo."""
    if explicit:
        return explicit
    env_repo = os.environ.get(ENV_TRIAGE_REPO, "").strip()
    if env_repo:
        return env_repo
    inferred = _infer_repo_from_git(project_root)
    if inferred:
        return inferred
    return _scan_cache_for_single_repo(cache_root, source)


# ---------------------------------------------------------------------------
# Cache scanning
# ---------------------------------------------------------------------------


def _iter_meta_paths(cache_root: Path, source: str, repo: str) -> Iterable[Path]:
    """Yield each ``meta.json`` path under ``<cache_root>/<source>/<repo>/*/``."""
    if "/" not in repo:
        return
    owner, name = repo.split("/", 1)
    repo_dir = cache_root / source / owner / name
    if not repo_dir.is_dir():
        return
    for entry in sorted(repo_dir.iterdir()):
        if not entry.is_dir():
            continue
        meta = entry / "meta.json"
        if meta.is_file():
            yield meta


def _read_meta(meta_path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _read_raw_issue(meta_path: Path) -> dict[str, Any] | None:
    """Read the sibling ``raw.json`` and return the parsed payload."""
    raw_path = meta_path.parent / "raw.json"
    if not raw_path.is_file():
        return None
    try:
        data = json.loads(raw_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------------------
# Subscription-aware filtering (D12 / #1131)
# ---------------------------------------------------------------------------


def _load_triage_scope_module() -> Any | None:
    """Lazy-load :mod:`triage_scope`; returns ``None`` if missing.

    D12 (#1131) is the upstream surface. The gate degrades gracefully to
    "no subscription filter" when the module is absent so a partial
    install / pre-D12 branch still gets the cache-freshness check.
    """
    try:
        import triage_scope  # type: ignore[import-not-found]

        return triage_scope
    except ImportError:
        return None


def _resolve_scope_rules(project_root: Path) -> list[dict[str, Any]] | None:
    """Return the effective ``plan.policy.triageScope[]`` rule list.

    Returns ``None`` when :mod:`triage_scope` is not importable; in that
    case the caller skips subscription filtering.
    """
    mod = _load_triage_scope_module()
    if mod is None:
        return None
    try:
        rules = mod.resolve_scope_rules(project_root)
    except Exception:  # noqa: BLE001 -- defensive, subscription is optional
        return None
    return list(rules) if isinstance(rules, list) else None


def _issue_in_scope(
    rules: list[dict[str, Any]] | None,
    issue: dict[str, Any],
    *,
    project_root: Path,
) -> bool:
    """True when ``issue`` is matched by ``rules`` (or rules are absent)."""
    if not rules:
        return True
    mod = _load_triage_scope_module()
    if mod is None:
        return True
    try:
        matched = mod.evaluate_rules(rules, [issue])
    except Exception:  # noqa: BLE001 -- defensive fallthrough
        return True
    if not isinstance(matched, list):
        return True
    target_number = issue.get("number")
    return any(
        isinstance(m, dict) and m.get("number") == target_number for m in matched
    )


def _filter_scoped_meta_paths(
    meta_paths: list[Path],
    rules: list[dict[str, Any]] | None,
    project_root: Path,
) -> list[Path]:
    """Filter ``meta_paths`` to those whose raw.json matches the scope rules."""
    if not rules:
        return meta_paths
    out: list[Path] = []
    for meta_path in meta_paths:
        raw = _read_raw_issue(meta_path)
        # When raw.json is missing or unparseable, keep the entry: the
        # freshness check is the load-bearing signal and we'd rather
        # over-include than mask a stale cache.
        if raw is None:
            out.append(meta_path)
            continue
        if _issue_in_scope(rules, raw, project_root=project_root):
            out.append(meta_path)
    return out


# ---------------------------------------------------------------------------
# candidates.jsonl helpers
# ---------------------------------------------------------------------------


def _candidates_path(project_root: Path) -> Path:
    return project_root / CANDIDATES_RELPATH


def _latest_decision_for_issue(
    candidates: Path, *, repo: str, issue_number: int
) -> dict[str, Any] | None:
    """Return the most recent decision dict for ``(repo, issue_number)``.

    Mirrors :func:`scripts.candidates_log.latest_decision` without taking
    a hard dependency on the module (pure stdlib here so the gate runs
    on a fresh checkout).
    """
    if not candidates.is_file():
        return None
    rows: list[dict[str, Any]] = []
    try:
        with candidates.open(encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(obj, dict):
                    continue
                if obj.get("repo") != repo:
                    continue
                if obj.get("issue_number") != issue_number:
                    continue
                rows.append(obj)
    except OSError:
        return None
    if not rows:
        return None
    rows.sort(key=lambda r: r.get("timestamp", ""))
    return rows[-1]


# ---------------------------------------------------------------------------
# Freshness window resolution
# ---------------------------------------------------------------------------


def _resolve_max_age_hours(explicit: int | None) -> int:
    if explicit is not None:
        return max(0, int(explicit))
    raw = os.environ.get(ENV_MAX_AGE_HOURS, "").strip()
    if not raw:
        return DEFAULT_MAX_AGE_HOURS
    try:
        parsed = int(raw)
    except ValueError:
        return DEFAULT_MAX_AGE_HOURS
    return max(0, parsed)


# ---------------------------------------------------------------------------
# Core evaluator
# ---------------------------------------------------------------------------


_REMEDIATION_STALE = (
    "  Remediation:\n"
    "    task triage:bootstrap         # full re-populate, or\n"
    "    task cache:fetch-all -- --source github-issue --repo <OWNER/NAME>\n"
    "  Override (audited): --allow-stale (or DEFT_CACHE_MAX_AGE_HOURS=<N>)."
)


def evaluate(
    project_root: Path,
    *,
    source: str = DEFAULT_SOURCE,
    repo: str | None = None,
    max_age_hours: int | None = None,
    for_issue: int | None = None,
    allow_stale: bool = False,
    allow_missing_bootstrap: bool = False,
    now: datetime | None = None,
) -> GateResult:
    """Pure-function gate. See module docstring for exit-code semantics.

    Separated from :func:`main` so tests drive every branch without
    ``capsys`` plumbing or argv leak.

    ``allow_missing_bootstrap`` mirrors ``preflight_branch.py``'s
    ``--allow-missing-project-definition`` bootstrap escape: when
    ``.deft-cache/`` or ``vbrief/.eval/candidates.jsonl`` is missing the
    gate returns exit 0 with a friendly info message instead of exit 2.
    The framework repo's own ``task check`` uses this so a fresh
    checkout that has not yet run ``task triage:bootstrap`` is not
    gated by its own cache-freshness verb. Consumers leave the flag
    OFF so the gate fails loudly when their cache is missing.
    """
    cache_root = project_root / CACHE_DIR_NAME
    candidates = _candidates_path(project_root)
    max_age_h = _resolve_max_age_hours(max_age_hours)
    now_dt = now or _utc_now()

    # --- Step 1: cache directory existence (config-error class) -----------
    source_dir = cache_root / source
    if not cache_root.is_dir() or not source_dir.is_dir():
        if allow_missing_bootstrap and for_issue is None:
            return GateResult(
                0,
                (
                    f"✓ deft cache-fresh: .deft-cache/{source}/ absent and "
                    "--allow-missing-bootstrap was passed -- treating as "
                    "bootstrap state (consumer runs `task triage:bootstrap` "
                    "to opt in)."
                ),
            )
        msg = (
            f"❌ deft cache-fresh: .deft-cache/{source}/ not present under "
            f"{project_root}. The triage cache has not been populated.\n"
            "  Recovery: run `task triage:bootstrap` (idempotent installer)\n"
            "             or `task cache:fetch-all -- --source "
            f"{source} --repo OWNER/NAME`."
        )
        return GateResult(2, msg)

    # --- Step 2: candidates.jsonl readable (config-error class) -----------
    if not candidates.is_file():
        if allow_missing_bootstrap and for_issue is None:
            return GateResult(
                0,
                (
                    f"✓ deft cache-fresh: {candidates.relative_to(project_root)} "
                    "absent and --allow-missing-bootstrap was passed -- "
                    "treating as bootstrap state."
                ),
            )
        msg = (
            f"❌ deft cache-fresh: {candidates} missing.\n"
            "  Recovery: run `task triage:bootstrap` to backfill the audit\n"
            "             log, or accept at least one candidate via\n"
            "             `task triage:accept`."
        )
        return GateResult(2, msg)

    # --- Step 3: repo resolution -----------------------------------------
    resolved_repo = _resolve_repo(project_root, cache_root, source, explicit=repo)
    if not resolved_repo:
        msg = (
            "❌ deft cache-fresh: cannot determine owner/repo. Pass --repo "
            "OWNER/NAME, set DEFT_TRIAGE_REPO, or run inside a git checkout "
            "whose `origin` is a github.com remote."
        )
        return GateResult(2, msg)

    meta_paths = list(_iter_meta_paths(cache_root, source, resolved_repo))
    if not meta_paths:
        msg = (
            "❌ deft cache-fresh: no cached entries under "
            f".deft-cache/{source}/{resolved_repo}/.\n"
            "  Recovery: `task cache:fetch-all -- --source "
            f"{source} --repo {resolved_repo}`."
        )
        return GateResult(2, msg)

    # --- Step 4: subscription filter (#1131) -----------------------------
    scope_rules = _resolve_scope_rules(project_root)
    scoped_meta_paths = _filter_scoped_meta_paths(meta_paths, scope_rules, project_root)
    # #1245: distinguish a ``backfill-only cache`` state (the cache
    # contains entries but none currently match the active subscription,
    # AND the consumer has emitted at least one triage decision
    # -- including ``triage:bootstrap``'s backfilled ``accept`` history
    # rows) from a genuine misconfiguration (no in-scope cached entries
    # AND no triage activity). The backfill-only state is the expected
    # post-bootstrap shape on a repo whose currently-cached open issues
    # do not happen to match the operator's narrow subscription; the
    # session-start gate should pass so the pre-``start_agent`` gate
    # stack composes cleanly. Downstream ``--for-issue`` dispatch still
    # enforces per-issue scope + decision via :func:`_gate_for_issue`,
    # so this relaxation only affects the cache-wide session check.
    backfill_only_cache = False
    if not scoped_meta_paths:
        audit_state = _audit_log_state(candidates)
        if audit_state == "populated":
            # Fall through to Step 5's freshness window using the FULL
            # ``meta_paths`` (not the empty scoped list) so a stale
            # cache still fails loudly even when every entry is out
            # of subscription. The Step 6 OK message uses the
            # ``backfill_only_cache`` flag to emit a state-aware line.
            backfill_only_cache = True
            scoped_meta_paths = meta_paths
        else:
            msg = (
                "❌ deft cache-fresh: every cached entry is outside the active "
                "plan.policy.triageScope[] subscription, and the audit log "
                "is empty (no triage decisions yet).\n"
                "  Recovery: widen the subscription (see "
                "`task triage:scope --list`), repopulate via "
                "`task cache:fetch-all`, or accept at least one candidate "
                "via `task triage:accept` once the cache has matching entries."
            )
            if allow_stale:
                # Mirror the Step 5 stale-cache pattern: --allow-stale
                # MUST NOT silently paper over a defer/reject/missing
                # --for-issue decision. Run the per-issue gate FIRST
                # and propagate any refusal; only fall through to the
                # allow-stale exit 0 when the per-issue check is clean
                # (or no --for-issue was passed).
                if for_issue is not None:
                    for_issue_result = _gate_for_issue(
                        resolved_repo,
                        for_issue,
                        candidates=candidates,
                        scope_rules=scope_rules,
                        source_dir=source_dir,
                        project_root=project_root,
                    )
                    if for_issue_result.code != 0:
                        return for_issue_result
                return GateResult(
                    0,
                    (
                        "⚠ deft cache-fresh: --allow-stale honoured but every "
                        "cached entry is out of scope; downstream tooling may "
                        "still refuse work."
                    ),
                )
            return GateResult(1, msg)

    # --- Step 5: freshness window ----------------------------------------
    max_fetched: datetime | None = None
    max_meta_path: Path | None = None
    for meta_path in scoped_meta_paths:
        meta = _read_meta(meta_path)
        if not meta:
            continue
        stamp = meta.get("fetched_at")
        if not isinstance(stamp, str) or not stamp:
            continue
        try:
            fetched = _parse_iso(stamp)
        except ValueError:
            continue
        if max_fetched is None or fetched > max_fetched:
            max_fetched = fetched
            max_meta_path = meta_path

    if max_fetched is None:
        msg = (
            "❌ deft cache-fresh: no parseable `fetched_at` in any cached "
            "meta.json. The cache may be corrupted.\n"
            "  Recovery: `task cache:fetch-all -- --source "
            f"{source} --repo {resolved_repo}`."
        )
        return GateResult(2, msg)

    age = now_dt - max_fetched
    if age < timedelta(0):
        age = timedelta(0)
    age_h = age.total_seconds() / 3600.0

    stale = max_age_h > 0 and age_h > max_age_h

    if stale and allow_stale:
        warning = (
            "⚠ deft cache-fresh: --allow-stale honoured; cache is "
            f"{age_h:.1f}h old (max-age={max_age_h}h). Downstream tooling "
            "may still refuse work."
        )
        # Still run the --for-issue gate so --allow-stale does not silently
        # paper over a defer/reject decision.
        if for_issue is not None:
            for_issue_result = _gate_for_issue(
                resolved_repo,
                for_issue,
                candidates=candidates,
                scope_rules=scope_rules,
                source_dir=source_dir,
                project_root=project_root,
            )
            if for_issue_result.code != 0:
                return for_issue_result
        return GateResult(0, warning)

    if stale:
        msg = (
            f"❌ deft cache-fresh: cache is {age_h:.1f}h old "
            f"(max-age={max_age_h}h); newest entry "
            f"{max_meta_path.relative_to(project_root) if max_meta_path else '?'}.\n"
            f"{_REMEDIATION_STALE}"
        )
        return GateResult(1, msg)

    # --- Step 6: --for-issue ---------------------------------------------
    if for_issue is not None:
        for_issue_result = _gate_for_issue(
            resolved_repo,
            for_issue,
            candidates=candidates,
            scope_rules=scope_rules,
            source_dir=source_dir,
            project_root=project_root,
        )
        if for_issue_result.code != 0:
            return for_issue_result

    # #1240: distinguish "fresh bootstrap, no triage actions yet" from
    # "actively triaging". A zero-length audit log indicates the consumer
    # just ran ``task triage:bootstrap`` (step 5 seeded the empty file)
    # but has not yet emitted any triage decision; the gate is still
    # clean but the language acknowledges the operator's mental state.
    # #1245: the ``backfill_only_cache`` flag set during Step 4 supplies
    # a third state -- the cache holds entries but none match the active
    # subscription, AND the audit log is populated (consumer is actively
    # triaging). The gate passes so downstream tooling can run; the
    # message names the state so the operator is not surprised that
    # ``triage:queue`` etc. show zero in-scope rows.
    audit_state = _audit_log_state(candidates)
    if backfill_only_cache:
        state_phrase = (
            "backfill-only cache (no entries match "
            "plan.policy.triageScope[]; audit log populated)"
        )
        in_scope_count = 0
    elif audit_state == "empty":
        state_phrase = "fresh bootstrap, no triage actions yet"
        in_scope_count = len(scoped_meta_paths)
    else:
        state_phrase = "actively triaging"
        in_scope_count = len(scoped_meta_paths)
    msg = (
        f"✓ deft cache-fresh: {resolved_repo} -- {in_scope_count} entry/ies "
        f"in scope; newest fetched {age_h:.1f}h ago (max-age={max_age_h}h); "
        f"{state_phrase}."
    )
    if for_issue is not None:
        msg += f" Issue #{for_issue} latest decision = accept; in subscription scope."
    return GateResult(0, msg)


def _audit_log_state(candidates: Path) -> str:
    """Return one of ``"empty"`` / ``"populated"`` (#1240).

    A zero-length file (post-#1240 bootstrap seed) is ``empty``; any
    file that parses at least one non-blank line is ``populated``.
    Errors reading the file fall back to ``empty`` so a corrupted
    audit log doesn't claim the consumer is actively triaging.
    """
    try:
        if candidates.stat().st_size == 0:
            return "empty"
    except OSError:
        return "empty"
    try:
        with candidates.open(encoding="utf-8") as fh:
            for raw_line in fh:
                if raw_line.strip():
                    return "populated"
    except OSError:
        return "empty"
    return "empty"


def _gate_for_issue(
    repo: str,
    issue_number: int,
    *,
    candidates: Path,
    scope_rules: list[dict[str, Any]] | None,
    source_dir: Path,
    project_root: Path,
) -> GateResult:
    """Run the ``--for-issue`` sub-gates: scope + latest-decision."""
    # Subscription: read raw.json from the cache and verify the issue is
    # matched by the rule set. If the issue isn't cached, treat as out of
    # scope so the operator must explicitly fetch + accept it first.
    owner, name = repo.split("/", 1) if "/" in repo else ("", "")
    issue_meta = source_dir / owner / name / str(issue_number) / "meta.json"
    raw = _read_raw_issue(issue_meta) if issue_meta.is_file() else None
    if scope_rules and raw is not None:
        if not _issue_in_scope(scope_rules, raw, project_root=project_root):
            msg = (
                f"❌ deft cache-fresh: issue #{issue_number} is OUTSIDE the "
                "active plan.policy.triageScope[] subscription.\n"
                "  Recovery: widen the subscription (see "
                "`task triage:scope --list`) or open it via "
                "`task triage:accept -- --repo OWNER/NAME --issue "
                f"{issue_number}` after confirming the scope rule covers it."
            )
            return GateResult(1, msg)
    elif scope_rules and raw is None:
        # We couldn't read the raw payload but rules are set; refuse so
        # the operator must `task cache:fetch-all` first.
        msg = (
            f"❌ deft cache-fresh: issue #{issue_number} is not present in "
            f".deft-cache/{DEFAULT_SOURCE}/{repo}/ (cannot verify subscription).\n"
            f"  Recovery: `task cache:fetch-all -- --source {DEFAULT_SOURCE} "
            f"--repo {repo}` and retry."
        )
        return GateResult(1, msg)

    # Latest-decision check.
    decision = _latest_decision_for_issue(
        candidates, repo=repo, issue_number=issue_number
    )
    if decision is None:
        msg = (
            f"❌ deft cache-fresh: issue #{issue_number} has no triage decision "
            f"in {candidates.relative_to(project_root)}.\n"
            "  Recovery: `task triage:accept -- --repo "
            f"{repo} --issue {issue_number}` "
            "before dispatching an implementation agent."
        )
        return GateResult(1, msg)

    verdict = decision.get("decision", "")
    if verdict != REQUIRED_DECISION:
        msg = (
            f"❌ deft cache-fresh: issue #{issue_number} latest decision "
            f"is {verdict!r}, not {REQUIRED_DECISION!r} -- dispatch refused.\n"
            f"  Recovery: re-evaluate via `task triage:status -- --repo {repo} "
            f"--issue {issue_number}` and run `task triage:accept` once the "
            "item is ready, or pick a different issue."
        )
        return GateResult(1, msg)

    return GateResult(0, f"✓ issue #{issue_number} cleared (decision=accept).")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="preflight_cache.py",
        description=(
            "Pre-`start_agent` cache-freshness gate (#1127). Refuses "
            "implementation dispatch when the triage cache is stale, "
            "missing, or the target issue's latest decision is not "
            "`accept`. Subscription-aware via plan.policy.triageScope[] "
            "(D12 / #1131)."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root path (default: current working directory).",
    )
    parser.add_argument(
        "--source",
        default=DEFAULT_SOURCE,
        help=(
            "Cache source to inspect. v1 ships github-issue only "
            "(default: github-issue)."
        ),
    )
    parser.add_argument(
        "--repo",
        default=None,
        help=(
            "Upstream repo slug 'owner/name'. Resolution precedence: "
            "(1) --repo, (2) $DEFT_TRIAGE_REPO, (3) `git remote get-url "
            "origin`, (4) single-repo auto-detect under .deft-cache/."
        ),
    )
    parser.add_argument(
        "--max-age-hours",
        type=int,
        default=None,
        help=(
            "Override the freshness window in hours. Falls back to "
            "$DEFT_CACHE_MAX_AGE_HOURS, then the built-in default (24h)."
        ),
    )
    parser.add_argument(
        "--for-issue",
        type=int,
        default=None,
        help=(
            "Verify a specific issue's latest decision is `accept` AND "
            "that it is covered by plan.policy.triageScope[] (D12). "
            "Refuses dispatch on any other decision or out-of-scope match."
        ),
    )
    parser.add_argument(
        "--allow-stale",
        action="store_true",
        help=(
            "Audit-trail escape hatch: exits 0 with a stderr warning even "
            "when the cache is stale. Per-shell only; never persisted."
        ),
    )
    parser.add_argument(
        "--allow-missing-bootstrap",
        action="store_true",
        help=(
            "Bootstrap fallback (mirrors preflight_branch.py's "
            "--allow-missing-project-definition): treat a missing "
            ".deft-cache/ or candidates.jsonl as exit 0 instead of exit 2. "
            "Used by the framework's own `task check` so a fresh checkout "
            "is not gated by its own verify:cache-fresh verb. Ignored when "
            "--for-issue is passed."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the OK message (errors still print to stderr).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    result = evaluate(
        project_root,
        source=args.source,
        repo=args.repo,
        max_age_hours=args.max_age_hours,
        for_issue=args.for_issue,
        allow_stale=args.allow_stale,
        allow_missing_bootstrap=args.allow_missing_bootstrap,
    )
    if result.code == 0:
        if not args.quiet:
            # Warning lines start with ⚠ and route to stderr so a CI run
            # that pipes stdout into a log still captures them next to
            # any later failures.
            if result.message.startswith("⚠"):
                print(result.message, file=sys.stderr)
            else:
                print(result.message)
    else:
        print(result.message, file=sys.stderr)
    return result.code


if __name__ == "__main__":
    sys.exit(main())
