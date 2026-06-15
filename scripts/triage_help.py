# ruff: noqa: E501  -- registry literal carries long usage/example strings
# that are easier to read on one line than wrapped. The 100-char ceiling is
# enforced everywhere else in this file (it is the rest of the codebase's
# default); the registry block is the documented exception.
"""triage_help.py -- categorized verb-help surface (#1150 / N10).

This module is the single source of truth for the *user-facing* help text
of every ``triage:*`` and ``scope:*`` task. It powers three surfaces:

1. ``task triage`` (bare invocation) -- categorized verb list grouped by
   role (Session-start / State verbs / Read verbs / Lifecycle /
   Subscription mutation / Archive-rotation).
2. ``task scope`` (bare invocation) -- categorized verb list grouped by
   role (Promote / demote, Activate / complete, Reversibility).
3. ``<verb> --help`` -- structured per-verb help with description,
   flags + defaults, 2-3 examples and cross-references to related verbs
   + umbrella children. Verb scripts call :func:`intercept_help` early
   in ``main()`` so the structured renderer wins over argparse default.

Adding a new ``triage:*`` / ``scope:*`` verb is one dict-insert under
:data:`REGISTRY` plus a single entry in :data:`CATEGORIES_TRIAGE` or
:data:`CATEGORIES_SCOPE`. See ``CONTRIBUTING.md`` § "Adding a new
triage / scope verb" for the contributor walkthrough.

Forward-looking placeholders ("coming in <child>") are intentionally
listed for D17 (metrics) / D19 (archive rotation) / D20 (audit-log
rotation) so the verb-space catalog is stable across the umbrella's
remaining children -- a fresh contributor sees the *shape* of the
surface even when a verb has not yet landed.

Programmatic API
----------------

* :class:`VerbHelp` -- frozen registry entry shape.
* :data:`REGISTRY` -- ``{verb_name: VerbHelp}`` lookup.
* :data:`CATEGORIES_TRIAGE` / :data:`CATEGORIES_SCOPE` -- ordered
  ``[(category_label, [verb_names])]`` for the bare-list renderers.
* :data:`SCRIPT_SUBCOMMAND_MAP` -- ``{script_module: {subcommand: verb}}``
  used by :func:`intercept_help` to resolve a verb from argv at runtime.
* :func:`render_category_list` -- pure text renderer for the bare
  invocation surface.
* :func:`render_verb_help` -- pure text renderer for the ``--help``
  surface.
* :func:`intercept_help` -- ``main()`` shim that prints structured help
  and returns ``0`` when ``--help`` / ``-h`` is in ``argv``; returns
  ``None`` otherwise.

CLI
---

``python -m scripts.triage_help <category>`` prints the bare-list for
``triage`` or ``scope``. ``python -m scripts.triage_help help <verb>``
prints the structured per-verb help. ``python -m scripts.triage_help
list`` dumps every registered verb for tooling discovery.

Refs
----

* Umbrella: #1119.
* This child: #1150 / N10.
* Reciprocal child for ``task slice:record-existing``: #1147 / N7 (verb
  space outside the triage/scope namespaces; intentionally NOT
  registered here so the registry boundary stays sharp).
"""

from __future__ import annotations

import contextlib
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field

# UTF-8 self-reconfigure -- the help renderer prints arrows / em-dashes
# / ⚠ glyphs that cp1252 cannot encode (#814).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        with contextlib.suppress(AttributeError, ValueError):
            _stream.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Registry data shape
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerbHelp:
    """Structured help metadata for a single ``triage:*`` / ``scope:*`` verb.

    Attributes
    ----------
    name:
        Canonical verb name as the user invokes it (``triage:queue``,
        ``scope:promote``). Matches the Taskfile task name.
    summary:
        One-line description used in the bare-list category renderer.
        Keep <= 70 chars so the category list stays scannable.
    refs:
        Bracketed cross-ref tag printed alongside ``summary`` in the
        category renderer (e.g. ``"(D11)"`` or ``"(D19, coming)"``).
    description:
        Full prose description printed as the first paragraph of the
        ``--help`` surface. May be multi-line.
    usage:
        Synopsis line (e.g.
        ``"task triage:queue [--limit=N] [--state=<filter>]"``).
    flags:
        List of ``(flag, default, description)`` triples. ``default``
        is rendered verbatim -- use ``"(required)"`` for required
        flags, ``"(none)"`` for unset defaults.
    examples:
        2-3 example invocations. Rendered as a fenced indented block.
    see_also:
        Verb names and umbrella-child references to surface at the
        bottom of the ``--help`` output. Use plain verb names
        (``"task triage:show"``) or umbrella IDs (``"#1119 / D11"``).
    placeholder:
        True for not-yet-landed verbs (e.g. D17 metrics / D19 archive
        rotation). The renderer adds a ``"(not yet implemented)"``
        note so the operator knows the verb is forward-looking.
    """

    name: str
    summary: str
    refs: str
    description: str
    usage: str
    flags: Sequence[tuple[str, str, str]] = field(default_factory=tuple)
    examples: Sequence[str] = field(default_factory=tuple)
    see_also: Sequence[str] = field(default_factory=tuple)
    placeholder: bool = False


# ---------------------------------------------------------------------------
# Registry -- single source of truth for every triage:* / scope:* verb
# ---------------------------------------------------------------------------


def _entry(*args, **kwargs) -> VerbHelp:
    """Convenience constructor so the registry literal stays compact."""
    return VerbHelp(*args, **kwargs)


