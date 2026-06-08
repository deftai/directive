"""Tests for safe GitHub Markdown body posting (#1555)."""

from __future__ import annotations

import importlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

github_body = importlib.import_module("github_body")

MARKDOWN_BODY = """This body keeps literal `ghx`, "$HOME", and 'quotes'.

```bash
echo "`do not execute me`"
printf "%s\\n" "$PATH"
```
"""


def _completed(cmd: list[str], stdout: str) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=cmd, returncode=0, stdout=stdout, stderr="")


def test_comment_create_preserves_markdown_and_uses_safe_subprocess(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def fake_run_text(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append({"cmd": cmd, "kwargs": kwargs})
        if "/comments" in cmd[2] and "--method" in cmd:
            return _completed(cmd, '{"id": 99}')
        return _completed(cmd, json.dumps({"id": 99, "body": MARKDOWN_BODY}))

    monkeypatch.setattr(github_body, "run_text", fake_run_text)

    result = github_body.create_issue_comment(
        "deftai/directive", 1555, body=MARKDOWN_BODY, binary="gh"
    )

    assert result["body"] == MARKDOWN_BODY
    assert len(calls) == 2
    mutation = calls[0]
    assert mutation["cmd"] == [
        "gh",
        "api",
        "repos/deftai/directive/issues/1555/comments",
        "--method",
        "POST",
        "--input",
        "-",
    ]
    assert isinstance(mutation["cmd"], list)
    assert "shell" not in mutation["kwargs"]
    assert mutation["kwargs"]["check"] is False
    parsed_payload = json.loads(mutation["kwargs"]["input"])
    assert parsed_payload == {"body": MARKDOWN_BODY}
    assert "`ghx`" in mutation["kwargs"]["input"]
    assert "$HOME" in mutation["kwargs"]["input"]
    assert calls[1]["cmd"] == [
        "gh",
        "api",
        "repos/deftai/directive/issues/comments/99",
    ]


@pytest.mark.parametrize(
    ("operation", "expected_mutation", "expected_method", "mutation_response", "expected_readback"),
    [
        (
            lambda: github_body.create_issue(
                "deftai/directive", title="Safe body", body=MARKDOWN_BODY, binary="gh"
            ),
            "repos/deftai/directive/issues",
            "POST",
            '{"number": 1555}',
            "repos/deftai/directive/issues/1555",
        ),
        (
            lambda: github_body.edit_issue_body(
                "deftai/directive", 1555, body=MARKDOWN_BODY, binary="gh"
            ),
            "repos/deftai/directive/issues/1555",
            "PATCH",
            '{"number": 1555}',
            "repos/deftai/directive/issues/1555",
        ),
        (
            lambda: github_body.edit_issue_comment_body(
                "deftai/directive", 99, body=MARKDOWN_BODY, binary="gh"
            ),
            "repos/deftai/directive/issues/comments/99",
            "PATCH",
            '{"id": 99}',
            "repos/deftai/directive/issues/comments/99",
        ),
        (
            lambda: github_body.edit_pr_body(
                "deftai/directive", 42, body=MARKDOWN_BODY, binary="gh"
            ),
            "repos/deftai/directive/pulls/42",
            "PATCH",
            '{"number": 42}',
            "repos/deftai/directive/pulls/42",
        ),
    ],
)
def test_mutations_perform_live_readback(
    monkeypatch: pytest.MonkeyPatch,
    operation: Any,
    expected_mutation: str,
    expected_method: str,
    mutation_response: str,
    expected_readback: str,
) -> None:
    calls: list[list[str]] = []

    def fake_run_text(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        if len(calls) == 1:
            return _completed(cmd, mutation_response)
        return _completed(cmd, '{"body": "read back"}')

    monkeypatch.setattr(github_body, "run_text", fake_run_text)

    operation()

    assert calls == [
        ["gh", "api", expected_mutation, "--method", expected_method, "--input", "-"],
        ["gh", "api", expected_readback],
    ]


def test_read_body_from_file_and_stdin(tmp_path: Path) -> None:
    body_file = tmp_path / "body.md"
    body_file.write_text(MARKDOWN_BODY, encoding="utf-8")

    assert github_body.read_body(str(body_file)) == MARKDOWN_BODY
    assert github_body.read_body("-", stdin_text=MARKDOWN_BODY) == MARKDOWN_BODY


def test_cli_reads_body_file_and_prints_readback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    body_file = tmp_path / "body.md"
    body_file.write_text(MARKDOWN_BODY, encoding="utf-8")

    def fake_create_issue_comment(
        repo: str, issue: int, *, body: str, binary: str | None = None
    ) -> dict[str, Any]:
        assert repo == "deftai/directive"
        assert issue == 1555
        assert body == MARKDOWN_BODY
        assert binary is None
        return {"id": 99, "body": body}

    monkeypatch.setattr(github_body, "create_issue_comment", fake_create_issue_comment)

    rc = github_body.main(
        [
            "comment-create",
            "--repo",
            "deftai/directive",
            "--issue",
            "1555",
            "--body-file",
            str(body_file),
        ]
    )

    assert rc == 0
    assert json.loads(capsys.readouterr().out)["body"] == MARKDOWN_BODY


def test_live_gh_resolution_rejects_missing_gh(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(github_body.shutil, "which", lambda _name: None)

    with pytest.raises(github_body.GitHubBodyError, match="requires live gh"):
        github_body.resolve_live_gh()
