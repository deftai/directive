"""_triage_smoketest_stages.py -- 9-stage assertion helpers for triage_smoketest.py.

Extracted from ``scripts/triage_smoketest.py`` so the driver stays under
the 1000-line MUST cap (coding/coding.md). Each ``stage_*`` function
takes the project root, the smoketest's :class:`AssertLog`, and any
prior-stage output it needs, and raises :class:`SmoketestFailure` on
the first assertion that fails.

The functions deliberately keep their own subprocess calls so the
driver can compose them in any order (current order matches the issue
body's demoability block 1..9).

Refs:

* Umbrella: #1119
* This deliverable: #1146 (N6)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import uuid4

if TYPE_CHECKING:
    from triage_smoketest import AssertLog

_SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS_DIR))

FIXTURE_REPO = "deftai/smoketest"
WARN_GLYPH = "\u26a0"
SUMMARY_MAX_CHARS = 120


# ---------------------------------------------------------------------------
# Subprocess helper
# ---------------------------------------------------------------------------


def run_script(
    script_name: str,
    *cli_args: str,
    project_root: Path,
    extra_env: dict[str, str] | None = None,
    include_repo_env: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run a sibling script with ``cli_args`` against ``project_root``.

    ``include_repo_env`` controls whether ``DEFT_TRIAGE_REPO`` is injected
    into the subprocess env. Stages that explicitly pass ``--repo`` (audit
    / queue / defer) leave it on for redundancy; the bootstrap stage
    turns it off so ``triage_bootstrap.py``'s populate_cache step skips
    cleanly (no --repo, no env fallback, no .git -- so the watchdog has
    nothing to attempt).
    """
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["DEFT_PROJECT_ROOT"] = str(project_root)
    if include_repo_env:
        env["DEFT_TRIAGE_REPO"] = FIXTURE_REPO
    else:
        env.pop("DEFT_TRIAGE_REPO", None)
    if extra_env:
        env.update(extra_env)
    cmd = [sys.executable, str(_SCRIPTS_DIR / script_name), *cli_args]
    return subprocess.run(  # noqa: S603 -- known scripts, env-controlled paths
        cmd,
        cwd=str(project_root),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


# ---------------------------------------------------------------------------
# Stage 1: bootstrap + auto-classify
# ---------------------------------------------------------------------------


def stage_bootstrap_and_classify(
    project_root: Path,
    issues_spec: dict[str, Any],
    log: AssertLog,
) -> None:
    """Run triage:bootstrap, then emulate the D10 auto-classify apply-step.

    D10 / #1129 landed the universal rules + ``classify_issue`` library but
    did NOT yet wire the apply-step into bootstrap (deferred to a follow-up
    child). The smoketest emulates the eventual apply-step in-process so
    the assertion targets are reachable today.
    """
    stage = 1
    name = "bootstrap + auto-classify"

    bootstrap = run_script(
        "triage_bootstrap.py",
        "--project-root", str(project_root),
        "--quiet",
        "--json",
        project_root=project_root,
        include_repo_env=False,
    )
    if bootstrap.returncode != 0:
        raise log.fail(
            stage, name,
            expected="bootstrap exit 0",
            actual=f"exit {bootstrap.returncode}",
            cause="triage_bootstrap.py failed: " + bootstrap.stderr.strip()[:200],
        )

    from candidates_log import append as audit_append  # noqa: PLC0415
    from triage_classify import (  # noqa: PLC0415
        classify_issue,
        extract_referenced_issues,
        resolve_classify_rules,
        resolve_hold_markers,
    )

    rules = resolve_classify_rules(project_root)
    markers = resolve_hold_markers(project_root)
    referenced = extract_referenced_issues(project_root)
    now_dt = datetime.fromisoformat(issues_spec["now_iso"].replace("Z", "+00:00"))
    audit_path = project_root / "vbrief" / ".eval" / "candidates.jsonl"

    counts: dict[str, int] = {"accept": 0, "defer": 0, "archive": 0, "untriaged": 0}
    defer_reasons: dict[str, int] = {}

    for issue in issues_spec["issues"]:
        n = int(issue["number"])
        gh_issue = {
            "number": n,
            "title": issue["title"],
            "state": issue.get("state", "open"),
            "labels": [{"name": label} for label in issue.get("labels", [])],
            "body": issue.get("body", ""),
            "updated_at": issue.get("updated_at"),
            "created_at": issue.get("created_at"),
        }
        result = classify_issue(
            gh_issue,
            rules=rules,
            hold_markers=markers,
            vbrief_referenced=referenced,
            has_triage_decision=False,
            now=now_dt,
        )
        if result is None:
            counts["untriaged"] += 1
            continue
        if result.action == "archive":
            counts["archive"] += 1
            continue
        entry = {
            "decision_id": str(uuid4()),
            "timestamp": (now_dt + timedelta(seconds=n)).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
            "repo": FIXTURE_REPO,
            "issue_number": n,
            "decision": result.action,
            "actor": "agent:smoketest-classify",
            "reason": result.reason,
        }
        audit_append(entry, path=audit_path)
        counts[result.action] = counts.get(result.action, 0) + 1
        if result.action == "defer":
            defer_reasons[result.reason] = defer_reasons.get(result.reason, 0) + 1

    expected_counts = {"accept": 1, "defer": 7, "archive": 0, "untriaged": 12}
    if counts != expected_counts:
        raise log.fail(
            stage, name,
            expected=expected_counts,
            actual=counts,
            cause="auto-classify decision counts diverged from fixture spec",
        )
    expected_defer = {
        "hold marker in body": 3,
        "research": 2,
        "dormant; needs AC refresh": 2,
    }
    if defer_reasons != expected_defer:
        raise log.fail(
            stage, name,
            expected=expected_defer,
            actual=defer_reasons,
            cause="defer-reason bucket counts diverged",
        )
    log.passed(stage, name, detail=f"counts={counts} defer_reasons={defer_reasons}")


# ---------------------------------------------------------------------------
# Stage 2: audit decision counts
# ---------------------------------------------------------------------------


def stage_audit_counts(project_root: Path, log: AssertLog) -> None:
    stage = 2
    name = "audit decision counts"
    audit_log = project_root / "vbrief" / ".eval" / "candidates.jsonl"
    proc = run_script(
        "triage_queue.py",
        "audit",
        "--project-root", str(project_root),
        "--repo", FIXTURE_REPO,
        "--audit-log", str(audit_log),
        "--format=json",
        project_root=project_root,
    )
    if proc.returncode != 0:
        raise log.fail(
            stage, name,
            expected="exit 0",
            actual=f"exit {proc.returncode}",
            cause="triage_queue.py audit failed: " + proc.stderr.strip()[:200],
        )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise log.fail(
            stage, name,
            expected="JSON envelope",
            actual=proc.stdout[:200],
            cause=f"JSON decode error: {exc}",
        ) from exc

    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        raise log.fail(
            stage, name,
            expected="dict with entries[]",
            actual=type(payload).__name__,
            cause="audit JSON envelope shape unexpected",
        )

    by_decision: dict[str, int] = {}
    for entry in entries:
        if isinstance(entry, dict):
            decision = entry.get("decision")
            if isinstance(decision, str):
                by_decision[decision] = by_decision.get(decision, 0) + 1

    expected = {"accept": 1, "defer": 7}
    actual_subset = {k: by_decision.get(k, 0) for k in expected}
    if actual_subset != expected:
        raise log.fail(
            stage, name,
            expected=expected,
            actual=actual_subset,
            cause="audit-log decision counts diverged from stage-1 writes",
        )
    log.passed(
        stage, name, detail=f"entries={len(entries)} by_decision={by_decision}"
    )


# ---------------------------------------------------------------------------
# Stage 3: queue determinism + untriaged visibility
# ---------------------------------------------------------------------------


def stage_queue_determinism(project_root: Path, log: AssertLog) -> None:
    stage = 3
    name = "queue ranking determinism"

    audit_log = project_root / "vbrief" / ".eval" / "candidates.jsonl"

    def _run_queue() -> str:
        proc = run_script(
            "triage_queue.py",
            "queue",
            "--project-root", str(project_root),
            "--repo", FIXTURE_REPO,
            "--audit-log", str(audit_log),
            "--limit", "20",
            project_root=project_root,
        )
        if proc.returncode != 0:
            raise log.fail(
                stage, name,
                expected="exit 0",
                actual=f"exit {proc.returncode}",
                cause="triage_queue.py queue failed: " + proc.stderr.strip()[:200],
            )
        return proc.stdout

    out1 = _run_queue()
    out2 = _run_queue()
    if out1 != out2:
        raise log.fail(
            stage, name,
            expected="identical stdout across two runs",
            actual="stdout diverged on second run",
            cause="ranking non-deterministic",
        )

    expected_untriaged = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
    missing = sorted(n for n in expected_untriaged if f"#{n}" not in out1)
    if missing:
        raise log.fail(
            stage, name,
            expected="all 12 untriaged numbers visible",
            actual=f"missing: {missing}",
            cause="queue rendering dropped untriaged rows",
        )
    log.passed(stage, name, detail=f"chars={len(out1)} stable across runs")


# ---------------------------------------------------------------------------
# Stage 4: defer with resume-on
# ---------------------------------------------------------------------------


def stage_defer_resume_on(project_root: Path, log: AssertLog) -> str:
    """Defer issue #5 with a past-date resume-on; assert the audit entry.

    Runs in-process (not via the CLI subprocess) because ``triage_actions.defer``
    writes through ``candidates_log.append(entry)`` without a path override,
    which would resolve to ``candidates_log.DEFAULT_LOG_PATH`` -- the deft
    framework's own audit log, not the smoketest's tmpdir. The smoketest
    builds the same audit entry that ``triage_actions.defer`` would build
    (via ``triage_actions._build_entry``) and appends it to the tmpdir's
    candidates.jsonl via the explicit ``path=`` override. Hermetic, exercises
    the same entry shape, and avoids leaking writes into the framework tree.
    """
    stage = 4
    name = "defer with resume-on"

    import triage_actions  # noqa: PLC0415
    from candidates_log import append as audit_append  # noqa: PLC0415

    audit_path = project_root / "vbrief" / ".eval" / "candidates.jsonl"
    entry = triage_actions._build_entry(
        "defer",
        5,
        FIXTURE_REPO,
        actor="agent:smoketest",
        reason="smoketest defer w/ resume-on",
        resume_on="date:>=2020-01-01",
    )
    audit_append(entry, path=audit_path)
    decision_id: str | None = None
    resume_on: str | None = None
    for line in audit_path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            entry.get("issue_number") == 5
            and entry.get("decision") == "defer"
            and entry.get("actor") == "agent:smoketest"
        ):
            decision_id = entry.get("decision_id")
            resume_on = entry.get("resume_on")

    if decision_id is None:
        raise log.fail(
            stage, name,
            expected="defer audit entry for issue 5",
            actual="no smoketest defer entry",
            cause="triage_actions.py defer did not write the audit entry",
        )
    if resume_on != "date:>=2020-01-01":
        raise log.fail(
            stage, name,
            expected="resume_on=date:>=2020-01-01",
            actual=str(resume_on),
            cause="resume_on field absent or mismatched",
        )
    log.passed(stage, name, detail=f"decision_id={decision_id}")
    return decision_id