REGISTRY: dict[str, VerbHelp] = {
    # --- Session-start cross-namespace surfaces --------------------------
    "task triage:summary": _entry(
        name="task triage:summary",
        summary="One-line state for session-start ritual",
        refs="(D2 / #1122)",
        description=(
            "Emit the one-line triage state consumed by the session-start "
            "ritual. Always exits 0 (status surface, not a gate); appends "
            "a JSONL record to vbrief/.eval/summary-history.jsonl for "
            "observability."
        ),
        usage="task triage:summary [-- --json] [--no-history]",
        flags=(
            ("--json", "(off)", "Emit the structured record as JSON instead of the one-liner."),
            ("--no-history", "(off)", "Suppress the history sidecar append (test-only)."),
            ("--project-root PATH", "(cwd)", "Project root override (Taskfile threads USER_WORKING_DIR)."),
        ),
        examples=(
            "task triage:summary",
            "task triage:summary -- --json | jq",
        ),
        see_also=(
            "task triage:queue",
            "task verify:cache-fresh",
            "#1119 / D2",
        ),
    ),
    "task verify:cache-fresh": _entry(
        name="task verify:cache-fresh",
        summary="Pre-start_agent freshness gate",
        refs="(D5 / #1127)",
        description=(
            "Detection-bound gate that refuses dispatch when the local "
            "cache is stale or the target issue is outside the active "
            "subscription. Exit 0 = clear, 1 = blocked (stale / outside "
            "scope / wrong decision), 2 = config error (cache missing)."
        ),
        usage="task verify:cache-fresh [-- --for-issue N] [--allow-stale]",
        flags=(
            ("--for-issue N", "(none)", "Gate on a specific upstream issue number."),
            ("--allow-stale", "(off)", "Operator-audited override; logged to stderr."),
        ),
        examples=(
            "task verify:cache-fresh",
            "task verify:cache-fresh -- --for-issue 1150",
        ),
        see_also=(
            "task triage:bootstrap",
            "task cache:fetch-all",
            "#1119 / D5",
        ),
    ),
    # --- State verbs (mutate audit log) ----------------------------------
    "task triage:accept": _entry(
        name="task triage:accept",
        summary="Mark issue accepted; chains into scope:promote w/ flag",
        refs="(D18 / #845)",
        description=(
            "Record an `accept` audit entry against an issue. With the "
            "D18 reciprocity flag, chains into scope:promote --from-issue "
            "so the upstream cache and the vBRIEF lifecycle stay in sync."
        ),
        usage="task triage:accept -- --issue N --repo owner/name [--actor STR]",
        flags=(
            ("--issue N", "(required)", "Issue number."),
            ("--repo owner/name", "(required)", "Upstream repo."),
            ("--actor STR", "(env DEFT_TRIAGE_ACTOR)", "Override the audit actor field."),
        ),
        examples=(
            "task triage:accept -- --issue 42 --repo deftai/directive",
        ),
        see_also=(
            "task triage:status",
            "task scope:promote",
            "#1119 / D18",
        ),
    ),
    "task triage:defer": _entry(
        name="task triage:defer",
        summary="Defer with reason + optional resume-on condition",
        refs="(D3 / #1123)",
        description=(
            "Record a `defer` audit entry against an issue. --reason is "
            "required (replaces free-text defer per D3). --resume-on "
            "accepts the v1 grammar (ref:closed:#N | ref:merged:#N | "
            "date:>=YYYY-MM-DD | pending-count:>=N | pending-count:<=N, "
            "joined by AND/OR)."
        ),
        usage="task triage:defer -- --issue N --repo owner/name --reason 'why' [--resume-on EXPR] [--actor STR]",
        flags=(
            ("--issue N", "(required)", "Issue number."),
            ("--repo owner/name", "(required)", "Upstream repo."),
            ("--reason 'why'", "(required)", "Structured rationale (D3 enforced)."),
            ("--resume-on EXPR", "(none)", "Resume-condition expression."),
            ("--actor STR", "(env DEFT_TRIAGE_ACTOR)", "Override the audit actor field."),
        ),
        examples=(
            "task triage:defer -- --issue 42 --repo deftai/directive --reason 'waiting on upstream'",
            "task triage:defer -- --issue 42 --repo deftai/directive --reason 'needs PR 99' --resume-on 'ref:merged:#99'",
        ),
        see_also=(
            "task triage:status",
            "task triage:history",
            "task triage:bulk-defer",
            "#1119 / D3",
        ),
    ),
    "task triage:reject": _entry(
        name="task triage:reject",
        summary="Close upstream with comment + label",
        refs="(#845)",
        description=(
            "Close the upstream issue, apply the `triage-rejected` label, "
            "and record a `reject` audit entry. Rolls audit back on gh "
            "failure so the cache and upstream stay consistent."
        ),
        usage="task triage:reject -- --issue N --repo owner/name --reason 'why' [--actor STR]",
        flags=(
            ("--issue N", "(required)", "Issue number."),
            ("--repo owner/name", "(required)", "Upstream repo."),
            ("--reason 'why'", "(required)", "Reason recorded on the close comment."),
            ("--actor STR", "(env DEFT_TRIAGE_ACTOR)", "Override the audit actor field."),
        ),
        examples=(
            "task triage:reject -- --issue 42 --repo deftai/directive --reason 'out of scope'",
        ),
        see_also=(
            "task triage:bulk-reject",
            "task triage:reset",
            "#1119 / #845",
        ),
    ),
    "task triage:needs-ac": _entry(
        name="task triage:needs-ac",
        summary="Post comment requesting AC",
        refs="(#845)",
        description=(
            "Mark an issue as needing acceptance criteria and post an "
            "AC-request comment upstream. Records a `needs-ac` audit "
            "entry against the cache."
        ),
        usage="task triage:needs-ac -- --issue N --repo owner/name [--comment STR] [--actor STR]",
        flags=(
            ("--issue N", "(required)", "Issue number."),
            ("--repo owner/name", "(required)", "Upstream repo."),
            ("--comment STR", "(canned)", "Override the AC-request comment text."),
            ("--actor STR", "(env DEFT_TRIAGE_ACTOR)", "Override the audit actor field."),
        ),
        examples=(
            "task triage:needs-ac -- --issue 42 --repo deftai/directive",
        ),
        see_also=(
            "task triage:bulk-needs-ac",
            "task triage:status",
            "#1119 / #845",
        ),
    ),
    "task triage:mark-duplicate": _entry(
        name="task triage:mark-duplicate",
        summary="Link as duplicate of another (validated)",
        refs="(#845)",
        description=(
            "Link an issue as a duplicate of another cached issue. The "
            "target issue must already exist in the unified cache; the "
            "audit entry is rejected otherwise."
        ),
        usage="task triage:mark-duplicate -- --issue N --of M --repo owner/name [--actor STR]",
        flags=(
            ("--issue N", "(required)", "Issue number to mark as duplicate."),
            ("--of M", "(required)", "Canonical issue number (validated against the cache)."),
            ("--repo owner/name", "(required)", "Upstream repo."),
            ("--actor STR", "(env DEFT_TRIAGE_ACTOR)", "Override the audit actor field."),
        ),
        examples=(
            "task triage:mark-duplicate -- --issue 42 --of 17 --repo deftai/directive",
        ),
        see_also=(
            "task triage:history",
            "#1119 / #845",
        ),
    ),
    "task triage:reset": _entry(
        name="task triage:reset",
        summary="Undo prior decision (Layer 5 reversibility)",
        refs="(#845)",
        description=(
            "Append a `reset` audit entry that references the prior "
            "decision. Does NOT delete history -- the audit log is "
            "append-only by design; reset is the supported reversibility "
            "primitive."
        ),
        usage="task triage:reset -- --issue N --repo owner/name [--actor STR]",
        flags=(
            ("--issue N", "(required)", "Issue number."),
            ("--repo owner/name", "(required)", "Upstream repo."),
            ("--actor STR", "(env DEFT_TRIAGE_ACTOR)", "Override the audit actor field."),
        ),
        examples=(
            "task triage:reset -- --issue 42 --repo deftai/directive",
        ),
        see_also=(
            "task triage:history",
            "task scope:undo",
            "#1119 / #845",
        ),
    ),
    "task triage:status": _entry(
        name="task triage:status",
        summary="Print latest triage decision (read-only)",
        refs="(#845)",
        description=(
            "Print the latest triage decision for an issue from the "
            "append-only audit log. Read-only; no mutations, no "
            "subprocess calls."
        ),
        usage="task triage:status -- --issue N --repo owner/name",
        flags=(
            ("--issue N", "(required)", "Issue number."),
            ("--repo owner/name", "(required)", "Upstream repo."),
        ),
        examples=(
            "task triage:status -- --issue 42 --repo deftai/directive",
        ),
        see_also=(
            "task triage:history",
            "task triage:show",
            "#1119 / #845",
        ),
    ),
    "task triage:history": _entry(
        name="task triage:history",
        summary="Print full triage timeline (read-only)",
        refs="(#845)",
        description=(
            "Print the full triage timeline for an issue ordered by "
            "timestamp ascending. Read-only."
        ),
        usage="task triage:history -- --issue N --repo owner/name",
        flags=(
            ("--issue N", "(required)", "Issue number."),
            ("--repo owner/name", "(required)", "Upstream repo."),
        ),
        examples=(
            "task triage:history -- --issue 42 --repo deftai/directive",
        ),
        see_also=(
            "task triage:status",
            "task triage:audit",
            "#1119 / #845",
        ),
    ),
    # --- Read verbs ------------------------------------------------------
    "task triage:queue": _entry(
        name="task triage:queue",
        summary="Ranked candidate list",
        refs="(D11 / #1128)",
        description=(
            "Print the ranked triage queue from the local cache. Groups "
            "(display order): [ORPHAN] -> [RESUME] -> [URGENT] -> untriaged "
            "-> other -> [BLOCKED]. Within-group default = updated_at desc; "
            "consumer plan.policy.triageRankingLabels[] re-orders within-group "
            "by matched-label declared order. Items whose linked vBRIEF is "
            "blocked (status:blocked / unresolved depends_on) are demoted into "
            "[BLOCKED] unless --include-blocked is passed (#1286)."
        ),
        usage="task triage:queue [-- --limit=N] [--include-blocked] [--repo=owner/name]",
        flags=(
            ("--limit N", "10", "Max rows to print."),
            ("--include-blocked", "(off)", "Re-surface blocked items into their natural group (#1286)."),
            ("--repo owner/name", "(git remote)", "Explicit repo override."),
        ),
        examples=(
            "task triage:queue",
            "task triage:queue -- --limit=20 --state=accept",
            "task triage:queue -- --format=json | jq '.[] | select(.score > 5)'",
        ),
        see_also=(
            "task triage:show",
            "task triage:audit",
            "#1119 / D11",
        ),
    ),
    "task triage:audit": _entry(
        name="task triage:audit",
        summary="Session-summary view + slice-aware audit flags",
        refs="(D11/D13 / #1128, #1180)",
        description=(
            "Audit-log surface used by D2 (#1122) for triage:summary "
            "integration and by D4 (#1124) for cap-reached error "
            "messages. --vbrief-staleness flags audit entries that "
            "reference vBRIEFs newer than their last decision."
        ),
        usage="task triage:audit [-- --format=text|json] [--vbrief-staleness] [--since=<window>] [--action=<verb>]",
        flags=(
            ("--format text|json", "text", "Output shape."),
            ("--vbrief-staleness", "(off)", "Flag entries referencing newer vBRIEFs."),
            ("--since WINDOW", "(all)", "Time window (e.g. '24h', '7d')."),
            ("--action VERB", "(all)", "Filter by audit verb."),
            ("--repo owner/name", "(git remote)", "Explicit repo override."),
        ),
        examples=(
            "task triage:audit",
            "task triage:audit -- --format=json --since=7d",
        ),
        see_also=(
            "task triage:queue",
            "task triage:history",
            "#1119 / D11",
        ),
    ),
    "task triage:show": _entry(
        name="task triage:show",
        summary="Per-issue detail with optional drift diff",
        refs="(D11 / #1128)",
        description=(
            "Per-issue read-only detail (cached upstream payload + "
            "latest triage decision + audit timeline). Useful before "
            "running triage:accept / triage:defer to confirm context."
        ),
        usage="task triage:show -- <N> [--repo=owner/name]",
        flags=(
            ("<N>", "(required)", "Issue number (positional)."),
            ("--repo owner/name", "(git remote)", "Explicit repo override."),
        ),
        examples=(
            "task triage:show -- 42",
            "task triage:show -- 42 --repo deftai/directive",
        ),
        see_also=(
            "task triage:queue",
            "task triage:status",
            "#1119 / D11",
        ),
    ),
    "task triage:scope": _entry(
        name="task triage:scope",
        summary="Active subscription inspection",
        refs="(D12 / #1131, D14 / #1133, D14c / #1182)",
        description=(
            "Inspect / mutate / diff the typed plan.policy.triageScope[] "
            "subscription and the triageScopeIgnores[] companion list. "
            "Defaults to read-only --list."
        ),
        usage="task triage:scope -- [--list] [--add-label=L | --add-milestone=M | --ignore-label=L] [--diff-from-upstream --repo OWNER/NAME] [--refresh-denominator --repo OWNER/NAME --count N]",
        flags=(
            ("--list", "(default)", "Print the active subscription rules."),
            ("--add-label L", "(none)", "Append a label rule to the subscription."),
            ("--add-milestone M", "(none)", "Append a milestone rule."),
            ("--ignore-label L", "(none)", "Append a label to triageScopeIgnores[]."),
            ("--diff-from-upstream", "(off)", "Diff cached scope vs live upstream."),
            ("--repo owner/name", "(git remote)", "Required for --diff-from-upstream."),
        ),
        examples=(
            "task triage:scope",
            "task triage:scope -- --add-label='area:swarm'",
        ),
        see_also=(
            "task triage:subscribe",
            "task triage:scope-drift",
            "#1119 / D12",
        ),
    ),
    "task triage:scope-drift": _entry(
        name="task triage:scope-drift",
        summary="Detect labels/milestones outside subscription",
        refs="(D14 / #1133)",
        description=(
            "Detect subscription drift: labels / milestones that appear "
            "on cached open issues but are NOT in plan.policy.triageScope. "
            "Suggests `task triage:subscribe` follow-ups or explicit "
            "ignore-list mutations."
        ),
        usage="task triage:scope-drift [-- --ignore-label=L | --ignore-milestone=M]",
        flags=(
            ("--ignore-label L", "(none)", "Append label to triageScopeIgnores[]."),
            ("--ignore-milestone M", "(none)", "Append milestone to triageScopeIgnores[]."),
        ),
        examples=(
            "task triage:scope-drift",
            "task triage:scope-drift -- --ignore-label='wontfix'",
        ),
        see_also=(
            "task triage:scope",
            "task triage:subscribe",
            "#1119 / D14",
        ),
    ),
    "task triage:classify": _entry(
        name="task triage:classify",
        summary="Inspect / validate auto-classification surface",
        refs="(D10 / #1129)",
        description=(
            "Inspect or validate the auto-classification rule set. "
            "--list renders effective rules (framework universal first, "
            "consumer overrides next). --validate exits non-zero on a "
            "malformed plan.policy.triageAutoClassify."
        ),
        usage="task triage:classify -- [--list | --validate]",
        flags=(
            ("--list", "(default)", "Print effective rules + hold markers."),
            ("--validate", "(off)", "Validate plan.policy.triageAutoClassify."),
        ),
        examples=(
            "task triage:classify -- --list",
            "task triage:classify -- --validate",
        ),
        see_also=(
            "task triage:bootstrap",
            "task triage:queue",
            "#1119 / D10",
        ),
    ),
    # --- Lifecycle -------------------------------------------------------
    "task triage:bootstrap": _entry(
        name="task triage:bootstrap",
        summary="Populate cache + auto-classify",
        refs="(D10 / #845 Story 6)",
        description=(
            "Idempotent bootstrap installer: populates the unified cache "
            "via cache:fetch-all, runs auto-classification, and emits a "
            "structured recap. --json emits one object per step for "
            "scripted consumers."
        ),
        usage="task triage:bootstrap [-- --repo owner/name] [--state STR] [--limit N] [--batch-size N] [--delay-ms N] [--fetch-timeout-s S] [--quiet] [--json]",
        flags=(
            ("--repo owner/name", "(git remote)", "Upstream repo to populate."),
            ("--state STR", "open", "Issue state filter forwarded to cache:fetch-all."),
            ("--limit N", "(none)", "Cap on issues fetched."),
            ("--fetch-timeout-s S", "(env, 300)", "Watchdog wall-clock cap (#952)."),
            ("--quiet", "(off)", "Suppress per-step progress lines."),
            ("--json", "(off)", "Structured JSON output."),
        ),
        examples=(
            "task triage:bootstrap",
            "task triage:bootstrap -- --repo deftai/directive --limit 50",
        ),
        see_also=(
            "task triage:welcome",
            "task triage:classify",
            "task cache:fetch-all",
            "#1119 / D10",
        ),
    ),
    "task triage:welcome": _entry(
        name="task triage:welcome",
        summary="Single-entry-point upgrade ritual",
        refs="(N3 / #1143)",
        description=(
            "6-phase onboarding ritual: detect prior state, prompt for "
            "subscription scope, run triage:bootstrap, prompt for "
            "wipCap, offer WIP relief, print triage:summary. Idempotent "
            "on re-run; safe entrypoint for fresh consumers."
        ),
        usage="task triage:welcome [-- --no-subprocess]",
        flags=(
            ("--no-subprocess", "(off)", "Dry-mode: don't shell out to sibling tasks."),
        ),
        examples=(
            "task triage:welcome",
        ),
        see_also=(
            "task triage:bootstrap",
            "task triage:summary",
            "#1119 / N3",
        ),
    ),
    "task triage:reconcile": _entry(
        name="task triage:reconcile",
        summary="Self-heal audit log from on-disk vBRIEFs",
        refs="(#1468)",
        description=(
            "Idempotent repair verb: derive missing `accept` decisions "
            "for proposed/pending/active vBRIEFs that carry an "
            "x-vbrief/github-issue reference but have no entry in "
            "vbrief/.eval/candidates.jsonl. Recovers triage state after "
            "the gitignored audit log is reset/lost (#1464) without a "
            "full cache re-fetch. Never overrides an existing decision, "
            "so a re-run is a no-op."
        ),
        usage="task triage:reconcile [-- --repo owner/name] [--dry-run] [--json]",
        flags=(
            ("--repo owner/name", "(ref URI / git remote)", "Fallback repo for refs lacking owner/name."),
            ("--dry-run", "(off)", "Report what would be restored without writing."),
            ("--json", "(off)", "Structured JSON output."),
        ),
        examples=(
            "task triage:reconcile -- --dry-run",
            "task triage:reconcile -- --repo deftai/directive",
        ),
        see_also=(
            "task triage:summary",
            "task triage:bootstrap",
            "#1119 / #1468",
        ),
    ),
    # --- Bulk variants (#845 Story 4) ------------------------------------
    "task triage:bulk-accept": _entry(
        name="task triage:bulk-accept",
        summary="Bulk accept cached candidates by filter",
        refs="(#845 Story 4 / #915)",
        description=(
            "Bulk-accept every cached candidate matching the supplied "
            "filters. Terminal records (accept/reject/mark-duplicate) "
            "ALWAYS short-circuit. Add --re-action to act on issues "
            "whose LATEST audit record is defer/needs-ac."
        ),
        usage="task triage:bulk-accept -- --repo OWNER/NAME [--label L] [--author A] [--age-days N] [--cluster C] [--re-action]",
        flags=(
            ("--repo OWNER/NAME", "(required)", "Upstream repo."),
            ("--label L", "(none)", "Filter: only issues carrying this label."),
            ("--author A", "(none)", "Filter: only issues by this author."),
            ("--age-days N", "(none)", "Filter: only issues older than N days."),
            ("--cluster C", "(none)", "Filter: only issues tagged cluster:<C>."),
            ("--re-action", "(off)", "Re-action defer/needs-ac records."),
        ),
        examples=(
            "task triage:bulk-accept -- --repo deftai/directive --label good-first-issue",
        ),
        see_also=(
            "task triage:accept",
            "task triage:bulk-defer",
            "#1119 / #845",
        ),
    ),
    "task triage:bulk-reject": _entry(
        name="task triage:bulk-reject",
        summary="Bulk reject cached candidates by filter",
        refs="(#845 Story 4 / #915)",
        description=(
            "Bulk-reject every cached candidate matching the filters. "
            "--reason is required and is recorded both in the audit log "
            "and on the upstream close comment."
        ),
        usage="task triage:bulk-reject -- --repo OWNER/NAME --reason 'why' [--label L] [--author A] [--age-days N] [--cluster C] [--re-action]",
        flags=(
            ("--repo OWNER/NAME", "(required)", "Upstream repo."),
            ("--reason 'why'", "(required)", "Reason recorded on close comments."),
            ("--label L", "(none)", "Filter: only issues with this label."),
            ("--re-action", "(off)", "Re-action defer/needs-ac records."),
        ),
        examples=(
            "task triage:bulk-reject -- --repo deftai/directive --reason 'no longer relevant' --age-days 365",
        ),
        see_also=(
            "task triage:reject",
            "task triage:bulk-accept",
            "#1119 / #845",
        ),
    ),
    "task triage:bulk-defer": _entry(
        name="task triage:bulk-defer",
        summary="Bulk defer cached candidates by filter",
        refs="(#845 Story 4 / #915)",
        description=(
            "Bulk-defer every cached candidate matching the filters. "
            "Use --re-action to re-action issues whose latest record "
            "is already defer/needs-ac."
        ),
        usage="task triage:bulk-defer -- --repo OWNER/NAME [--label L] [--author A] [--age-days N] [--cluster C] [--re-action]",
        flags=(
            ("--repo OWNER/NAME", "(required)", "Upstream repo."),
            ("--label L", "(none)", "Filter: only issues with this label."),
            ("--re-action", "(off)", "Re-action defer/needs-ac records."),
        ),
        examples=(
            "task triage:bulk-defer -- --repo deftai/directive --label needs-design",
        ),
        see_also=(
            "task triage:defer",
            "task triage:bulk-accept",
            "#1119 / #845",
        ),
    ),
    "task triage:bulk-needs-ac": _entry(
        name="task triage:bulk-needs-ac",
        summary="Bulk needs-ac cached candidates by filter",
        refs="(#845 Story 4 / #915)",
        description=(
            "Bulk-needs-ac every cached candidate matching the filters; "
            "posts the canned AC-request comment upstream on each."
        ),
        usage="task triage:bulk-needs-ac -- --repo OWNER/NAME [--label L] [--author A] [--age-days N] [--cluster C] [--re-action]",
        flags=(
            ("--repo OWNER/NAME", "(required)", "Upstream repo."),
            ("--label L", "(none)", "Filter: only issues with this label."),
            ("--re-action", "(off)", "Re-action defer/needs-ac records."),
        ),
        examples=(
            "task triage:bulk-needs-ac -- --repo deftai/directive --age-days 30",
        ),
        see_also=(
            "task triage:needs-ac",
            "#1119 / #845",
        ),
    ),
    "task triage:refresh-active": _entry(
        name="task triage:refresh-active",
        summary="Pre-swarm freshness gate for vbrief/active/",
        refs="(#845 Story 4)",
        description=(
            "Detect drift between cached and live `gh issue view` for "
            "every issue referenced from vbrief/active/*.vbrief.json. "
            "Interactive prompts on each drift: proceed-with-stale, "
            "refresh-and-update-local, or defer-from-this-batch."
        ),
        usage="task triage:refresh-active [-- --project-root PATH]",
        flags=(
            ("--project-root PATH", "(cwd)", "Project root containing vbrief/active/."),
        ),
        examples=(
            "task triage:refresh-active",
        ),
        see_also=(
            "task verify:cache-fresh",
            "task triage:audit",
            "#1119 / #845",
        ),
    ),
    "task triage:smoketest": _entry(
        name="task triage:smoketest",
        summary="End-to-end synthetic smoketest (hermetic)",
        refs="(N6 / #1146)",
        description=(
            "End-to-end synthetic test of the cache-as-operator-"
            "working-set surface. Runs the full triage lifecycle against "
            "the bundled fixture and asserts the expected audit-log "
            "shape at every stage. Exit 0 on PASS, 1 on first failure."
        ),
        usage="task triage:smoketest [-- --verbose] [--keep-tempdir] [--cache-only]",
        flags=(
            ("--verbose", "(off)", "Print each assertion to stderr as it runs."),
            ("--keep-tempdir", "(off)", "Don't clean up the temp working dir on exit."),
            ("--cache-only", "(off)", "Skip vBRIEF-mutating stages (faster)."),
        ),
        examples=(
            "task triage:smoketest",
            "task triage:smoketest -- --cache-only --verbose",
        ),
        see_also=(
            "task triage:bootstrap",
            "#1119 / N6",
        ),
    ),
    # --- Subscription mutation ------------------------------------------
    "task triage:subscribe": _entry(
        name="task triage:subscribe",
        summary="Add label/milestone/issue to subscription",
        refs="(D14 / #1133)",
        description=(
            "Subscribe to a label / milestone / issue by appending a "
            "rule to plan.policy.triageScope[]. Emits a JSONL audit "
            "record to vbrief/.eval/subscription-history.jsonl."
        ),
        usage="task triage:subscribe -- (--label=L | --milestone=M | --issue=N)",
        flags=(
            ("--label L", "(none)", "Subscribe to a label."),
            ("--milestone M", "(none)", "Subscribe to a milestone."),
            ("--issue N", "(none)", "Subscribe to a single issue."),
        ),
        examples=(
            "task triage:subscribe -- --label='area:swarm'",
            "task triage:subscribe -- --milestone='v0.32.0'",
        ),
        see_also=(
            "task triage:unsubscribe",
            "task triage:scope",
            "#1119 / D14",
        ),
    ),
    "task triage:unsubscribe": _entry(
        name="task triage:unsubscribe",
        summary="Remove label/milestone/issue from subscription",
        refs="(D14 / #1133)",
        description=(
            "Unsubscribe a label / milestone / issue by removing the "
            "matching rule from plan.policy.triageScope[]. Idempotent "
            "(no-op on already-missing entries). Emits a JSONL audit "
            "record."
        ),
        usage="task triage:unsubscribe -- (--label=L | --milestone=M | --issue=N)",
        flags=(
            ("--label L", "(none)", "Unsubscribe a label."),
            ("--milestone M", "(none)", "Unsubscribe a milestone."),
            ("--issue N", "(none)", "Unsubscribe a single issue."),
        ),
        examples=(
            "task triage:unsubscribe -- --label='area:swarm'",
        ),
        see_also=(
            "task triage:subscribe",
            "task triage:scope",
            "#1119 / D14",
        ),
    ),
    # --- Archive / rotation (forward-looking placeholders) --------------
    "task triage:audit:prune": _entry(
        name="task triage:audit:prune",
        summary="Operator-invoked archive of closed-terminal entries",
        refs="(D19, coming)",
        description=(
            "Move closed-terminal audit entries (accept/reject/"
            "mark-duplicate after the upstream issue is closed) into "
            "the archive sidecar so the live cache stays focused on "
            "open work."
        ),
        usage="task triage:audit:prune [-- --dry-run] [--older-than-days N]",
        flags=(
            ("--dry-run", "(off)", "Preview eligible entries without writing."),
            ("--older-than-days N", "30", "Age threshold."),
        ),
        examples=(
            "task triage:audit:prune -- --dry-run",
        ),
        see_also=(
            "task triage:archive-list",
            "task triage:restore-from-archive",
            "#1119 / D19",
        ),
        placeholder=True,
    ),
    "task triage:archive-list": _entry(
        name="task triage:archive-list",
        summary="List archived entries",
        refs="(D19, coming)",
        description=(
            "Read-only listing of archived audit entries from the "
            "archive sidecar. Useful before restoring an entry."
        ),
        usage="task triage:archive-list [-- --since=WINDOW]",
        flags=(
            ("--since WINDOW", "(all)", "Time window (e.g. '30d', '6mo')."),
        ),
        examples=(
            "task triage:archive-list",
        ),
        see_also=(
            "task triage:audit:prune",
            "#1119 / D19",
        ),
        placeholder=True,
    ),
    "task triage:restore-from-archive": _entry(
        name="task triage:restore-from-archive",
        summary="Restore archived entry to live cache",
        refs="(D19, coming)",
        description=(
            "Move an archived entry back to the live audit log so it "
            "becomes visible to triage:queue / triage:audit again."
        ),
        usage="task triage:restore-from-archive -- <N>",
        flags=(
            ("<N>", "(required)", "Archived entry number to restore."),
        ),
        examples=(
            "task triage:restore-from-archive -- 42",
        ),
        see_also=(
            "task triage:archive-list",
            "#1119 / D19",
        ),
        placeholder=True,
    ),
    "task triage:audit-log:rotate": _entry(
        name="task triage:audit-log:rotate",
        summary="Rotate candidates.jsonl when bounded",
        refs="(D20, coming)",
        description=(
            "Rotate vbrief/.eval/candidates.jsonl when it exceeds the "
            "configured bound. Compacts terminal entries and preserves "
            "the open-work tail."
        ),
        usage="task triage:audit-log:rotate [-- --max-lines N]",
        flags=(
            ("--max-lines N", "(consumer default)", "Bound at which rotation fires."),
        ),
        examples=(
            "task triage:audit-log:rotate -- --max-lines 10000",
        ),
        see_also=(
            "task triage:audit:prune",
            "#1119 / D20",
        ),
        placeholder=True,
    ),
    "task triage:metrics": _entry(
        name="task triage:metrics",
        summary="Trend lines from summary-history.jsonl",
        refs="(D17, coming)",
        description=(
            "Print trend lines computed from "
            "vbrief/.eval/summary-history.jsonl: decisions-per-day, "
            "defer/accept ratio, stale-defer drift, etc."
        ),
        usage="task triage:metrics [-- --window=7d] [--format=text|json]",
        flags=(
            ("--window WINDOW", "7d", "Time window over which to aggregate."),
            ("--format text|json", "text", "Output shape."),
        ),
        examples=(
            "task triage:metrics -- --window 30d",
        ),
        see_also=(
            "task triage:summary",
            "#1119 / D17",
        ),
        placeholder=True,
    ),
    # --- Scope lifecycle verbs (#845, D1, D15, D18) ----------------------
    "task scope:promote": _entry(
        name="task scope:promote",
        summary="proposed/ -> pending/ (set status pending)",
        refs="(#845, D18 / #1119)",
        description=(
            "Promote a vBRIEF scope from vbrief/proposed/ to "
            "vbrief/pending/ and set plan.status='pending'. D18 adds "
            "--from-issue=N for cache-reciprocity-checked promotion."
        ),
        usage="task scope:promote -- <file> [--force] | task scope:promote -- --from-issue=N",
        flags=(
            ("<file>", "(required)", "Path to vBRIEF (relative resolved against project root)."),
            ("--from-issue=N", "(none)", "Promote with cache-reciprocity check (D18)."),
            ("--force", "(off)", "Override the WIP cap (#1124 / D4); records audit entry."),
            ("--project-root PATH", "(detected)", "Consumer project root override."),
        ),
        examples=(
            "task scope:promote -- vbrief/proposed/2026-05-19-foo.vbrief.json",
            "task scope:promote -- --from-issue=1150",
        ),
        see_also=(
            "task scope:demote",
            "task scope:activate",
            "task vbrief:activate",
            "#1119 / D18",
        ),
    ),
    "task scope:demote": _entry(
        name="task scope:demote",
        summary="pending/ -> proposed/ (set status proposed)",
        refs="(D1 / #1121)",
        description=(
            "Demote a vBRIEF scope from vbrief/pending/ back to "
            "vbrief/proposed/ and append a structured audit entry "
            "(including a demote_meta block) to "
            "vbrief/.eval/scope-lifecycle.jsonl. Supports single-file "
            "and --batch (cohort shrink / cap relief) modes."
        ),
        usage="task scope:demote -- <file> [--reason TEXT] | task scope:demote -- --batch [--older-than-days N]",
        flags=(
            ("<file>", "(required for single)", "Path to vBRIEF."),
            ("--batch", "(off)", "Batch mode: demote every pending older than --older-than-days."),
            ("--older-than-days N", "45", "Batch-mode age threshold."),
            ("--reason TEXT", "operator-requested", "Free-text reason for single-demote."),
            ("--actor STR", "operator", "Actor identity recorded in the audit entry."),
        ),
        examples=(
            "task scope:demote -- vbrief/pending/2026-05-19-foo.vbrief.json",
            "task scope:demote -- --batch --older-than-days 60",
        ),
        see_also=(
            "task scope:undo",
            "task scope:promote",
            "#1119 / D1",
        ),
    ),
    "task scope:activate": _entry(
        name="task scope:activate",
        summary="pending/ -> active/ (set status running)",
        refs="(#845)",
        description=(
            "Activate a pending vBRIEF: move to vbrief/active/ and set "
            "plan.status='running'. Required step before "
            "vbrief:preflight will exit 0 (the #810 implementation "
            "intent gate)."
        ),
        usage="task scope:activate -- <file>",
        flags=(
            ("<file>", "(required)", "Path to vBRIEF."),
            ("--project-root PATH", "(detected)", "Consumer project root override."),
        ),
        examples=(
            "task scope:activate -- vbrief/pending/2026-05-19-foo.vbrief.json",
        ),
        see_also=(
            "task vbrief:activate",
            "task scope:complete",
            "#1119 / #845",
        ),
    ),
    "task scope:complete": _entry(
        name="task scope:complete",
        summary="active/ -> completed/ (set status completed)",
        refs="(#845)",
        description=(
            "Mark an active vBRIEF complete and move it to "
            "vbrief/completed/. Terminal transition; use scope:undo if "
            "you need reversibility (refused on terminal actions per "
            "D15)."
        ),
        usage="task scope:complete -- <file>",
        flags=(
            ("<file>", "(required)", "Path to vBRIEF."),
            ("--project-root PATH", "(detected)", "Consumer project root override."),
        ),
        examples=(
            "task scope:complete -- vbrief/active/2026-05-19-foo.vbrief.json",
        ),
        see_also=(
            "task scope:fail",
            "task scope:cancel",
            "#1119 / #845",
        ),
    ),
    "task scope:fail": _entry(
        name="task scope:fail",
        summary="active/ -> completed/ (set status failed)",
        refs="(#845, #614)",
        description=(
            "Terminal failed transition. Mirrors scope:complete but "
            "sets plan.status='failed'. Use when a scope was attempted "
            "but could not be completed (external blocker, "
            "infeasibility, exhausted retries) and should NOT be "
            "cancelled."
        ),
        usage="task scope:fail -- <file>",
        flags=(
            ("<file>", "(required)", "Path to vBRIEF."),
            ("--project-root PATH", "(detected)", "Consumer project root override."),
        ),
        examples=(
            "task scope:fail -- vbrief/active/2026-05-19-foo.vbrief.json",
        ),
        see_also=(
            "task scope:complete",
            "task scope:cancel",
            "#1119 / #845",
        ),
    ),
    "task scope:cancel": _entry(
        name="task scope:cancel",
        summary="any -> cancelled/ (set status cancelled)",
        refs="(#845)",
        description=(
            "Cancel a vBRIEF from any folder. Use when the scope is no "
            "longer wanted / superseded / obsolete (vs scope:fail which "
            "means \"tried and failed\")."
        ),
        usage="task scope:cancel -- <file>",
        flags=(
            ("<file>", "(required)", "Path to vBRIEF."),
            ("--project-root PATH", "(detected)", "Consumer project root override."),
        ),
        examples=(
            "task scope:cancel -- vbrief/pending/2026-05-19-foo.vbrief.json",
        ),
        see_also=(
            "task scope:restore",
            "task scope:undo",
            "#1119 / #845",
        ),
    ),
    "task scope:restore": _entry(
        name="task scope:restore",
        summary="cancelled/ -> proposed/ (set status proposed)",
        refs="(#845)",
        description=(
            "Restore a cancelled vBRIEF back to vbrief/proposed/ "
            "(status='proposed'). Use to re-enter the lifecycle after a "
            "scope:cancel."
        ),
        usage="task scope:restore -- <file>",
        flags=(
            ("<file>", "(required)", "Path to vBRIEF."),
            ("--project-root PATH", "(detected)", "Consumer project root override."),
        ),
        examples=(
            "task scope:restore -- vbrief/cancelled/2026-05-19-foo.vbrief.json",
        ),
        see_also=(
            "task scope:cancel",
            "task scope:promote",
            "#1119 / #845",
        ),
    ),
    "task scope:block": _entry(
        name="task scope:block",
        summary="stays in active/ (set status blocked)",
        refs="(#845)",
        description=(
            "Mark an active scope as blocked without moving it out of "
            "active/. Use when waiting on an external dependency."
        ),
        usage="task scope:block -- <file>",
        flags=(
            ("<file>", "(required)", "Path to vBRIEF."),
            ("--project-root PATH", "(detected)", "Consumer project root override."),
        ),
        examples=(
            "task scope:block -- vbrief/active/2026-05-19-foo.vbrief.json",
        ),
        see_also=(
            "task scope:unblock",
            "#1119 / #845",
        ),
    ),
    "task scope:unblock": _entry(
        name="task scope:unblock",
        summary="stays in active/ (set status running)",
        refs="(#845)",
        description=(
            "Clear a blocked status on an active scope, returning it "
            "to plan.status='running'."
        ),
        usage="task scope:unblock -- <file>",
        flags=(
            ("<file>", "(required)", "Path to vBRIEF."),
            ("--project-root PATH", "(detected)", "Consumer project root override."),
        ),
        examples=(
            "task scope:unblock -- vbrief/active/2026-05-19-foo.vbrief.json",
        ),
        see_also=(
            "task scope:block",
            "#1119 / #845",
        ),
    ),
    "task scope:undo": _entry(
        name="task scope:undo",
        summary="Undo demote/cancel/restore via audit-log id",
        refs="(D15 / #1134)",
        description=(
            "Reverse a scope-lifecycle audit entry by decision_id or "
            "every entry tagged with batch_id. Terminal actions "
            "(complete / fail) are REFUSED -- use a fresh scope:promote "
            "instead. Supports --dry-run preview and --latest "
            "convenience selector."
        ),
        usage="task scope:undo -- <decision_id> | --decision-id=<uuid> | --batch-id=<uuid> | --latest [--dry-run]",
        flags=(
            ("<decision_id>", "(one of)", "Positional decision_id (shorthand for --decision-id)."),
            ("--decision-id UUID", "(one of)", "Decision id of a single audit entry to undo."),
            ("--batch-id UUID", "(one of)", "Reverse every entry tagged with this batch_id."),
            ("--latest", "(one of)", "Reverse the most-recent reversible entry."),
            ("--dry-run", "(off)", "Preview the reversal without writing."),
            ("--actor STR", "operator", "Actor identity recorded on the new undo entry."),
        ),
        examples=(
            "task scope:undo -- --latest --dry-run",
            "task scope:undo -- --batch-id=00000000-0000-0000-0000-000000000001",
        ),
        see_also=(
            "task scope:demote",
            "task triage:reset",
            "#1119 / D15",
        ),
    ),
    "task scope:decompose": _entry(
        name="task scope:decompose",
        summary="Apply/check an approved epic story decomposition",
        refs="(deft-directive-decompose skill)",
        description=(
            "Validate or apply an approved epic/phase -> story "
            "decomposition draft. The draft is a temporary proposal "
            "artifact, not a vBRIEF. Writes pending child vBRIEFs and "
            "wires references back into the parent epic."
        ),
        usage="task scope:decompose -- <parent> --draft <draft> [--check] [--date YYYY-MM-DD]",
        flags=(
            (
                "<parent>",
                "(conditional)",
                "Parent epic/phase vBRIEF path; required with --draft, omit only for --check no-op.",
            ),
            (
                "--draft PATH",
                "(required)",
                "Approved decomposition JSON draft; prefer vbrief/.eval/decompositions/<parent-slug>.json.",
            ),
            ("--check", "(off)", "Validate only; do not write."),
            ("--date YYYY-MM-DD", "today", "Creation date for generated child filenames."),
        ),
        examples=(
            "task scope:decompose -- vbrief/active/epic.vbrief.json --draft vbrief/.eval/decompositions/epic.json --check",
        ),
        see_also=(
            "task scope:promote",
            "skills/deft-directive-decompose/SKILL.md",
        ),
    ),
}


