#!/usr/bin/env python3
"""triage_scope.py -- typed cache-scope contract for the deft framework (#1131).

D12 introduces ``plan.policy.triageScope[]`` on
``vbrief/PROJECT-DEFINITION.vbrief.json`` -- a list of typed subscription
rules that determines which upstream issues a consumer cares about. The
framework default (per umbrella #1119 section 12 framework-vs-consumer
boundary) is ``[{"rule": "all-open"}]`` -- subscribe to every currently
open upstream issue. Consumers tighten the scope by adding rules that
restrict by label / age / explicit-watch / vbrief reference / umbrella
slicing; consumer-specific rule values live OUTSIDE the framework.

Programmatic API:

* :func:`resolve_scope_rules` -- read PROJECT-DEFINITION and return the
  effective rule list (default: ``[{"rule":"all-open"}]``).
* :func:`validate_scope_rules` -- structural validation. The
  ``milestone`` rule type ACCEPTS three mutually-exclusive variants:
  ``{name: "<exact-name>"}`` (D14 / #1133 v1), ``{any-of: [<n1>, <n2>]}``
  and ``{is-open: true}`` (D14b / #1181).
* :func:`subscription_hash` -- stable canonical-JSON SHA-256 digest
  (truncated to 16 chars) used as the coverage-cache invalidation key.
* :func:`evaluate_rules` -- apply the rule set to an issue list; the
  union of matches is returned.
* :func:`read_coverage_denominator` / :func:`write_coverage_denominator`
  -- coverage cache lifecycle helpers (Decision 3). Reads NEVER trigger
  a recompute; stale records surface as ``stale=True`` so callers can
  render ``coverage 247/?`` (literal ``?``).
* :func:`validate_scope_ignores` /
  :func:`resolve_scope_ignores` -- D14 (#1133) typed
  ``plan.policy.triageScopeIgnores[]`` foundation: list of
  ``{label: <L>}`` / ``{milestone: <M>}`` records the drift detector
  consults to suppress entries the operator explicitly chose not to
  subscribe to. Long-tail tuning verbs (mass-edit, sunset-on,
  match-many) are D14c / #1182 scope.

See ``scripts/_triage_scope_cli.py`` for the argparse shim. See the
Current Shape comment 4471901494 on issue #1131 for the canonical
decision record.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# Make sibling scripts importable when invoked as ``python scripts/triage_scope.py``.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# UTF-8 self-reconfigure -- the recap printed by ``--list`` includes the
# ✓ / · / ⚠ glyphs that cp1252 cannot encode.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

#: Filesystem-relative location of the PROJECT-DEFINITION vBRIEF.
PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json"

#: Canonical cache directory name. Matches ``scripts/triage_bootstrap.py``.
CACHE_DIR_NAME = ".deft-cache"

#: Coverage-denominator filename written under
#: ``.deft-cache/<source>/<owner>/<repo>/``.
COVERAGE_FILENAME = "coverage.json"

#: TTL env var name. Hours; default 24.
ENV_COVERAGE_TTL_HOURS = "DEFT_COVERAGE_MAX_AGE_HOURS"

#: Default coverage TTL when the env var is unset / unparseable.
DEFAULT_COVERAGE_TTL_HOURS: int = 24

#: Framework default per umbrella section 12. When ``plan.policy.triageScope``
#: is unset / missing, this list applies. Consumers MUST NOT special-case
#: their labels or milestones here -- consumer code lives outside the
#: framework (see deft consumer-example child of #1119).
DEFAULT_TRIAGE_SCOPE: list[dict[str, Any]] = [{"rule": "all-open"}]

#: Truncated hex length for :func:`subscription_hash`. 16 hex chars = 64 bits
#: of entropy, plenty for a cache-key in a small-cardinality space (one per
#: consumer cache).
SUBSCRIPTION_HASH_LEN: int = 16

#: Recognised rule discriminator values. ``milestone`` shipped in D14
#: (#1133) with the v1 ``{name: "<exact-name>"}`` shape; D14b (#1181)
#: adds the ``any-of`` + ``is-open: true`` variants on the same
#: discriminator.
VALID_RULE_TYPES: frozenset[str] = frozenset(
    {
        "all-open",
        "labels",
        "milestone",
        "opened-since",
        "updated-since",
        "referenced-by-vbrief",
        "sliced-from",
        "explicit-watch",
    }
)

#: Rule types reserved for downstream stories. Validation rejects them
#: with a pointer to the owning issue so consumers get a clear error
#: rather than silent ignore. D14 (#1133) shipped the v1 exact-match
#: ``milestone`` shape; D14b (#1181) added the ``any-of`` +
#: ``is-open: true`` variants -- future variants will surface as
#: per-field validation errors rather than discriminator-level
#: rejections.
DEFERRED_RULE_TYPES: dict[str, str] = {}

#: Recognised ignore-entry discriminator values (D14 / #1133).
#: Re-exported from :mod:`_triage_scope_ignores` so existing call
#: sites that ``triage_scope.VALID_IGNORE_KEYS`` keep working.
from _triage_scope_ignores import VALID_IGNORE_KEYS  # noqa: E402,F401,I001

#: Valid scope values for ``referenced-by-vbrief``.
_REFERENCED_BY_VBRIEF_SCOPES: frozenset[str] = frozenset({"any", "active"})

#: Valid scope values for ``sliced-from``.
_SLICED_FROM_SCOPES: frozenset[str] = frozenset({"any-umbrella-in-cache"})

#: Duration regex -- accepts ``7d`` / ``24h`` / ``30m`` / ``45s`` and the
#: ISO-8601 ``PnDTnHnMnS`` forms (e.g. ``P7D``, ``PT24H``). Case-insensitive.
_DURATION_RE_SIMPLE = re.compile(r"^\s*(\d+)\s*([smhdw])\s*$", re.IGNORECASE)
_DURATION_RE_ISO = re.compile(
    r"^P"
    r"(?:(?P<days>\d+)D)?"
    r"(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?"
    r"$",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CoverageRecord:
    """Coverage denominator cache record.

    Mirrors the JSON written to ``.deft-cache/<source>/<owner>/<repo>/coverage.json``.

    ``stale`` is True when the cache is older than the TTL OR when the
    stored ``subscription_hash`` no longer matches the current rule set.
    Stale records MUST NOT be treated as authoritative for ``triage:summary``
    output -- callers render ``coverage 247/?`` instead (Decision 3).
    """

    count: int
    fetched_at: str  # ISO-8601 UTC with trailing 'Z'
    subscription_hash: str
    stale: bool = False
    age_hours: float | None = None


# ---------------------------------------------------------------------------
# Time helpers (shared with cache.py-style stamps)
# ---------------------------------------------------------------------------


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _utc_iso(dt: datetime | None = None) -> str:
    return (dt or _utc_now()).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(stamp: str) -> datetime:
    text = stamp.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


# ---------------------------------------------------------------------------
# Duration parser
# ---------------------------------------------------------------------------


def parse_duration(raw: str) -> timedelta:
    """Parse a duration string into a :class:`timedelta`.

    Accepts:

    * Compact form: ``7d`` / ``24h`` / ``30m`` / ``45s`` / ``2w`` -- case
      insensitive.
    * ISO-8601 form: ``P7D`` / ``PT24H`` / ``PT30M`` / ``P1DT12H``.

    Raises :class:`ValueError` on malformed input. The returned delta is
    always positive; zero-length durations (``0d``, ``P0D``) are accepted
    and return ``timedelta(0)``.
    """
    if not isinstance(raw, str):
        raise ValueError(f"duration must be a string, got {type(raw).__name__}")
    text = raw.strip()
    if not text:
        raise ValueError("duration must be a non-empty string")

    m = _DURATION_RE_SIMPLE.match(text)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        return _scale_duration(n, unit)

    m = _DURATION_RE_ISO.match(text)
    if m and any(m.group(g) for g in ("days", "hours", "minutes", "seconds")):
        days = int(m.group("days") or 0)
        hours = int(m.group("hours") or 0)
        minutes = int(m.group("minutes") or 0)
        seconds = int(m.group("seconds") or 0)
        return timedelta(days=days, hours=hours, minutes=minutes, seconds=seconds)

    raise ValueError(
        f"invalid duration {raw!r}: expected '<N>(s|m|h|d|w)' "
        "(e.g. '7d', '24h') or ISO-8601 'PnDTnHnMnS' (e.g. 'P7D', 'PT24H')"
    )


def _scale_duration(n: int, unit: str) -> timedelta:
    if unit == "s":
        return timedelta(seconds=n)
    if unit == "m":
        return timedelta(minutes=n)
    if unit == "h":
        return timedelta(hours=n)
    if unit == "d":
        return timedelta(days=n)
    if unit == "w":
        return timedelta(weeks=n)
    raise ValueError(f"unknown duration unit {unit!r}")


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


def validate_scope_rules(rules: Any) -> tuple[list[str], list[str]]:
    """Validate a ``plan.policy.triageScope`` payload.

    Returns ``(errors, warnings)``. ``errors`` is empty on success.

    Validation rules (per #1131 Current Shape Decision 2):

    * The top-level value MUST be a list (omission is fine and is
      handled by :func:`resolve_scope_rules` with the framework default).
    * Each rule MUST be an object with a ``rule`` string discriminator.
    * The discriminator MUST be a member of :data:`VALID_RULE_TYPES`.
    * The ``milestone`` discriminator was deferred from D12 / #1131 to
      D14 / #1133, which shipped the v1 exact-match shape
      (``{name: "<exact-name>"}``). D14b (#1181) added the
      mutually-exclusive ``any-of`` and ``is-open: true`` variants;
      see :mod:`_triage_scope_milestone` for the variant matrix.
    * Per-type field shape is checked (label list, duration string, etc.).
    """
    errors: list[str] = []
    warnings: list[str] = []

    if rules is None:
        # Default behaviour (#1131 Decision 5): unset / missing scope is
        # equivalent to [{"rule": "all-open"}]. Not an error.
        return errors, warnings

    if not isinstance(rules, list):
        errors.append(
            "plan.policy.triageScope must be a list of rule objects; "
            f"got {type(rules).__name__}"
        )
        return errors, warnings

    for i, rule in enumerate(rules):
        prefix = f"plan.policy.triageScope[{i}]"
        if not isinstance(rule, dict):
            errors.append(f"{prefix} must be an object, got {type(rule).__name__}")
            continue
        kind = rule.get("rule")
        if not isinstance(kind, str) or not kind:
            errors.append(f"{prefix}.rule must be a non-empty string")
            continue
        if kind in DEFERRED_RULE_TYPES:
            errors.append(f"{prefix}: {DEFERRED_RULE_TYPES[kind]}")
            continue
        if kind not in VALID_RULE_TYPES:
            errors.append(
                f"{prefix}.rule {kind!r} is not a valid rule type; "
                f"expected one of {sorted(VALID_RULE_TYPES)}"
            )
            continue
        _validate_rule_body(rule, prefix, errors, warnings)

    return errors, warnings


def _validate_rule_body(
    rule: dict[str, Any], prefix: str, errors: list[str], warnings: list[str]
) -> None:
    kind = rule["rule"]
    if kind == "all-open":
        # No parameters; warn if extra keys are present so consumers don't
        # silently lose configuration on a typo.
        extra = sorted(k for k in rule if k != "rule")
        if extra:
            warnings.append(
                f"{prefix}: all-open takes no parameters; ignoring extra keys "
                f"{extra}"
            )
        return

    if kind == "labels":
        any_of = rule.get("any-of")
        all_of = rule.get("all-of")
        if any_of is None and all_of is None:
            errors.append(f"{prefix}.labels requires 'any-of' or 'all-of'")
            return
        if any_of is not None and all_of is not None:
            errors.append(
                f"{prefix}.labels: 'any-of' and 'all-of' are mutually exclusive"
            )
            return
        target = any_of if any_of is not None else all_of
        which = "any-of" if any_of is not None else "all-of"
        if not isinstance(target, list) or not target:
            errors.append(f"{prefix}.labels.{which} must be a non-empty list of strings")
            return
        for j, label in enumerate(target):
            if not isinstance(label, str) or not label:
                errors.append(f"{prefix}.labels.{which}[{j}] must be a non-empty string")
        return

    if kind == "milestone":
        # D14b (#1181) variant matrix lives in _triage_scope_milestone.
        from _triage_scope_milestone import validate_milestone_rule
        validate_milestone_rule(rule, prefix, errors, warnings)
        return

    if kind in {"opened-since", "updated-since"}:
        duration = rule.get("duration")
        if not isinstance(duration, str) or not duration:
            errors.append(f"{prefix}.{kind} requires a non-empty 'duration' string")
            return
        try:
            parse_duration(duration)
        except ValueError as exc:
            errors.append(f"{prefix}.{kind}.duration: {exc}")
        return

    if kind == "referenced-by-vbrief":
        scope = rule.get("scope")
        if scope not in _REFERENCED_BY_VBRIEF_SCOPES:
            errors.append(
                f"{prefix}.referenced-by-vbrief.scope must be one of "
                f"{sorted(_REFERENCED_BY_VBRIEF_SCOPES)}; got {scope!r}"
            )
        return

    if kind == "sliced-from":
        scope = rule.get("scope")
        if scope not in _SLICED_FROM_SCOPES:
            errors.append(
                f"{prefix}.sliced-from.scope must be one of "
                f"{sorted(_SLICED_FROM_SCOPES)}; got {scope!r}"
            )
        return

    if kind == "explicit-watch":
        issues = rule.get("issues")
        if not isinstance(issues, list) or not issues:
            errors.append(
                f"{prefix}.explicit-watch.issues must be a non-empty list of "
                "{n: <int>, note: <str>} objects"
            )
            return
        for j, entry in enumerate(issues):
            if not isinstance(entry, dict):
                errors.append(
                    f"{prefix}.explicit-watch.issues[{j}] must be an object, "
                    f"got {type(entry).__name__}"
                )
                continue
            n = entry.get("n")
            note = entry.get("note")
            if not isinstance(n, int) or isinstance(n, bool) or n <= 0:
                errors.append(
                    f"{prefix}.explicit-watch.issues[{j}].n must be a positive integer"
                )
            if not isinstance(note, str) or not note.strip():
                errors.append(
                    f"{prefix}.explicit-watch.issues[{j}].note must be a non-empty string "
                    "(Decision 4: per-issue note required for future-operator legibility)"
                )
        return


# ---------------------------------------------------------------------------
# Rule normalisation + subscription hash
# ---------------------------------------------------------------------------


def normalize_scope_rules(rules: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a stable canonical-ordered copy of ``rules``.

    Used as the input to :func:`subscription_hash` so two rule sets that
    differ only in key ordering or list ordering hash to the same digest.

    Normalisation is intentionally shallow:

    * Each rule object's keys are sorted alphabetically.
    * For ``labels.any-of`` / ``labels.all-of`` the value list is sorted
      (label order is semantically irrelevant).
    * For ``explicit-watch.issues`` the list is sorted by ``n`` (per-issue
      order is also irrelevant).
    * The top-level list of rules is sorted by a stable serialisation of
      each normalised rule.
    """
    normalised: list[dict[str, Any]] = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        n_rule: dict[str, Any] = {}
        for key in sorted(rule):
            value = rule[key]
            if (
                rule.get("rule") == "labels"
                and key in {"any-of", "all-of"}
                and isinstance(value, list)
            ):
                value = sorted(value)
            elif (
                rule.get("rule") == "explicit-watch"
                and key == "issues"
                and isinstance(value, list)
            ):
                value = sorted(
                    (
                        {k: v[k] for k in sorted(v)}
                        for v in value
                        if isinstance(v, dict)
                    ),
                    key=lambda v: v.get("n", 0),
                )
            n_rule[key] = value
        normalised.append(n_rule)
    return sorted(normalised, key=lambda r: json.dumps(r, sort_keys=True))


def subscription_hash(rules: Iterable[dict[str, Any]]) -> str:
    """Return a stable canonical-JSON SHA-256 digest of ``rules``.

    Truncated to :data:`SUBSCRIPTION_HASH_LEN` hex chars. The hash is
    used as the coverage-denominator cache key so subscription changes
    invalidate the cached count automatically.
    """
    canonical = json.dumps(
        normalize_scope_rules(rules), sort_keys=True, separators=(",", ":")
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return digest[:SUBSCRIPTION_HASH_LEN]


# ---------------------------------------------------------------------------
# Resolve scope from PROJECT-DEFINITION
# ---------------------------------------------------------------------------


def project_definition_path(project_root: Path | None = None) -> Path:
    root = project_root or Path.cwd()
    return root / PROJECT_DEFINITION_REL_PATH


def _load_project_definition(project_root: Path | None = None) -> dict[str, Any] | None:
    path = project_definition_path(project_root)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def resolve_scope_rules(
    project_root: Path | None = None,
    *,
    project_definition: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Resolve the effective ``plan.policy.triageScope`` rule list.

    Resolution order (#1131 Decision 5):

    1. If a non-empty list is set on ``plan.policy.triageScope``, return
       its normalised copy.
    2. Otherwise (unset / missing / non-list), return the framework
       default ``[{"rule": "all-open"}]``.

    Note: an EMPTY list (``[]``) is treated as unset too, so consumers
    who clear the field accidentally still get the safe default rather
    than a silently-empty subscription. Schema validation surfaces empty
    lists as a warning so the operator can opt back into ``all-open``
    explicitly if desired.
    """
    data = project_definition if project_definition is not None else _load_project_definition(
        project_root
    )
    if not isinstance(data, dict):
        return [dict(r) for r in DEFAULT_TRIAGE_SCOPE]
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return [dict(r) for r in DEFAULT_TRIAGE_SCOPE]
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return [dict(r) for r in DEFAULT_TRIAGE_SCOPE]
    scope = policy.get("triageScope")
    if not isinstance(scope, list) or not scope:
        return [dict(r) for r in DEFAULT_TRIAGE_SCOPE]
    return [dict(r) for r in scope if isinstance(r, dict)] or [
        dict(r) for r in DEFAULT_TRIAGE_SCOPE
    ]


# ---------------------------------------------------------------------------
# Rule evaluators
# ---------------------------------------------------------------------------


def evaluate_rules(
    rules: Iterable[dict[str, Any]],
    issues: Iterable[dict[str, Any]],
    *,
    now: datetime | None = None,
    vbrief_referenced: set[int] | None = None,
    vbrief_active_referenced: set[int] | None = None,
    umbrella_slices: set[int] | None = None,
    open_milestones_fetcher: Any = None,
    repo: str | None = None,
) -> list[dict[str, Any]]:
    """Apply ``rules`` to ``issues`` and return the union of matches.

    Each issue is a dict with at minimum the following fields (a subset
    of the GitHub REST ``issues`` payload):

    * ``number``: int
    * ``state``: "open" | "closed"
    * ``labels``: list of ``{"name": str}`` or list of label strings
    * ``created_at``: ISO-8601 timestamp (optional)
    * ``updated_at``: ISO-8601 timestamp (optional)

    Auxiliary inputs:

    * ``vbrief_referenced``: set of issue numbers referenced by ANY scope
      vBRIEF (proposed/pending/active/completed/cancelled) -- consumed
      by the ``referenced-by-vbrief`` rule with ``scope="any"``.
    * ``vbrief_active_referenced``: same but limited to ``active/``
      vBRIEFs.
    * ``umbrella_slices``: set of issue numbers sliced from any cached
      umbrella -- consumed by the ``sliced-from`` rule.
    * ``open_milestones_fetcher`` / ``repo``: D14b (#1181) inputs for
      the ``milestone {is-open: true}`` variant. The fetcher is a
      ``Callable[[], set[str]]`` invoked AT MOST ONCE per call
      (memoized); see :mod:`_triage_scope_milestone` for the default
      ``gh api ... /milestones?state=open`` fallback + repo inference.

    A nil rule set returns the framework default behaviour (all open
    issues). Multiple rules union their matched sets.
    """
    rule_list = list(rules) or [dict(r) for r in DEFAULT_TRIAGE_SCOPE]
    issue_list = list(issues)
    now_dt = now or _utc_now()
    matched: dict[int, dict[str, Any]] = {}

    # D14b (#1181) is-open snapshot resolver -- memoized once per call.
    from _triage_scope_milestone import make_open_milestones_resolver
    _resolve_open_milestones = make_open_milestones_resolver(
        open_milestones_fetcher, issue_list, repo
    )

    for rule in rule_list:
        if not isinstance(rule, dict):
            continue
        kind = rule.get("rule")
        if kind == "all-open":
            for issue in issue_list:
                if _is_open(issue):
                    matched.setdefault(_issue_number(issue), issue)
        elif kind == "labels":
            wanted_any = rule.get("any-of")
            wanted_all = rule.get("all-of")
            for issue in issue_list:
                if not _is_open(issue):
                    continue
                names = _label_names(issue)
                hit_any = (
                    wanted_any is not None
                    and any(label in names for label in wanted_any)
                )
                hit_all = (
                    wanted_all is not None
                    and all(label in names for label in wanted_all)
                )
                if hit_any or hit_all:
                    matched.setdefault(_issue_number(issue), issue)
        elif kind == "opened-since":
            cutoff = now_dt - parse_duration(rule["duration"])
            for issue in issue_list:
                if _is_open(issue) and _ts_after(issue.get("created_at"), cutoff):
                    matched.setdefault(_issue_number(issue), issue)
        elif kind == "updated-since":
            cutoff = now_dt - parse_duration(rule["duration"])
            for issue in issue_list:
                if _is_open(issue) and _ts_after(issue.get("updated_at"), cutoff):
                    matched.setdefault(_issue_number(issue), issue)
        elif kind == "referenced-by-vbrief":
            scope = rule.get("scope", "any")
            ref_set = (
                vbrief_active_referenced
                if scope == "active"
                else vbrief_referenced
            ) or set()
            for issue in issue_list:
                n = _issue_number(issue)
                if _is_open(issue) and n in ref_set:
                    matched.setdefault(n, issue)
        elif kind == "sliced-from":
            slices = umbrella_slices or set()
            for issue in issue_list:
                n = _issue_number(issue)
                if _is_open(issue) and n in slices:
                    matched.setdefault(n, issue)
        elif kind == "explicit-watch":
            pinned = {
                e.get("n")
                for e in rule.get("issues", [])
                if isinstance(e, dict) and isinstance(e.get("n"), int)
            }
            for issue in issue_list:
                n = _issue_number(issue)
                if n in pinned:
                    matched.setdefault(n, issue)
        elif kind == "milestone":
            # D14 (#1133) + D14b (#1181) variants delegated to sidecar.
            from _triage_scope_milestone import evaluate_milestone_rule_into
            evaluate_milestone_rule_into(
                rule,
                issue_list,
                matched,
                get_open_milestones=_resolve_open_milestones,
                is_open_issue=_is_open,
                issue_number=_issue_number,
                milestone_name=_milestone_name,
            )

    return [matched[k] for k in sorted(matched)]


def _is_open(issue: dict[str, Any]) -> bool:
    return issue.get("state", "open") == "open"


def _issue_number(issue: dict[str, Any]) -> int:
    n = issue.get("number")
    return int(n) if isinstance(n, int) else 0


def _label_names(issue: dict[str, Any]) -> set[str]:
    raw = issue.get("labels", [])
    names: set[str] = set()
    if not isinstance(raw, list):
        return names
    for item in raw:
        if isinstance(item, dict):
            name = item.get("name")
            if isinstance(name, str):
                names.add(name)
        elif isinstance(item, str):
            names.add(item)
    return names


def _milestone_name(issue: dict[str, Any]) -> str:
    """Return the issue's milestone title (empty string when absent).

    The GitHub REST issues payload shapes milestone info as
    ``{ "title": <str>, ... }``; some upstreams or test fixtures pass
    bare strings or a ``name`` alias. Tolerant of all three shapes;
    returns ``""`` (never ``None``) so downstream equality checks stay
    type-safe.
    """
    raw = issue.get("milestone")
    if isinstance(raw, dict):
        title = raw.get("title")
        if isinstance(title, str):
            return title
        alt = raw.get("name")
        if isinstance(alt, str):
            return alt
        return ""
    if isinstance(raw, str):
        return raw
    return ""


def _ts_after(stamp: Any, cutoff: datetime) -> bool:
    if not isinstance(stamp, str) or not stamp:
        return False
    try:
        dt = _parse_iso(stamp)
    except (ValueError, TypeError):
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt >= cutoff


# ---------------------------------------------------------------------------
# Coverage denominator cache
# ---------------------------------------------------------------------------


def coverage_path(
    source: str,
    repo: str,
    *,
    project_root: Path | None = None,
    cache_root: Path | None = None,
) -> Path:
    """Return the ``coverage.json`` path for ``<source>/<repo>``."""
    if "/" not in repo:
        raise ValueError(f"repo must be 'owner/name'; got {repo!r}")
    root = cache_root
    if root is None:
        root = (project_root or Path.cwd()) / CACHE_DIR_NAME
    owner, name = repo.split("/", 1)
    return Path(root) / source / owner / name / COVERAGE_FILENAME


def coverage_ttl_hours() -> int:
    """Return the configured TTL (env-overridable, defaults to 24)."""
    raw = os.environ.get(ENV_COVERAGE_TTL_HOURS, "")
    if not raw:
        return DEFAULT_COVERAGE_TTL_HOURS
    try:
        value = int(raw)
        if value < 0:
            raise ValueError
        return value
    except ValueError:
        return DEFAULT_COVERAGE_TTL_HOURS


def write_coverage_denominator(
    path: Path,
    *,
    count: int,
    subscription_hash_value: str,
    fetched_at: datetime | None = None,
) -> CoverageRecord:
    """Write the denominator record at ``path`` and return it.

    Recompute trigger callers (``triage:bootstrap``,
    ``triage:scope --refresh-denominator``, subscription-hash change)
    invoke this. The path's parent directories are created on demand
    so first-write does not require a pre-existing cache layout.
    """
    if count < 0:
        raise ValueError(f"count must be >= 0; got {count}")
    if not subscription_hash_value:
        raise ValueError("subscription_hash_value must be a non-empty string")
    stamp = _utc_iso(fetched_at)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "count": int(count),
        "fetched_at": stamp,
        "subscription_hash": subscription_hash_value,
    }
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    return CoverageRecord(
        count=int(count),
        fetched_at=stamp,
        subscription_hash=subscription_hash_value,
        stale=False,
        age_hours=0.0,
    )


def read_coverage_denominator(
    path: Path,
    *,
    current_hash: str,
    ttl_hours: int | None = None,
    now: datetime | None = None,
) -> CoverageRecord | None:
    """Read the denominator record at ``path``.

    Returns ``None`` when the file does not exist or is malformed --
    callers MUST treat that as a cache miss and render ``?``.

    Returns a :class:`CoverageRecord` with ``stale=True`` when EITHER
    the TTL has elapsed OR the stored ``subscription_hash`` mismatches
    ``current_hash``. Reads NEVER trigger a recompute (Decision 3); the
    record is returned so callers can decide whether to display the
    cached count or fall back to ``?``.
    """
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    count = data.get("count")
    fetched_at = data.get("fetched_at")
    stored_hash = data.get("subscription_hash")
    if not isinstance(count, int) or count < 0:
        return None
    if not isinstance(fetched_at, str) or not fetched_at:
        return None
    if not isinstance(stored_hash, str) or not stored_hash:
        return None

    effective_ttl = coverage_ttl_hours() if ttl_hours is None else max(0, int(ttl_hours))
    now_dt = now or _utc_now()
    try:
        fetched_dt = _parse_iso(fetched_at)
        if fetched_dt.tzinfo is None:
            fetched_dt = fetched_dt.replace(tzinfo=UTC)
    except (ValueError, TypeError):
        return None
    age_seconds = max(0.0, (now_dt - fetched_dt).total_seconds())
    age_hours = age_seconds / 3600.0
    ttl_stale = effective_ttl > 0 and age_hours > effective_ttl
    hash_stale = stored_hash != current_hash

    return CoverageRecord(
        count=count,
        fetched_at=fetched_at,
        subscription_hash=stored_hash,
        stale=bool(ttl_stale or hash_stale),
        age_hours=age_hours,
    )


def format_coverage_display(
    numerator: int, record: CoverageRecord | None
) -> str:
    """Return ``"<num>/<denom>"`` or ``"<num>/?"`` per Decision 3.

    Stale records (``record.stale=True``) and missing records both
    surface as ``?`` -- the literal question mark is the contractual
    surface for ``triage:summary`` / ``triage:scope`` read paths so
    operators see immediately that the denominator is not authoritative.
    """
    if record is None or record.stale:
        return f"{numerator}/?"
    return f"{numerator}/{record.count}"


# ---------------------------------------------------------------------------
# vBRIEF reference helper + --list renderer (D14 / #1133 split)
# ---------------------------------------------------------------------------
#
# The implementations live in ``scripts/_triage_scope_renderers.py`` to
# keep this module under the 1000-line MUST cap from ``coding/coding.md``
# after D14 (#1133) added the milestone rule type + ignore-list
# surface. Re-exported here so existing call sites and tests that
# ``import triage_scope`` keep working unchanged.

from _triage_scope_renderers import (  # noqa: E402,F401,I001
    extract_referenced_issues,
    _render_rule,
)
from _triage_scope_renderers import render_list as _render_list_impl  # noqa: E402,I001


def render_list(
    rules: Iterable[dict[str, Any]],
    *,
    project_root: Path | None = None,
    is_default: bool = False,
) -> str:
    """Re-export wrapper around :func:`_triage_scope_renderers.render_list`.

    Threads :func:`subscription_hash` through as the hash callable so the
    renderer module does not need to import this module back (which
    would create a circular import). All other args pass through verbatim.
    """
    return _render_list_impl(
        rules,
        subscription_hash_fn=subscription_hash,
        project_root=project_root,
        is_default=is_default,
    )


# ---------------------------------------------------------------------------
# CLI shim helpers + entry point
# ---------------------------------------------------------------------------
#
# The argparse setup + command dispatcher live in ``scripts/_triage_scope_cli.py``
# so this module stays under the 1000-line MUST cap from ``coding/coding.md``.
# The helpers below are the small predicates the CLI calls back into; they
# are kept here because tests in ``tests/test_triage_scope.py`` reference
# them directly.


def _is_default_applied(data: dict[str, Any] | None) -> bool:
    """True when ``plan.policy.triageScope`` is unset / non-list / empty."""
    if not isinstance(data, dict):
        return True
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return True
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return True
    scope = policy.get("triageScope")
    return bool(not isinstance(scope, list) or not scope)


def _get_raw_scope(data: dict[str, Any] | None) -> Any:
    """Return the raw ``plan.policy.triageScope`` payload (untyped)."""
    if not isinstance(data, dict):
        return None
    plan = data.get("plan")
    if not isinstance(plan, dict):
        return None
    policy = plan.get("policy")
    if not isinstance(policy, dict):
        return None
    return policy.get("triageScope")


def validate_triage_scope_on_plan(plan: Any, filepath: Any) -> list[str]:
    """vbrief_validate hook: validate ``plan.policy.triageScope`` (#1131).

    Returns formatted error strings prefixed with ``<filepath>:`` so
    ``vbrief_validate.validate_project_definition`` can splice them into
    its existing error list without re-formatting. An unset / missing
    scope returns an empty list (default behaviour per Decision 5).
    """
    out: list[str] = []
    policy = plan.get("policy") if isinstance(plan, dict) else None
    raw_scope = policy.get("triageScope") if isinstance(policy, dict) else None
    if raw_scope is None:
        return out
    errors, _warnings = validate_scope_rules(raw_scope)
    for err in errors:
        out.append(f"{filepath}: {err} (#1131)")
    return out


# ---------------------------------------------------------------------------
# D14 / #1133: typed ``plan.policy.triageScopeIgnores[]`` foundation.
# ---------------------------------------------------------------------------
#
# Validator + resolver + vbrief_validate hook live in
# ``scripts/_triage_scope_ignores.py`` so this module stays under the
# 1000-line MUST cap. Re-exported here for existing call sites.

from _triage_scope_ignores import (  # noqa: E402,F401,I001
    validate_scope_ignores,
    resolve_scope_ignores,
    validate_triage_scope_ignores_on_plan,
)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Delegates to :mod:`_triage_scope_cli`."""
    import sys as _sys

    # N10 (#1150): structured --help via scripts/triage_help.REGISTRY.
    from triage_help import intercept_help

    rc = intercept_help("triage_scope", argv)
    if rc is not None:
        return rc

    from _triage_scope_cli import run_cli  # local import: 1000-line cap

    return run_cli(argv, _sys.modules[__name__])


if __name__ == "__main__":
    sys.exit(main())
