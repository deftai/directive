"""Diff scanner for the system-of-record architecture gate."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from preflight_architecture_sor import (
    LOW_RISK_PATH_PREFIXES,
    LOW_RISK_SUFFIXES,
    SCANNER_EXEMPT_PATHS,
    DetectedSignal,
    GateFinding,
    GateResult,
    _format_failure,
    _load_json_file,
    _system_of_record,
    validate_record,
)


def _is_low_risk_path(path: str) -> bool:
    clean = path.lstrip("./")
    if clean in SCANNER_EXEMPT_PATHS:
        return True
    if Path(clean).suffix.lower() in LOW_RISK_SUFFIXES:
        return True
    return clean.startswith(LOW_RISK_PATH_PREFIXES)


def _storage_from_line(path: str, line: str) -> str:
    text = f"{path} {line}".lower()
    if re.search(r"\.ya?ml\b", text):
        return "yaml_file"
    if re.search(r"\.toml\b", text):
        return "toml_file"
    if re.search(r"\.(sqlite|sqlite3|db)\b", text):
        return "sqlite_file"
    if re.search(r"\.json\b", text):
        return "json_file"
    return "filesystem"


def _path_name_signal(path: str) -> DetectedSignal | None:
    if _is_low_risk_path(path):
        return None
    name = Path(path).name.lower()
    if re.search(r"(registry|repository|store|manager|service)", name) and re.search(
        r"\.(py|js|jsx|ts|tsx|go|rb|java|kt)$", name
    ):
        return DetectedSignal(
            kind="state_module",
            path=path,
            line=None,
            detail="stateful module name",
        )
    if re.search(r"migrations?/", path) or re.search(r"\bmigration", name):
        return DetectedSignal(
            kind="database_model",
            path=path,
            line=None,
            detail="database migration path",
            storage="database",
        )
    return None


def _looks_like_workflow_state_change(stripped: str) -> bool:
    term = (
        r"(workflow|workflows|job|jobs|queue|queues|runtime|orchestration|job_queue|"
        r"workflow_queue|runtime_state|orchestration_state|worker_state|run_state)"
    )
    action = (
        r"(create|schedule|enqueue|dequeue|start|complete|fail|cancel|retry|update|delete|"
        r"upsert|persist|save|load|restore|claim|lease|dispatch)"
    )

    if re.match(r"(#|//|/\*|\*)", stripped):
        return False

    patterns = (
        rf"\b(def|function|func)\s+({action}_{term}|{term}_{action})\b",
        r"\b(class|type)\s+\w*"
        r"(Workflow|Job|Queue|Runtime|Orchestration|WorkerState|RunState)\w*",
        rf"\b({term})\.(append|add|put|enqueue|dequeue|submit|dispatch|schedule|"
        rf"start|complete|fail|cancel|retry|update|delete|save|persist)\s*\(",
        rf"\b({term})\s*\[[^\]]+\]\s*=",
        rf"\b({term})\s*=\s*(new\s+Map\(|\{{\}}|\[\])",
        rf"\b({action}_{term}|{term}_{action})\s*\(",
    )
    return any(re.search(pattern, stripped, flags=re.IGNORECASE) for pattern in patterns)


def _line_signals(path: str, line_no: int | None, line: str) -> list[DetectedSignal]:
    if _is_low_risk_path(path):
        return []

    stripped = line.strip()
    signals: list[DetectedSignal] = []

    if re.search(
        r"(write_text|write_bytes|fs\.(writeFile|writeFileSync|appendFile|createWriteStream)|"
        r"Deno\.write(Text)?File|os\.WriteFile|ioutil\.WriteFile|Files\.write|"
        r"open\([^)]*,\s*['\"][^'\"]*[wax])",
        stripped,
    ):
        signals.append(
            DetectedSignal(
                kind="filesystem_write",
                path=path,
                line=line_no,
                detail=stripped,
                storage=_storage_from_line(path, stripped),
            )
        )

    if re.search(r"\b(localStorage|sessionStorage|indexedDB|caches\.open)\b", stripped):
        signals.append(
            DetectedSignal(
                kind="browser_storage",
                path=path,
                line=line_no,
                detail=stripped,
                storage="browser_storage",
            )
        )

    path_name = Path(path).name.lower()
    if re.search(r"(registry|repository|store|manager)", path_name) and re.search(
        r"(new\s+Map\(|=\s*\{\}\s*(#|//|$)|:\s*dict\[)",
        stripped,
    ):
        signals.append(
            DetectedSignal(
                kind="in_memory_state",
                path=path,
                line=line_no,
                detail=stripped,
                storage="in_memory",
            )
        )

    if re.search(
        r"(@\w+\.(post|put|patch|delete)\b|\b(router|app)\.(post|put|patch|delete)\s*\(|"
        r"\b(def|function|func)\s+(create|select|update|delete|upsert)_?)",
        stripped,
        flags=re.IGNORECASE,
    ):
        signals.append(
            DetectedSignal(
                kind="mutation_endpoint",
                path=path,
                line=line_no,
                detail=stripped,
            )
        )

    if re.search(
        r"(CREATE\s+TABLE|ALTER\s+TABLE|sqlalchemy|db\.Column|models\.Model|"
        r"prisma|typeorm|sequelize|ActiveRecord)",
        stripped,
        flags=re.IGNORECASE,
    ):
        signals.append(
            DetectedSignal(
                kind="database_model",
                path=path,
                line=line_no,
                detail=stripped,
                storage="database",
            )
        )

    if re.search(
        r"\b(auth|session|permission|membership|role|grant|tenant|organization)\b",
        stripped,
        flags=re.IGNORECASE,
    ):
        signals.append(
            DetectedSignal(
                kind="auth_state",
                path=path,
                line=line_no,
                detail=stripped,
            )
        )

    if _looks_like_workflow_state_change(stripped):
        signals.append(
            DetectedSignal(
                kind="workflow_state",
                path=path,
                line=line_no,
                detail=stripped,
            )
        )

    return signals


def scan_diff(diff_text: str) -> tuple[list[DetectedSignal], list[str]]:
    """Scan unified diff text for suspicious stateful patterns."""
    signals: list[DetectedSignal] = []
    changed_paths: list[str] = []
    current_path: str | None = None
    new_line_no: int | None = None

    for raw_line in diff_text.splitlines():
        if raw_line.startswith("diff --git "):
            parts = raw_line.split()
            if len(parts) >= 4:
                candidate = parts[3]
                current_path = candidate[2:] if candidate.startswith("b/") else candidate
                if current_path not in changed_paths:
                    changed_paths.append(current_path)
                    path_signal = _path_name_signal(current_path)
                    if path_signal is not None:
                        signals.append(path_signal)
            new_line_no = None
            continue

        if raw_line.startswith("+++ "):
            target = raw_line[4:].strip()
            if target == "/dev/null":
                current_path = None
                continue
            current_path = target[2:] if target.startswith("b/") else target
            if current_path not in changed_paths:
                changed_paths.append(current_path)
                path_signal = _path_name_signal(current_path)
                if path_signal is not None:
                    signals.append(path_signal)
            continue

        if raw_line.startswith("@@ "):
            match = re.search(r"\+(\d+)", raw_line)
            new_line_no = int(match.group(1)) if match else None
            continue

        if current_path is None:
            continue

        if raw_line.startswith("+") and not raw_line.startswith("+++"):
            line = raw_line[1:]
            signals.extend(_line_signals(current_path, new_line_no, line))
            if new_line_no is not None:
                new_line_no += 1
        elif raw_line.startswith("-") and not raw_line.startswith("---"):
            continue
        elif new_line_no is not None:
            new_line_no += 1

    return signals, changed_paths


def _git_diff(project_root: Path, base_ref: str) -> tuple[str | None, GateResult | None]:
    try:
        proc = subprocess.run(
            ["git", "diff", "--unified=0", "--no-ext-diff", base_ref, "--"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, GateResult(
            2,
            f"system-of-record gate misconfigured: could not run git diff: {exc}",
        )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout.strip() or f"git diff exited {proc.returncode}"
        return None, GateResult(
            2,
            f"system-of-record gate misconfigured: could not diff against {base_ref}: {detail}",
        )
    return proc.stdout, None


def _changed_story_records(
    project_root: Path,
    changed_paths: list[str],
) -> tuple[list[tuple[Path, dict[str, Any], dict[str, Any]]], GateResult | None]:
    records: list[tuple[Path, dict[str, Any], dict[str, Any]]] = []
    for rel in changed_paths:
        if not rel.endswith(".vbrief.json"):
            continue
        if not rel.startswith(("vbrief/active/", "vbrief/pending/", "vbrief/proposed/")):
            continue
        path = project_root / rel
        payload, error = _load_json_file(path)
        if error is not None:
            return [], error
        assert payload is not None
        record = _system_of_record(payload)
        if record is not None:
            records.append((path, payload, record))
    return records, None


def evaluate_diff_text(
    diff_text: str,
    *,
    project_root: Path,
    story_path: Path | None = None,
) -> GateResult:
    signals, changed_paths = scan_diff(diff_text)
    if not signals:
        return GateResult(0, "OK system-of-record gate passed: no stateful diff signals detected.")

    payload: dict[str, Any] | None = None
    record: dict[str, Any] | None = None

    if story_path is not None:
        payload, error = _load_json_file(story_path)
        if error is not None:
            return error
        assert payload is not None
        record = _system_of_record(payload)
    else:
        records, error = _changed_story_records(project_root, changed_paths)
        if error is not None:
            return error
        if len(records) == 1:
            _, payload, record = records[0]
        elif len(records) > 1:
            return GateResult(
                2,
                "system-of-record gate misconfigured: multiple changed vBRIEFs "
                "contain system-of-record records; pass --story-path.",
            )

    if record is None:
        finding = GateFinding(
            reason=(
                "Diff contains stateful persistence signals, but no matching "
                "architecture.systemOfRecord design record was supplied or changed."
            ),
            required_fix=(
                "Run `task architecture:sor-preflight -- --story-path <path>` "
                "after adding the design record, or pass --story-path to this diff gate."
            ),
            detected_storage=signals[0].storage,
        )
        return GateResult(1, _format_failure([finding]), (finding,))

    result = validate_record(record, story_payload=payload, signals=signals)
    if result.code == 0:
        return GateResult(
            0,
            f"OK system-of-record gate passed: {len(signals)} stateful diff signal(s) matched.",
        )
    return result


def evaluate_diff(project_root: Path, base_ref: str, story_path: Path | None = None) -> GateResult:
    diff_text, error = _git_diff(project_root, base_ref)
    if error is not None:
        return error
    assert diff_text is not None
    return evaluate_diff_text(diff_text, project_root=project_root, story_path=story_path)