# ---------------------------------------------------------------------------
# Category structure for bare-list rendering
# ---------------------------------------------------------------------------


CATEGORIES_TRIAGE: list[tuple[str, list[str]]] = [
    (
        "Session-start",
        [
            "task triage:summary",
            "task verify:cache-fresh",
        ],
    ),
    (
        "State verbs (mutate audit log)",
        [
            "task triage:accept",
            "task triage:defer",
            "task triage:reject",
            "task triage:needs-ac",
            "task triage:mark-duplicate",
            "task triage:reset",
            "task triage:status",
            "task triage:history",
        ],
    ),
    (
        "Read verbs",
        [
            "task triage:queue",
            "task triage:audit",
            "task triage:show",
            "task triage:scope",
            "task triage:scope-drift",
            "task triage:classify",
        ],
    ),
    (
        "Lifecycle",
        [
            "task triage:bootstrap",
            "task triage:welcome",
            "task triage:reconcile",
        ],
    ),
    (
        "Bulk variants",
        [
            "task triage:bulk-accept",
            "task triage:bulk-reject",
            "task triage:bulk-defer",
            "task triage:bulk-needs-ac",
            "task triage:refresh-active",
            "task triage:smoketest",
        ],
    ),
    (
        "Subscription mutation",
        [
            "task triage:subscribe",
            "task triage:unsubscribe",
        ],
    ),
    (
        "Archive / rotation",
        [
            "task triage:audit:prune",
            "task triage:archive-list",
            "task triage:restore-from-archive",
            "task triage:audit-log:rotate",
            "task triage:metrics",
        ],
    ),
]