# ---------------------------------------------------------------------------
# Stage 5: evaluate-resume marker
# ---------------------------------------------------------------------------


def stage_evaluate_resume(
    project_root: Path, prior_defer_id: str, log: AssertLog
) -> None:
    stage = 5
    name = "evaluate-resume marker"
    audit_log = project_root / "vbrief" / ".eval" / "candidates.jsonl"
    proc = run_script(
        "triage_queue.py",
        "audit",
        "--project-root", str(project_root),
        "--repo", FIXTURE_REPO,
        "--audit-log", str(audit_log),
        "--evaluate-resume",
        "--format=json",
        project_root=project_root,
    )
    if proc.returncode != 0:
        raise log.fail(
            stage, name,
            expected="exit 0",
            actual=f"exit {proc.returncode}",
            cause="audit --evaluate-resume failed: " + proc.stderr.strip()[:200],
        )

    audit_path = project_root / "vbrief" / ".eval" / "candidates.jsonl"
    found: dict[str, Any] | None = None
    for line in audit_path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            entry.get("decision") == "resume-eligible"
            and entry.get("prior_decision_id") == prior_defer_id
        ):
            found = entry
            break
    if found is None:
        raise log.fail(
            stage, name,
            expected=f"resume-eligible entry referencing {prior_defer_id}",
            actual="no resume-eligible entry written",
            cause="evaluate-resume did not fire on date:>=2020-01-01",
        )
    log.passed(stage, name, detail=f"decision_id={found.get('decision_id')}")


