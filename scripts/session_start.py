#!/usr/bin/env python3
"""Record the quick-tier session ritual state (#1348)."""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_tools  # noqa: E402
from policy import disclosure_line, resolve_policy  # noqa: E402
from ritual_sentinel import (  # noqa: E402
    new_ritual_state_payload,
    ritual_state_path,
    ritual_step,
    write_ritual_state,
)

QUICK_STEPS: tuple[str, ...] = ("alignment", "branch_policy", "triage_welcome")
GATED_STEPS: tuple[str, ...] = ("doctor", "cache_fresh")
TASK_PREFIX_ENV_VAR = "DEFT_TASK_PREFIX"
STEP_ALIASES: dict[str, str] = {
    "branch": "branch_policy",
    "branch-policy": "branch_policy",
    "cache": "cache_fresh",
    "cache-fresh": "cache_fresh",
    "triage": "triage_welcome",
    "triage-welcome": "triage_welcome",
}


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _run_git(project_root: Path, args: list[str]) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError:
        return 127, "", "git executable not found on PATH"
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


@dataclass(frozen=True)
class DefaultBranchSync:
    branch: str | None
    upstream: str | None
    ahead: int | None
    behind: int | None
    warning: str | None = None


def _git_head(project_root: Path) -> tuple[str | None, str | None]:
    code, out, err = _run_git(project_root, ["rev-parse", "--verify", "HEAD"])
    if code != 0 or not out:
        return None, err or "could not resolve git HEAD"
    return out, None


def _worktree_path(project_root: Path) -> str:
    code, out, _err = _run_git(project_root, ["rev-parse", "--show-toplevel"])
    if code == 0 and out:
        return str(Path(out).resolve())
    return str(project_root.resolve())


def _default_branch_candidates(project_root: Path) -> list[str]:
    code, out, _err = _run_git(
        project_root,
        ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    )
    if code == 0 and out:
        return [out.split("/", 1)[-1]]
    candidates: list[str] = []
    for branch in ("main", "master"):
        check_code, _out, _err = _run_git(
            project_root,
            ["show-ref", "--verify", "--quiet", f"refs/remotes/origin/{branch}"],
        )
        if check_code == 0:
            candidates.append(branch)
    return candidates


def default_branch_sync(project_root: Path) -> DefaultBranchSync:
    candidates = _default_branch_candidates(project_root)
    if not candidates:
        return DefaultBranchSync(
            branch=None,
            upstream=None,
            ahead=None,
            behind=None,
            warning="[deft branch] Could not resolve a local default branch (`main` or `master`).",
        )
    branch = candidates[0]
    code, upstream, err = _run_git(
        project_root,
        ["rev-parse", "--abbrev-ref", f"{branch}@{{upstream}}"],
    )
    if code != 0 or not upstream:
        return DefaultBranchSync(
            branch=branch,
            upstream=None,
            ahead=None,
            behind=None,
            warning=f"[deft branch] Local {branch} has no upstream tracking branch.",
        )

    remote, remote_branch = upstream.split("/", 1) if "/" in upstream else ("origin", upstream)
    fetch_code, _out, fetch_err = _run_git(
        project_root,
        ["fetch", "--quiet", remote, remote_branch],
    )
    if fetch_code != 0:
        detail = fetch_err or "remote refresh failed"
        return DefaultBranchSync(
            branch=branch,
            upstream=upstream,
            ahead=None,
            behind=None,
            warning=f"[deft branch] Could not refresh {upstream} for local {branch}: {detail}",
        )

    count_code, counts, count_err = _run_git(
        project_root,
        ["rev-list", "--left-right", "--count", f"{branch}...{upstream}"],
    )
    if count_code != 0 or not counts:
        detail = count_err or "ahead/behind count failed"
        return DefaultBranchSync(
            branch=branch,
            upstream=upstream,
            ahead=None,
            behind=None,
            warning=f"[deft branch] Could not compare local {branch} with {upstream}: {detail}",
        )
    try:
        ahead_raw, behind_raw = counts.split()
        ahead = int(ahead_raw)
        behind = int(behind_raw)
    except ValueError:
        return DefaultBranchSync(
            branch=branch,
            upstream=upstream,
            ahead=None,
            behind=None,
            warning=(
                f"[deft branch] Could not parse branch sync counts for {branch} "
                f"and {upstream}: {counts}"
            ),
        )
    if ahead == 0 and behind == 0:
        return DefaultBranchSync(branch=branch, upstream=upstream, ahead=ahead, behind=behind)
    if ahead and behind:
        warning = (
            f"[deft branch] Local {branch} has diverged from {upstream} "
            f"({ahead} ahead, {behind} behind)."
        )
    elif behind:
        plural = "commit" if behind == 1 else "commits"
        warning = f"[deft branch] Local {branch} is behind {upstream} by {behind} {plural}."
    else:
        plural = "commit" if ahead == 1 else "commits"
        warning = f"[deft branch] Local {branch} is ahead of {upstream} by {ahead} {plural}."
    return DefaultBranchSync(
        branch=branch,
        upstream=upstream,
        ahead=ahead,
        behind=behind,
        warning=warning,
    )


