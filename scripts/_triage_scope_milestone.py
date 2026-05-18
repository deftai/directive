"""Milestone-rule helpers for ``scripts/triage_scope.py`` (D14b / #1181).

D14 (#1133) shipped the milestone rule with the v1 exact-match shape
``{rule: "milestone", name: "<exact-name>"}``. D14b (#1181) extends the
grammar with two additional, mutually-exclusive variants:

* ``{rule: "milestone", any-of: ["<n1>", "<n2>", ...]}`` -- issue matches
  if its milestone title is in the list.
* ``{rule: "milestone", is-open: true}`` -- issue matches if its
  milestone is currently open upstream.

Validation: exactly one of ``name`` / ``any-of`` / ``is-open`` MUST be
present per rule. ``is-open`` MUST be the literal ``true`` (``false`` is
meaningless; consumers wanting specific milestones use ``name`` or
``any-of``).

Evaluation: the ``is-open`` variant queries
``gh api repos/<o>/<r>/milestones?state=open`` exactly ONCE per
``evaluate_rules`` call (memoized snapshot, never per-issue).

Kept out of ``scripts/triage_scope.py`` to stay under the 1000-line MUST
cap from ``coding/coding.md``. Re-exported for back-compat where useful.

Refs #1181, #1119, #1131 (D12), #1133 (D14).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

#: Strict allow-list of GitHub hostnames accepted by
#: :func:`infer_repo_from_issues`. Substring / `in` matching is a CodeQL
#: ``py/incomplete-url-substring-sanitization`` finding: an attacker-controlled
#: ``html_url`` value of the form ``https://evil-github.com.attacker.com/...``
#: would satisfy a naive ``"github.com" in url`` check. Enforce strict host
#: equality via :func:`urllib.parse.urlparse` instead.
_GITHUB_HOSTNAMES: frozenset[str] = frozenset({"github.com", "api.github.com"})

#: The set of recognised keys on a ``milestone`` rule body. ``rule`` is
#: the discriminator itself; the rest are the three variant keys.
_MILESTONE_VARIANT_KEYS: tuple[str, ...] = ("name", "any-of", "is-open")
_MILESTONE_ALL_KEYS: frozenset[str] = frozenset(("rule", *_MILESTONE_VARIANT_KEYS))


def validate_milestone_rule(
    rule: dict[str, Any],
    prefix: str,
    errors: list[str],
    warnings: list[str],
) -> None:
    """Validate a single ``milestone`` rule body in place.

    Mutates ``errors`` / ``warnings`` to mirror the existing
    ``_validate_rule_body`` contract in ``triage_scope.py`` so the parent
    module can delegate without round-tripping return values.

    Acceptance:

    * Exactly one of ``name`` / ``any-of`` / ``is-open`` MUST be present.
    * ``name`` (when set) MUST be a non-empty string.
    * ``any-of`` (when set) MUST be a non-empty list of non-empty strings.
    * ``is-open`` (when set) MUST be the literal boolean ``True``. The
      literal ``False`` is rejected with a hint pointing at the other
      two variants (``False`` is the do-nothing case the operator
      almost certainly does NOT want, so a silent accept would be a
      footgun).

    Unknown sibling keys produce a warning (not an error) so a
    forward-compat consumer who hand-edits a future shape gets a clear
    hint rather than silent drift.
    """
    has_name = "name" in rule
    has_any = "any-of" in rule
    has_open = "is-open" in rule
    set_count = sum([has_name, has_any, has_open])

    if set_count == 0:
        errors.append(
            f"{prefix}.milestone requires one of 'name' / 'any-of' / "
            "'is-open: true' (D14b / #1181); see "
            "scripts/triage_scope.py for the variant matrix"
        )
        return

    if set_count > 1:
        present = [k for k in _MILESTONE_VARIANT_KEYS if k in rule]
        errors.append(
            f"{prefix}.milestone: {present} are mutually exclusive; "
            "choose exactly one of name / any-of / is-open (#1181)"
        )
        return

    if has_name:
        name = rule.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(
                f"{prefix}.milestone.name must be a non-empty string"
            )
            return
    elif has_any:
        any_of = rule.get("any-of")
        if not isinstance(any_of, list) or not any_of:
            errors.append(
                f"{prefix}.milestone.any-of must be a non-empty list of strings (#1181)"
            )
            return
        for j, item in enumerate(any_of):
            if not isinstance(item, str) or not item:
                errors.append(
                    f"{prefix}.milestone.any-of[{j}] must be a non-empty string"
                )
    else:  # has_open
        is_open = rule.get("is-open")
        if not isinstance(is_open, bool):
            errors.append(
                f"{prefix}.milestone.is-open must be a boolean literal `true`; "
                f"got {type(is_open).__name__} (#1181)"
            )
            return
        if is_open is False:
            errors.append(
                f"{prefix}.milestone.is-open: false is meaningless -- "
                "to subscribe to specific milestones use `name` or "
                "`any-of` (#1181)"
            )
            return

    extra = sorted(k for k in rule if k not in _MILESTONE_ALL_KEYS)
    if extra:
        warnings.append(
            f"{prefix}.milestone: ignoring unrecognised keys {extra}"
        )


def collect_milestone_subscribed_names(
    rules: Iterable[dict[str, Any]],
) -> set[str]:
    """Return the set of milestone names covered by ``name`` / ``any-of``.

    Used by the drift detector to suppress entries the operator already
    knows about. The ``is-open: true`` variant is NOT consulted here --
    that variant resolves against the live upstream snapshot, which the
    caller adds separately when any rule requests ``is-open: true``.
    """
    out: set[str] = set()
    for rule in rules:
        if not isinstance(rule, dict) or rule.get("rule") != "milestone":
            continue
        name = rule.get("name")
        if isinstance(name, str) and name:
            out.add(name)
        any_of = rule.get("any-of")
        if isinstance(any_of, list):
            for item in any_of:
                if isinstance(item, str) and item:
                    out.add(item)
    return out


def rules_request_is_open(rules: Iterable[dict[str, Any]]) -> bool:
    """True iff any milestone rule asks for ``is-open: true``."""
    return any(
        isinstance(r, dict)
        and r.get("rule") == "milestone"
        and r.get("is-open") is True
        for r in rules
    )


# ---------------------------------------------------------------------------
# Open-milestones snapshot fetcher
# ---------------------------------------------------------------------------


#: Env-var override for the default fetcher's subprocess timeout. Bounded
#: so a hung ``gh`` invocation can't wedge a long evaluator call.
ENV_FETCH_TIMEOUT_S = "DEFT_MILESTONE_FETCH_TIMEOUT_S"
DEFAULT_FETCH_TIMEOUT_S: int = 30


def infer_repo_from_issues(issues: Iterable[dict[str, Any]]) -> str | None:
    """Best-effort ``owner/name`` inference from the issue list.

    Reads ``repository_url`` (canonical REST field, shape
    ``https://api.github.com/repos/<owner>/<name>``) and falls back to
    ``html_url``. Returns the first plausible match so a heterogeneous
    issue list (cross-repo cohort) still resolves to a deterministic
    repo for the upstream milestones call.

    Strictly validates the URL's hostname via :func:`urllib.parse.urlparse`
    against :data:`_GITHUB_HOSTNAMES` before extracting any path segment.
    Substring / ``in`` matching on the URL string would be a CodeQL
    ``py/incomplete-url-substring-sanitization`` finding -- an attacker
    controlling an issue payload could craft ``https://evil-github.com.attacker.com/owner/name/...``
    that satisfies a naive ``"github.com" in url`` check.
    """
    for issue in issues:
        if not isinstance(issue, dict):
            continue
        for key in ("repository_url", "html_url"):
            value = issue.get(key)
            if not isinstance(value, str) or not value:
                continue
            try:
                parsed = urlparse(value)
            except (ValueError, TypeError):
                continue
            host = (parsed.hostname or "").lower()
            if host not in _GITHUB_HOSTNAMES:
                continue
            segments = [s for s in parsed.path.split("/") if s]
            # api.github.com canonical repository_url:
            #   path = "/repos/<owner>/<name>"  ->  segments[0]=="repos"
            # github.com html_url:
            #   path = "/<owner>/<name>" or "/<owner>/<name>/issues/<n>"
            if segments and segments[0] == "repos" and len(segments) >= 3:
                owner, name = segments[1], segments[2]
            elif len(segments) >= 2:
                owner, name = segments[0], segments[1]
            else:
                continue
            if owner and name:
                return f"{owner}/{name}"
    return None


def default_open_milestones_fetcher(repo: str | None) -> set[str]:
    """Invoke ``gh api`` to list currently-open milestones for ``repo``.

    Returns the set of milestone titles. On any failure (missing repo,
    non-zero exit, unparseable JSON, hung subprocess) returns an empty
    set rather than raising -- callers consuming the result via
    :func:`evaluate_rules` already tolerate empty snapshots (no
    matches for that rule).

    Production callers SHOULD pass an explicit ``open_milestones_fetcher``
    closure that wraps a higher-level cache (``ghx`` / per-process
    memoization). This default is the bottom of the ladder so an
    out-of-the-box call still works.
    """
    if not isinstance(repo, str) or "/" not in repo:
        return set()
    timeout = DEFAULT_FETCH_TIMEOUT_S
    raw = os.environ.get(ENV_FETCH_TIMEOUT_S, "").strip()
    if raw:
        try:
            timeout = max(1, int(raw))
        except ValueError:
            timeout = DEFAULT_FETCH_TIMEOUT_S

    binary = _resolve_gh_binary()
    if binary is None:
        return set()
    cmd = [
        binary,
        "api",
        f"repos/{repo}/milestones?state=open&per_page=100",
        "--paginate",
    ]
    try:
        result = subprocess.run(  # noqa: S603 -- argv list, no shell
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    if result.returncode != 0:
        return set()
    return _parse_milestone_titles(result.stdout)


def _resolve_gh_binary() -> str | None:
    """Return the gh binary path via ``scripts.scm.resolve_binary``.

    Falls back to the literal ``"gh"`` (PATH lookup) if scm is not
    importable, e.g. during a fresh-checkout test that pulls only this
    module in isolation.
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import scm  # type: ignore[import-not-found]

        return scm.resolve_binary()
    except (ImportError, AttributeError):
        return "gh"


def _parse_milestone_titles(stdout: str) -> set[str]:
    """Parse ``gh api ... milestones`` JSON output.

    ``gh api --paginate`` concatenates JSON arrays per page; we accept
    either a single top-level array OR a series of concatenated arrays
    (paginate fallback). Bad / truncated output yields an empty set.
    """
    text = (stdout or "").strip()
    if not text:
        return set()
    titles: set[str] = set()
    try:
        data = json.loads(text)
        return _extract_titles(data)
    except json.JSONDecodeError:
        # Paginate may concatenate arrays directly; split + retry.
        pass
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(text):
        while idx < len(text) and text[idx].isspace():
            idx += 1
        if idx >= len(text):
            break
        try:
            data, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError:
            break
        titles |= _extract_titles(data)
        idx = end
    return titles


def _extract_titles(data: Any) -> set[str]:
    out: set[str] = set()
    if isinstance(data, list):
        for entry in data:
            if not isinstance(entry, dict):
                continue
            title = entry.get("title")
            if isinstance(title, str) and title:
                out.add(title)
    return out

def make_open_milestones_resolver(
    open_milestones_fetcher: Callable[[], Any] | None,
    issues: Iterable[dict[str, Any]],
    repo: str | None,
) -> Callable[[], set[str]]:
    """Return a once-per-call memoized open-milestones resolver.

    ``triage_scope.evaluate_rules`` uses this to ensure the D14b
    ``milestone {is-open: true}`` variant fetches the upstream
    open-milestones snapshot AT MOST ONCE per evaluator call, even when
    multiple ``is-open`` rules are present.
    """
    materialised = list(issues)
    cache: dict[str, set[str] | None] = {"value": None}

    def resolve() -> set[str]:
        cached = cache["value"]
        if cached is not None:
            return cached
        if open_milestones_fetcher is not None:
            try:
                raw = open_milestones_fetcher()
            except Exception:  # noqa: BLE001 -- defensive; empty snapshot = no matches
                raw = set()
            snapshot = (
                set(raw)
                if isinstance(raw, (set, frozenset, list, tuple))
                else set()
            )
        else:
            resolved_repo = repo or infer_repo_from_issues(materialised)
            snapshot = default_open_milestones_fetcher(resolved_repo)
        cache["value"] = snapshot
        return snapshot

    return resolve


# ---------------------------------------------------------------------------
# Evaluator delegate
# ---------------------------------------------------------------------------


def evaluate_milestone_rule_into(
    rule: dict[str, Any],
    issues: list[dict[str, Any]],
    matched: dict[int, dict[str, Any]],
    *,
    get_open_milestones: Callable[[], set[str]],
    is_open_issue: Callable[[dict[str, Any]], bool],
    issue_number: Callable[[dict[str, Any]], int],
    milestone_name: Callable[[dict[str, Any]], str],
) -> None:
    """Apply a single ``milestone`` rule to ``issues`` and merge into ``matched``.

    Delegated from ``triage_scope.evaluate_rules`` so the parent module
    stays under the 1000-line MUST cap. The four predicates
    (``is_open_issue`` / ``issue_number`` / ``milestone_name``) are
    passed in so this helper doesn't need to import them back from
    ``triage_scope`` (avoids a circular import).
    """
    if "name" in rule:
        wanted = rule.get("name")
        if not isinstance(wanted, str) or not wanted:
            return
        for issue in issues:
            if is_open_issue(issue) and milestone_name(issue) == wanted:
                matched.setdefault(issue_number(issue), issue)
        return

    if "any-of" in rule:
        raw = rule.get("any-of")
        if not isinstance(raw, list) or not raw:
            return
        wanted_set = {w for w in raw if isinstance(w, str) and w}
        if not wanted_set:
            return
        for issue in issues:
            if is_open_issue(issue) and milestone_name(issue) in wanted_set:
                matched.setdefault(issue_number(issue), issue)
        return

    if rule.get("is-open") is True:
        open_set = get_open_milestones()
        if not open_set:
            return
        for issue in issues:
            if is_open_issue(issue) and milestone_name(issue) in open_set:
                matched.setdefault(issue_number(issue), issue)
        return