# ---------------------------------------------------------------------------
# Stage 6: scope:promote (D18 fallback)
# ---------------------------------------------------------------------------


def stage_scope_promote(project_root: Path, log: AssertLog) -> Path:
    """Promote ``vbrief/proposed/test-1.vbrief.json`` to pending/.

    NOTE: D18 / #1136 (``scope:promote --from-issue=<N>``) is OPEN-but-
    not-implemented at this commit. The smoketest uses the existing
    ``scope:promote <file>`` form per the orchestrator's fallback note;
    see the PR body for the future-integration link.
    """
    stage = 6
    name = "scope:promote (D18 fallback)"
    proposed = project_root / "vbrief" / "proposed" / "test-1.vbrief.json"
    if not proposed.is_file():
        raise log.fail(
            stage, name,
            expected="vbrief/proposed/test-1.vbrief.json",
            actual="missing",
            cause="fixture copy did not place test-1.vbrief.json",
        )
    proc = run_script(
        "scope_lifecycle.py",
        "promote",
        str(proposed),
        "--project-root", str(project_root),
        "--force",  # framework worktrees inherit a 60-vBRIEF WIP overage
        project_root=project_root,
    )
    if proc.returncode != 0:
        raise log.fail(
            stage, name,
            expected="exit 0",
            actual=f"exit {proc.returncode}",
            cause="scope_lifecycle.py promote failed: " + proc.stderr.strip()[:200],
        )
    pending = project_root / "vbrief" / "pending" / "test-1.vbrief.json"
    if not pending.is_file():
        raise log.fail(
            stage, name,
            expected="vbrief/pending/test-1.vbrief.json",
            actual="file not in pending/",
            cause="scope:promote did not move the file",
        )
    data = json.loads(pending.read_text(encoding="utf-8"))
    if data.get("plan", {}).get("status") != "pending":
        raise log.fail(
            stage, name,
            expected="plan.status=pending",
            actual=str(data.get("plan", {}).get("status")),
            cause="plan.status not flipped to pending",
        )
    log.passed(stage, name, detail="proposed -> pending OK")
    return pending