def _normalise_step_name(name: str) -> str:
    return STEP_ALIASES.get(name, name)


def _parse_deferrals(raw_values: list[str]) -> tuple[dict[str, str], list[str]]:
    allowed = set(QUICK_STEPS + GATED_STEPS)
    out: dict[str, str] = {}
    errors: list[str] = []
    for raw in raw_values:
        if "=" not in raw:
            errors.append(f"--defer expects step=reason, got {raw!r}")
            continue
        name, reason = raw.split("=", 1)
        step_name = _normalise_step_name(name.strip())
        if step_name not in allowed:
            errors.append(f"unknown ritual step {name!r}; expected one of {sorted(allowed)}")
            continue
        if not reason.strip():
            errors.append(f"--defer {name}=... requires a non-empty reason")
            continue
        out[step_name] = reason.strip()
    return out, errors


def _record_deferred_steps(
    steps: tuple[str, ...],
    deferrals: dict[str, str],
    *,
    now: datetime,
) -> dict[str, dict[str, Any]]:
    return {
        name: ritual_step(ok=True, ts=now, deferred_reason=deferrals[name])
        for name in steps
        if name in deferrals
    }


def run_session_start(
    project_root: Path,
    *,
    deferrals: dict[str, str] | None = None,
    now: datetime | None = None,
    write_history: bool = True,
    task_prefix: str | None = None,
) -> tuple[int, dict[str, Any], list[str]]:
    """Run quick-tier steps and write ``.deft/ritual-state.json``."""
    instant = now or _utc_now()
    deferrals = deferrals or {}
    git_head, git_error = _git_head(project_root)
    if git_head is None:
        payload = {
            "ready": False,
            "message": git_error or "could not resolve git HEAD",
        }
        return 2, payload, [payload["message"]]

    quick_steps: dict[str, dict[str, Any]] = _record_deferred_steps(
        QUICK_STEPS,
        deferrals,
        now=instant,
    )
    gated_steps: dict[str, dict[str, Any]] = _record_deferred_steps(
        GATED_STEPS,
        deferrals,
        now=instant,
    )
    lines: list[str] = []

    if "alignment" not in quick_steps:
        message = "Deft Directive active -- AGENTS.md loaded."
        quick_steps["alignment"] = ritual_step(ok=True, ts=instant, message=message)
        lines.append(message)

    if "branch_policy" not in quick_steps:
        result = resolve_policy(project_root)
        message = disclosure_line(result)
        ok = result.error is None or result.source == "default-fail-closed"
        quick_steps["branch_policy"] = ritual_step(
            ok=ok,
            ts=instant,
            message=message,
            exit_code=0 if ok else 2,
        )
        lines.append(message)

        branch_sync = default_branch_sync(project_root)
        if branch_sync.warning:
            lines.append(branch_sync.warning)

    tool_lines: list[str] = []
    verify_tools.verify_required_tools(output_fn=tool_lines.append)
    lines.extend(tool_lines)

    if "triage_welcome" not in quick_steps:
        captured: list[str] = []

        def _capture(line: str) -> None:
            captured.append(line)

        normalized_task_prefix = (task_prefix or "").strip()
        if normalized_task_prefix and not normalized_task_prefix.endswith(":"):
            normalized_task_prefix = f"{normalized_task_prefix}:"
        triage_command = ["task", f"{normalized_task_prefix}triage:welcome"]
        try:
            import triage_welcome  # noqa: I001

            triage_command = [
                "task",
                *triage_welcome.task_command_args(
                    ["triage:welcome"],
                    task_prefix=task_prefix,
                ),
            ]
            outcome = triage_welcome.run_default_mode(
                project_root,
                output_fn=_capture,
                write_history=write_history,
                now=instant,
                task_prefix=task_prefix,
            )
            ok = outcome.exit_code == 0
            message = "\n".join(captured).strip() or "triage welcome completed"
            quick_steps["triage_welcome"] = ritual_step(
                ok=ok,
                ts=instant,
                message=message,
                exit_code=outcome.exit_code,
                command=triage_command,
            )
            lines.extend(captured)
        except Exception as exc:  # noqa: BLE001 -- ritual state must record failure
            message = f"triage welcome failed: {exc}"
            quick_steps["triage_welcome"] = ritual_step(
                ok=False,
                ts=instant,
                message=message,
                exit_code=2,
                command=triage_command,
            )
            lines.append(message)

    payload = new_ritual_state_payload(
        session_id=str(uuid.uuid4()),
        git_head=git_head,
        worktree_path=_worktree_path(project_root),
        started_at=instant,
        quick_steps=quick_steps,
        gated_steps=gated_steps,
    )
    state_path = write_ritual_state(project_root, payload)
    failed = [
        name
        for name, step in quick_steps.items()
        if not step.get("ok") and not step.get("deferred_reason")
    ]
    code = 1 if failed else 0
    result_payload = {
        "ready": code == 0,
        "exit_code": code,
        "state_path": str(state_path),
        "quick_steps": quick_steps,
        "gated_steps": gated_steps,
        "message": "session ritual recorded" if code == 0 else "session ritual failed",
    }
    return code, result_payload, lines


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="session_start.py",
        description="Record quick-tier session ritual completion (#1348).",
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root containing vbrief/ and .deft/ (default: cwd).",
    )
    parser.add_argument(
        "--defer",
        action="append",
        default=[],
        metavar="STEP=REASON",
        help="Record an explicit deferral for a quick or gated ritual step.",
    )
    parser.add_argument("--json", action="store_true", dest="emit_json")
    parser.add_argument(
        "--no-history",
        action="store_true",
        help="Do not append triage summary history (test/helper mode).",
    )
    parser.add_argument(
        "--task-prefix",
        default=os.environ.get(TASK_PREFIX_ENV_VAR, ""),
        help=(
            "Optional Taskfile namespace prefix for operator-facing triage "
            f"commands. Defaults to ${TASK_PREFIX_ENV_VAR}."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    deferrals, errors = _parse_deferrals(args.defer)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 2
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        code, payload, lines = run_session_start(
            project_root,
            deferrals=deferrals,
            write_history=not args.no_history,
            task_prefix=args.task_prefix,
        )
    stray = sink.getvalue().strip()
    if stray:
        lines.append(stray)
    if args.emit_json:
        print(json.dumps(payload, sort_keys=True))
    else:
        for line in lines:
            print(line, file=sys.stdout if code == 0 else sys.stderr)
        if code == 0:
            print(f"[deft] session ritual recorded at {ritual_state_path(project_root)}")
    return code


if __name__ == "__main__":
    sys.exit(main())