CATEGORIES_SCOPE: list[tuple[str, list[str]]] = [
    (
        "Promote / demote",
        [
            "task scope:promote",
            "task scope:demote",
        ],
    ),
    (
        "Activate / complete",
        [
            "task scope:activate",
            "task scope:complete",
            "task scope:fail",
            "task scope:cancel",
            "task scope:block",
            "task scope:unblock",
        ],
    ),
    (
        "Reversibility",
        [
            "task scope:undo",
            "task scope:restore",
        ],
    ),
    (
        "Decomposition",
        [
            "task scope:decompose",
        ],
    ),
]


# ---------------------------------------------------------------------------
# Script -> (subcommand -> verb) mapping for the intercept_help shim
# ---------------------------------------------------------------------------
#
# Each verb script is expected to call ``intercept_help(<script_name>, argv)``
# at the very top of its ``main()``. The shim looks up the script under
# ``SCRIPT_SUBCOMMAND_MAP`` to resolve which verb the user is running:
#
# * If the script has only ``{"__default__": "task triage:X"}``, the verb
#   is fixed and we print help unconditionally on --help/-h.
# * If the script declares subcommand entries, the shim inspects argv for
#   the first positional non-flag arg and looks it up. The fallback when
#   no positional matches is the ``__default__`` key (if present); otherwise
#   ``--help`` is delegated to argparse so the user still gets *some* help.


