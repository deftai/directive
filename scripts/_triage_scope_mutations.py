"""``task triage:scope`` wrapper-verb helpers (D14c / #1182).

Provides programmatic helpers consumed by ``scripts/_triage_scope_cli.py``
for the long-tail tuning surface that wraps the typed-policy edit so
the operator doesn't hand-edit ``vbrief/PROJECT-DEFINITION.vbrief.json``:

* :func:`add_label_to_scope` -- delegate to
  ``triage_subscribe.subscribe(label=...)`` (idempotent; merges into an
  existing labels.any-of rule when present; atomic; audit-logged).
* :func:`add_milestone_to_scope` -- delegate to
  ``triage_subscribe.subscribe(milestone=...)`` (idempotent; atomic;
  audit-logged).
* :func:`add_label_to_ignores` -- delegate to
  ``triage_scope_drift.add_ignore(label=...)`` (idempotent; atomic;
  audit-logged since D14c).
* :func:`compute_diff_from_upstream` -- read-only partition of an
  upstream label / milestone set into ``subscribed / ignored / neither``.
  Test-injectable via the ``upstream_labels`` / ``upstream_milestones``
  kwargs so the unit tests do not need network access.
* :func:`fetch_upstream_labels_and_milestones` -- ``gh api`` fetcher
  used by the CLI when no test-injection happens. Pure REST (per
  ``templates/agent-prompt-preamble.md`` §5); no GraphQL.

Kept in a sibling module to ``scripts/triage_scope.py`` so the parent
module stays under the 1000-line MUST cap from ``coding/coding.md``.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Mutation verb wrappers
# ---------------------------------------------------------------------------


def add_label_to_scope(
    project_root: Path,
    label: str,
    *,
    actor: str | None = None,
) -> tuple[bool, str]:
    """``task triage:scope -- --add-label=<L>`` -- delegate to subscribe()."""
    if not isinstance(label, str) or not label.strip():
        raise ValueError(f"label must be a non-empty string; got {label!r}")
    from triage_subscribe import subscribe

    return subscribe(project_root, label=label, actor=actor)


def add_milestone_to_scope(
    project_root: Path,
    milestone: str,
    *,
    actor: str | None = None,
) -> tuple[bool, str]:
    """``task triage:scope -- --add-milestone=<M>`` -- delegate to subscribe()."""
    if not isinstance(milestone, str) or not milestone.strip():
        raise ValueError(f"milestone must be a non-empty string; got {milestone!r}")
    from triage_subscribe import subscribe

    return subscribe(project_root, milestone=milestone, actor=actor)


def add_label_to_ignores(
    project_root: Path,
    label: str,
) -> tuple[bool, str]:
    """``task triage:scope -- --ignore-label=<L>`` -- delegate to add_ignore().

    The older ``task triage:scope-drift -- --ignore-label`` continues to
    work as an alias for the same typed field; both surfaces call into
    :func:`triage_scope_drift.add_ignore` and so share the audit-log
    contract introduced in D14c (#1182).
    """
    if not isinstance(label, str) or not label.strip():
        raise ValueError(f"label must be a non-empty string; got {label!r}")
    from triage_scope_drift import add_ignore

    return add_ignore(project_root, label=label)


# ---------------------------------------------------------------------------
# --diff-from-upstream report
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DiffReport:
    """Partition of an upstream label / milestone set vs typed policy.

    Each set captures the names that fall into one of three buckets:

    * ``subscribed`` -- the name appears in ``plan.policy.triageScope[]``
      (any-of / all-of / milestone-rule)
    * ``ignored`` -- the name appears in
      ``plan.policy.triageScopeIgnores[]`` (label / milestone single-key
      or rule-shaped author entries)
    * ``neither`` -- the name appears upstream but neither in scope nor
      in ignores; this is the operator's TODO list ("decide -- subscribe
      or ignore?").

    Fields are ``frozenset[str]`` to honour the ``frozen=True`` dataclass
    contract -- mutable ``set`` fields on a frozen dataclass are a
    documented footgun (the wrapper is hashable, the fields are not).
    """

    subscribed_labels: frozenset[str] = field(default_factory=frozenset)
    ignored_labels: frozenset[str] = field(default_factory=frozenset)
    neither_labels: frozenset[str] = field(default_factory=frozenset)
    subscribed_milestones: frozenset[str] = field(default_factory=frozenset)
    ignored_milestones: frozenset[str] = field(default_factory=frozenset)
    neither_milestones: frozenset[str] = field(default_factory=frozenset)
    repo: str = ""


def compute_diff_from_upstream(
    project_root: Path,
    *,
    upstream_labels: set[str],
    upstream_milestones: set[str],
    repo: str = "",
) -> DiffReport:
    """Partition upstream labels / milestones into subscribed / ignored / neither.

    Pure: never mutates state. Inputs are injected so unit tests can
    skip network access. The CLI invokes
    :func:`fetch_upstream_labels_and_milestones` to populate them.
    """
    from triage_scope import resolve_scope_ignores, resolve_scope_rules
    from triage_scope_drift import _subscribed_labels, _subscribed_milestones

    rules = resolve_scope_rules(project_root)
    ignores = resolve_scope_ignores(project_root)

    sub_labels = _subscribed_labels(rules)
    sub_ms = _subscribed_milestones(rules)
    ign_labels = ignores.get("labels", set())
    ign_ms = ignores.get("milestones", set())

    subscribed_labels: set[str] = set()
    ignored_labels: set[str] = set()
    neither_labels: set[str] = set()
    for name in upstream_labels:
        if not isinstance(name, str) or not name:
            continue
        if name in sub_labels:
            subscribed_labels.add(name)
        elif name in ign_labels:
            ignored_labels.add(name)
        else:
            neither_labels.add(name)

    subscribed_milestones: set[str] = set()
    ignored_milestones: set[str] = set()
    neither_milestones: set[str] = set()
    for name in upstream_milestones:
        if not isinstance(name, str) or not name:
            continue
        if name in sub_ms:
            subscribed_milestones.add(name)
        elif name in ign_ms:
            ignored_milestones.add(name)
        else:
            neither_milestones.add(name)

    return DiffReport(
        subscribed_labels=frozenset(subscribed_labels),
        ignored_labels=frozenset(ignored_labels),
        neither_labels=frozenset(neither_labels),
        subscribed_milestones=frozenset(subscribed_milestones),
        ignored_milestones=frozenset(ignored_milestones),
        neither_milestones=frozenset(neither_milestones),
        repo=repo,
    )


def render_diff_report(report: DiffReport) -> str:
    """Render a :class:`DiffReport` as a human-readable text block.

    Format::

        triage:scope --diff-from-upstream (repo: deftai/directive)
        Labels:
          subscribed (1): bug
          ignored    (1): wontfix
          neither    (2): adoption-blocker, urgent
        Milestones:
          subscribed (0): -
          ignored    (0): -
          neither    (1): v2.0-blocker
    """

    def _fmt(bucket: frozenset[str]) -> str:
        if not bucket:
            return "-"
        return ", ".join(sorted(bucket))

    lines: list[str] = []
    repo_suffix = f" (repo: {report.repo})" if report.repo else ""
    lines.append(f"triage:scope --diff-from-upstream{repo_suffix}")
    lines.append("Labels:")
    lines.append(
        f"  subscribed ({len(report.subscribed_labels)}): {_fmt(report.subscribed_labels)}"
    )
    lines.append(
        f"  ignored    ({len(report.ignored_labels)}): {_fmt(report.ignored_labels)}"
    )
    lines.append(
        f"  neither    ({len(report.neither_labels)}): {_fmt(report.neither_labels)}"
    )
    lines.append("Milestones:")
    lines.append(
        f"  subscribed ({len(report.subscribed_milestones)}): "
        f"{_fmt(report.subscribed_milestones)}"
    )
    lines.append(
        f"  ignored    ({len(report.ignored_milestones)}): "
        f"{_fmt(report.ignored_milestones)}"
    )
    lines.append(
        f"  neither    ({len(report.neither_milestones)}): "
        f"{_fmt(report.neither_milestones)}"
    )
    if report.neither_labels or report.neither_milestones:
        lines.append("")
        lines.append(
            "To act on 'neither' items: task triage:scope -- --add-label=<L> / "
            "--add-milestone=<M> / --ignore-label=<L>"
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Upstream fetcher (gh REST)
# ---------------------------------------------------------------------------


def fetch_upstream_labels_and_milestones(
    repo: str,
    *,
    binary: str = "gh",
) -> tuple[set[str], set[str]]:
    """Fetch upstream open milestones + every label name via ``gh api`` (REST).

    Two ``gh api`` calls (paginated REST per
    ``templates/agent-prompt-preamble.md`` §5 -- never GraphQL). Returns
    ``(labels, milestones)`` as string sets.

    Raises :class:`RuntimeError` when ``gh`` is unavailable, the repo is
    malformed, or the upstream returns non-list payloads. Callers should
    catch and surface a human-readable error.
    """
    if not isinstance(repo, str) or "/" not in repo:
        raise RuntimeError(
            f"--repo must be 'owner/name'; got {repo!r}. Pass --repo OR set "
            "$DEFT_TRIAGE_REPO."
        )

    labels = _fetch_names_via_gh(
        binary,
        f"repos/{repo}/labels?per_page=100",
        name_field="name",
    )
    milestones = _fetch_names_via_gh(
        binary,
        f"repos/{repo}/milestones?per_page=100&state=open",
        name_field="title",
    )
    return labels, milestones


def _fetch_names_via_gh(binary: str, path: str, *, name_field: str) -> set[str]:
    try:
        proc = subprocess.run(  # noqa: S603 -- intentional gh invocation
            [binary, "api", "--paginate", path],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"`{binary}` not found on PATH -- install GitHub CLI to use "
            "`task triage:scope -- --diff-from-upstream`."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"`{binary} api {path}` timed out after 30s -- check your network."
        ) from exc

    if proc.returncode != 0:
        raise RuntimeError(
            f"`{binary} api {path}` failed (exit {proc.returncode}): "
            f"{proc.stderr.strip() or proc.stdout.strip()}"
        )

    out = proc.stdout.strip()
    if not out:
        return set()
    # `gh api --paginate` concatenates JSON arrays; the result is either
    # a single array or several arrays concatenated. We tolerate both
    # shapes (array-of-objects, or whitespace-separated arrays) by
    # parsing one JSON document at a time via a streaming decoder.
    decoder = json.JSONDecoder()
    idx = 0
    names: set[str] = set()
    text = out
    while idx < len(text):
        # Skip leading whitespace between concatenated documents.
        while idx < len(text) and text[idx].isspace():
            idx += 1
        if idx >= len(text):
            break
        try:
            obj, consumed = decoder.raw_decode(text, idx)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"`{binary} api {path}` returned non-JSON output: {exc}"
            ) from exc
        idx = consumed
        if not isinstance(obj, list):
            raise RuntimeError(
                f"`{binary} api {path}` returned a non-list payload "
                f"({type(obj).__name__}); REST expected."
            )
        for item in obj:
            if not isinstance(item, dict):
                continue
            value = item.get(name_field)
            if isinstance(value, str) and value:
                names.add(value)
    return names