# ---------------------------------------------------------------------------
# Stage 7: scope:demote single-file
# ---------------------------------------------------------------------------


def stage_scope_demote(project_root: Path, pending: Path, log: AssertLog) -> None:
    stage = 7
    name = "scope:demote single-file"
    reason = "smoketest single demote"
    proc = run_script(
        "scope_demote.py",
        str(pending),
        "--reason", reason,
        "--actor", "agent:smoketest",
        "--project-root", str(project_root),
        project_root=project_root,
    )
    if proc.returncode != 0:
        raise log.fail(
            stage, name,
            expected="exit 0",
            actual=f"exit {proc.returncode}",
            cause="scope_demote.py failed: " + proc.stderr.strip()[:200],
        )
    proposed = project_root / "vbrief" / "proposed" / "test-1.vbrief.json"
    if not proposed.is_file():
        raise log.fail(
            stage, name,
            expected="file back in proposed/",
            actual="missing",
            cause="scope:demote did not move file back",
        )
    log_path = project_root / "vbrief" / ".eval" / "scope-lifecycle.jsonl"
    last_demote: dict[str, Any] | None = None
    if log_path.is_file():
        for line in log_path.read_text(encoding="utf-8").splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                entry.get("action") == "demote"
                and entry.get("actor") == "agent:smoketest"
            ):
                last_demote = entry
    if last_demote is None:
        raise log.fail(
            stage, name,
            expected="demote audit entry from smoketest",
            actual="no matching entry",
            cause="scope:demote audit entry missing",
        )
    meta = last_demote.get("demote_meta") or {}
    if meta.get("demoted_from") != "pending":
        raise log.fail(
            stage, name,
            expected="demote_meta.demoted_from=pending",
            actual=meta.get("demoted_from"),
            cause="demote_meta.demoted_from mismatched",
        )
    if meta.get("demote_reason") != reason:
        raise log.fail(
            stage, name,
            expected=f"demote_meta.demote_reason={reason!r}",
            actual=meta.get("demote_reason"),
            cause="demote_meta.demote_reason mismatched",
        )
    log.passed(
        stage, name,
        detail=(
            f"demoted_from={meta.get('demoted_from')} "
            f"days_in_pending={meta.get('days_in_pending')}"
        ),
    )