SCRIPT_SUBCOMMAND_MAP: dict[str, dict[str, str]] = {
    "triage_actions": {
        "accept": "task triage:accept",
        "reject": "task triage:reject",
        "defer": "task triage:defer",
        "needs-ac": "task triage:needs-ac",
        "mark-duplicate": "task triage:mark-duplicate",
        "status": "task triage:status",
        "reset": "task triage:reset",
        "history": "task triage:history",
    },
    "triage_bootstrap": {"__default__": "task triage:bootstrap"},
    "triage_bulk": {
        "accept": "task triage:bulk-accept",
        "reject": "task triage:bulk-reject",
        "defer": "task triage:bulk-defer",
        "needs-ac": "task triage:bulk-needs-ac",
    },
    "triage_refresh": {"__default__": "task triage:refresh-active"},
    "triage_classify": {"__default__": "task triage:classify"},
    "triage_scope": {"__default__": "task triage:scope"},
    "triage_scope_drift": {"__default__": "task triage:scope-drift"},
    # ``triage_subscribe`` is the ONLY multi-subcommand entry that also
    # declares ``__default__``. The Taskfile (``tasks/triage-subscribe.yml``)
    # always passes the positional (``subscribe`` or ``unsubscribe``) as the
    # first arg, so under the documented user-facing surface the fallback
    # never fires. The fallback exists for two off-Taskfile paths:
    #   (1) direct invocations like ``python scripts/triage_subscribe.py --help``
    #       (no positional) -- the operator sees ``task triage:subscribe`` help,
    #       which is the canonical/primary verb in the subscribe<->unsubscribe
    #       pair (you subscribe first; unsubscribe is the inverse).
    #   (2) a hypothetical alternate Taskfile that drops the positional --
    #       same behaviour, documented contract.
    # Pinned by ``test_intercept_help_triage_subscribe_*`` in
    # ``tests/test_triage_help.py``; Greptile finding 3267953653 on PR #1227.
    # Refs #1228 (this PR's docs/coverage gap).
    "triage_subscribe": {
        "subscribe": "task triage:subscribe",
        "unsubscribe": "task triage:unsubscribe",
        "__default__": "task triage:subscribe",
    },
    "triage_summary": {"__default__": "task triage:summary"},
    "triage_reconcile": {"__default__": "task triage:reconcile"},
    "triage_queue": {
        "queue": "task triage:queue",
        "show": "task triage:show",
        "audit": "task triage:audit",
    },
    "triage_welcome": {"__default__": "task triage:welcome"},
    "triage_smoketest": {"__default__": "task triage:smoketest"},
    "scope_lifecycle": {
        "promote": "task scope:promote",
        "activate": "task scope:activate",
        "complete": "task scope:complete",
        "fail": "task scope:fail",
        "cancel": "task scope:cancel",
        "restore": "task scope:restore",
        "block": "task scope:block",
        "unblock": "task scope:unblock",
    },
    "scope_demote": {"__default__": "task scope:demote"},
    "scope_undo": {"__default__": "task scope:undo"},
    "scope_decompose": {"__default__": "task scope:decompose"},
}


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------


def _format_category_row(verb: str, entry: VerbHelp, *, summary_col: int = 60) -> str:
    """Render a single line in the bare-list category view.

    ``verb`` is the user-facing form (``task triage:queue``); ``summary_col``
    pads the summary so the cross-ref tag right-aligns.
    """
    prefix = f"  {verb:<28s}"
    middle = f"{entry.summary}"
    middle = middle if len(middle) <= summary_col else middle[: summary_col - 1] + "…"
    padded = f"{middle:<{summary_col}s}"
    return f"{prefix}{padded} {entry.refs}"


def render_category_list(category: str) -> str:
    """Render the bare-invocation categorized verb list.

    ``category`` is ``"triage"`` or ``"scope"``. Raises ``ValueError`` on
    any other value.
    """
    if category == "triage":
        title = "Task triage — operator-facing cache verbs"
        sections = CATEGORIES_TRIAGE
        suffix = (
            "Run any verb with --help for usage examples (e.g. "
            "`task triage:queue --help`)."
        )
    elif category == "scope":
        title = "Task scope — vBRIEF lifecycle verbs"
        sections = CATEGORIES_SCOPE
        suffix = (
            "Run any verb with --help for usage examples (e.g. "
            "`task scope:promote --help`)."
        )
    else:
        raise ValueError(
            f"unknown category {category!r}; expected 'triage' or 'scope'"
        )

    lines: list[str] = [title, ""]
    for label, verbs in sections:
        lines.append(f"{label}:")
        for verb in verbs:
            entry = REGISTRY.get(verb)
            if entry is None:
                # Defensive -- if a category references a verb that is
                # not yet in the registry, surface the gap loudly.
                lines.append(f"  {verb:<28s}(missing registry entry)")
                continue
            lines.append(_format_category_row(verb, entry))
        lines.append("")
    lines.append(suffix)
    return "\n".join(lines)