# ---------------------------------------------------------------------------
# Stage 8: scope:undo (graceful skip when D15 / #1134 absent)
# ---------------------------------------------------------------------------


def stage_scope_undo(project_root: Path, log: AssertLog) -> None:
    stage = 8
    name = "scope:undo idempotency"
    candidate = _SCRIPTS_DIR / "scope_undo.py"
    if not candidate.is_file():
        sys.stderr.write(
            "[triage:smoketest] D15 / #1134 (scope:undo) has not landed yet; "
            "skipping stage 8 with informational stderr per the orchestrator's "
            "graceful-skip rule.\n"
        )
        log.skipped(stage, name, reason="D15 / #1134 not yet merged")
        return
    proc = run_script(  # pragma: no cover -- exercised once D15 lands
        "scope_undo.py",
        "--latest",
        "--project-root", str(project_root),
        project_root=project_root,
    )
    if proc.returncode != 0:
        raise log.fail(
            stage, name,
            expected="exit 0",
            actual=f"exit {proc.returncode}",
            cause="scope_undo.py failed: " + proc.stderr.strip()[:200],
        )
    log.passed(stage, name, detail="undo recorded")


# ---------------------------------------------------------------------------
# Stage 9: triage:summary bounded output
# ---------------------------------------------------------------------------


def stage_triage_summary(project_root: Path, log: AssertLog) -> None:
    stage = 9
    name = "triage:summary bounded output"
    proc = run_script(
        "triage_summary.py",
        "--project-root", str(project_root),
        "--no-history",
        project_root=project_root,
    )
    if proc.returncode != 0:
        raise log.fail(
            stage, name,
            expected="exit 0",
            actual=f"exit {proc.returncode}",
            cause="triage_summary.py failed: " + proc.stderr.strip()[:200],
        )
    out = proc.stdout.strip()
    lines = [line for line in out.splitlines() if line.strip()]
    if not lines:
        raise log.fail(
            stage, name,
            expected="at least the bounded headline",
            actual="no output",
            cause="triage:summary emitted nothing",
        )
    # #1122 bounds the HEADLINE (the first physical line). #1270
    # ([triage:scope]) and #1468 ([triage:reconcile]) add intentional
    # informational lines BELOW the headline; the fixture has a proposed
    # vBRIEF (test-1, issue #1) with no audit decision, which is a
    # legitimate reconcile divergence, so the summary correctly emits a
    # second line. Validate the bounded headline and assert any extra
    # lines are ONLY the recognized informational divergence/hint lines
    # (genuine multi-line garbage still fails).
    headline = lines[0]
    extra_lines = lines[1:]
    unexpected = [
        ln
        for ln in extra_lines
        if not ln.startswith(("[triage:scope]", "[triage:reconcile]"))
    ]
    if unexpected:
        raise log.fail(
            stage, name,
            expected=(
                "only [triage:scope] / [triage:reconcile] informational "
                "lines below the headline"
            ),
            actual=f"{len(unexpected)} unexpected extra line(s): {unexpected[0][:60]!r}",
            cause="unexpected multi-line output",
        )
    if len(headline) > SUMMARY_MAX_CHARS:
        raise log.fail(
            stage, name,
            expected=f"<= {SUMMARY_MAX_CHARS} chars",
            actual=f"{len(headline)} chars",
            cause="exceeded MAX_LINE_CHARS budget",
        )
    if WARN_GLYPH in headline:
        raise log.fail(
            stage, name,
            expected="no warning glyph (WIP under cap)",
            actual="warning glyph U+26A0 present",
            cause="emitted U+26A0 against under-cap fixture",
        )
    log.passed(
        stage, name, detail=f"chars={len(headline)} extra_lines={len(extra_lines)}"
    )