def render_verb_help(verb: str) -> str:
    """Render the structured ``--help`` output for a single verb.

    Raises ``KeyError`` if ``verb`` is not registered.
    """
    entry = REGISTRY.get(verb)
    if entry is None:
        raise KeyError(
            f"unknown verb {verb!r}; not in scripts/triage_help.py REGISTRY. "
            "Run `task triage` or `task scope` to see the catalog."
        )

    lines: list[str] = []
    header = f"{entry.name} -- {entry.summary} {entry.refs}".rstrip()
    lines.append(header)
    if entry.placeholder:
        lines.append("  (not yet implemented -- placeholder entry; see refs)")
    lines.append("")
    lines.append(entry.description)
    lines.append("")
    lines.append("Usage:")
    lines.append(f"  {entry.usage}")
    if entry.flags:
        lines.append("")
        lines.append("Flags:")
        # Width-align the flag column for scannability.
        flag_width = max(len(f) for f, _, _ in entry.flags)
        flag_width = min(flag_width, 32)
        for flag, default, desc in entry.flags:
            head = f"  {flag:<{flag_width}s}"
            tail = f"{desc} (default: {default})" if default else desc
            lines.append(f"{head}  {tail}")
    if entry.examples:
        lines.append("")
        lines.append("Examples:")
        for ex in entry.examples:
            lines.append(f"  {ex}")
    if entry.see_also:
        lines.append("")
        lines.append("See also:")
        for ref in entry.see_also:
            lines.append(f"  {ref}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Intercept helper used by verb scripts
# ---------------------------------------------------------------------------


HELP_FLAGS = ("--help", "-h")


def _argv_or_default(argv: list[str] | None) -> list[str]:
    return list(argv) if argv is not None else list(sys.argv[1:])


def _has_help_flag(argv: list[str]) -> bool:
    return any(arg in HELP_FLAGS for arg in argv)


def _resolve_verb_from_argv(
    script_name: str, argv: list[str]
) -> str | None:
    """Look up the verb for ``script_name`` based on argv.

    Returns the canonical verb (e.g. ``"task triage:queue"``) or ``None``
    if the script is unmapped or no matching subcommand was found.
    """
    sub_map = SCRIPT_SUBCOMMAND_MAP.get(script_name)
    if sub_map is None:
        return None
    # Single-verb scripts: just take the default.
    if "__default__" in sub_map and len(sub_map) == 1:
        return sub_map["__default__"]
    # Multi-subcommand scripts: find the first positional non-flag arg.
    for arg in argv:
        if not arg.startswith("-"):
            verb = sub_map.get(arg)
            if verb is not None:
                return verb
    # No matching positional; fall back to default if present.
    return sub_map.get("__default__")


def intercept_help(
    script_name: str,
    argv: list[str] | None = None,
    *,
    out: object | None = None,
) -> int | None:
    """Print structured help and return 0 if ``--help`` / ``-h`` is in argv.

    Verb scripts call this at the top of ``main()``::

        def main(argv=None):
            rc = intercept_help("triage_queue", argv)
            if rc is not None:
                return rc
            ...

    Returns ``None`` when no help flag was found (caller proceeds with
    argparse). Returns ``0`` after printing structured help; the caller
    should propagate that exit code so argparse never runs.

    ``out`` is for tests -- defaults to ``sys.stdout``. Anything with a
    ``write`` method works.
    """
    args = _argv_or_default(argv)
    if not _has_help_flag(args):
        return None

    verb = _resolve_verb_from_argv(script_name, args)
    sink = out if out is not None else sys.stdout
    if verb is None or verb not in REGISTRY:
        # Unmapped script or unknown subcommand: print the appropriate
        # category catalog hint and let argparse take over by returning
        # None. (We intentionally do NOT swallow --help for scripts that
        # are outside our registry; the existing argparse --help should
        # still run.)
        return None
    try:
        sink.write(render_verb_help(verb) + "\n")
    except (KeyError, ValueError) as exc:  # pragma: no cover -- defensive
        sink.write(f"triage_help: {exc}\n")
        return 2
    return 0


# ---------------------------------------------------------------------------
# CLI entrypoint -- python -m scripts.triage_help <category|help|list>
# ---------------------------------------------------------------------------


_USAGE = (
    "usage: python -m scripts.triage_help <triage|scope|help <verb>|list>\n"
    "\n"
    "  triage              Print the categorized triage verb list.\n"
    "  scope               Print the categorized scope verb list.\n"
    "  help <verb>         Print structured help for a single verb.\n"
    "                      Accepts both 'task triage:queue' and 'triage:queue'.\n"
    "  list                Print every registered verb (tooling discovery).\n"
)


def _normalize_verb_arg(raw: str) -> str:
    """Accept both ``triage:queue`` and ``task triage:queue`` forms."""
    raw = raw.strip()
    if raw.startswith("task "):
        return raw
    return f"task {raw}"


def main(argv: list[str] | None = None) -> int:  # noqa: PLR0911
    args = _argv_or_default(argv)
    if not args:
        sys.stderr.write(_USAGE)
        return 2
    head, *rest = args
    if head in ("-h", "--help"):
        sys.stdout.write(_USAGE)
        return 0
    if head == "triage":
        sys.stdout.write(render_category_list("triage") + "\n")
        return 0
    if head == "scope":
        sys.stdout.write(render_category_list("scope") + "\n")
        return 0
    if head == "list":
        for verb in sorted(REGISTRY):
            entry = REGISTRY[verb]
            tag = " [coming]" if entry.placeholder else ""
            sys.stdout.write(f"{verb}{tag}\n")
        return 0
    if head == "help":
        if not rest:
            sys.stderr.write(
                "triage_help: missing <verb> argument for `help`.\n"
            )
            sys.stderr.write(_USAGE)
            return 2
        verb = _normalize_verb_arg(rest[0])
        if verb not in REGISTRY:
            sys.stderr.write(
                f"triage_help: unknown verb {verb!r}. "
                "Run `python -m scripts.triage_help list` to see all "
                "registered verbs.\n"
            )
            return 2
        sys.stdout.write(render_verb_help(verb) + "\n")
        return 0
    sys.stderr.write(f"triage_help: unknown command {head!r}.\n")
    sys.stderr.write(_USAGE)
    return 2


if __name__ == "__main__":
    sys.exit(main())
