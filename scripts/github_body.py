#!/usr/bin/env python3
"""Safely post Markdown-rich GitHub bodies through ``gh api`` (#1555).

The helper exists so agents do not embed Markdown bodies in shell command
strings where backticks, dollar signs, quotes, or fenced code blocks can be
interpreted before GitHub receives them. Bodies are read from a file or stdin,
wrapped as JSON inside Python, and sent to ``gh api --input -`` through the
UTF-8-safe subprocess helper with ``shell=False``.

All mutation helpers immediately re-read the changed resource through live
``gh`` (not ``ghx``) because ``ghx`` may return cached stale GET responses
right after a write.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from _safe_subprocess import run_text

_DEFAULT_TIMEOUT_SECONDS = 60


class GitHubBodyError(RuntimeError):
    """Raised when safe GitHub body posting cannot complete."""


def _split_repo(repo: str) -> tuple[str, str]:
    parts = repo.split("/", 1)
    if len(parts) != 2 or not parts[0] or not parts[1] or "/" in parts[1]:
        raise GitHubBodyError(f"repo must be OWNER/NAME; got {repo!r}")
    return parts[0], parts[1]


def resolve_live_gh() -> str:
    """Resolve the live GitHub CLI used for writes and mutation read-back."""
    if shutil.which("gh") is None:
        raise GitHubBodyError(
            "gh not found on PATH; safe body posting requires live gh, not ghx, "
            "so immediate read-back cannot be served from a stale cache"
        )
    return "gh"


def read_body(body_file: str, *, stdin_text: str | None = None) -> str:
    """Read a Markdown body from ``body_file`` or stdin when ``body_file == '-'``."""
    if body_file == "-":
        return sys.stdin.read() if stdin_text is None else stdin_text
    return Path(body_file).read_text(encoding="utf-8")


def _json_input(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _run_gh_api_json(
    args: Sequence[str],
    *,
    input_text: str | None = None,
    binary: str | None = None,
) -> dict[str, Any]:
    resolved = binary if binary is not None else resolve_live_gh()
    cmd = [resolved, "api", *args]
    try:
        proc = run_text(
            cmd,
            input=input_text,
            timeout=_DEFAULT_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise GitHubBodyError(f"{resolved!r} not found on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise GitHubBodyError(f"gh api timed out after {exc.timeout}s: {args!r}") from exc

    if proc.returncode != 0:
        stderr = proc.stderr.strip() or "(no stderr)"
        raise GitHubBodyError(
            f"gh api {' '.join(args)} failed with exit {proc.returncode}: {stderr}"
        )
    try:
        parsed = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise GitHubBodyError(
            f"gh api {' '.join(args)} returned non-JSON output"
        ) from exc
    if not isinstance(parsed, dict):
        raise GitHubBodyError(f"gh api {' '.join(args)} returned non-object JSON")
    return parsed


def _require_int_field(obj: dict[str, Any], field: str) -> int:
    value = obj.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise GitHubBodyError(f"mutation response did not include integer field {field!r}")
    return value


def _mutate_with_readback(
    mutation_endpoint: str,
    method: str,
    payload: dict[str, Any],
    readback_endpoint: str | Callable[[dict[str, Any]], str],
    *,
    binary: str | None = None,
) -> dict[str, Any]:
    mutation = _run_gh_api_json(
        [mutation_endpoint, "--method", method, "--input", "-"],
        input_text=_json_input(payload),
        binary=binary,
    )
    endpoint = readback_endpoint(mutation) if callable(readback_endpoint) else readback_endpoint
    return _run_gh_api_json([endpoint], binary=binary)


def create_issue(
    repo: str,
    *,
    title: str,
    body: str,
    binary: str | None = None,
) -> dict[str, Any]:
    owner, name = _split_repo(repo)
    endpoint = f"repos/{owner}/{name}/issues"
    return _mutate_with_readback(
        endpoint,
        "POST",
        {"title": title, "body": body},
        lambda response: f"repos/{owner}/{name}/issues/{_require_int_field(response, 'number')}",
        binary=binary,
    )


def edit_issue_body(
    repo: str,
    issue: int,
    *,
    body: str,
    binary: str | None = None,
) -> dict[str, Any]:
    owner, name = _split_repo(repo)
    endpoint = f"repos/{owner}/{name}/issues/{issue}"
    return _mutate_with_readback(
        endpoint,
        "PATCH",
        {"body": body},
        endpoint,
        binary=binary,
    )


def create_issue_comment(
    repo: str,
    issue: int,
    *,
    body: str,
    binary: str | None = None,
) -> dict[str, Any]:
    owner, name = _split_repo(repo)
    endpoint = f"repos/{owner}/{name}/issues/{issue}/comments"

    def readback_endpoint(response: dict[str, Any]) -> str:
        comment_id = _require_int_field(response, "id")
        return f"repos/{owner}/{name}/issues/comments/{comment_id}"

    return _mutate_with_readback(
        endpoint,
        "POST",
        {"body": body},
        readback_endpoint,
        binary=binary,
    )


def edit_issue_comment_body(
    repo: str,
    comment_id: int,
    *,
    body: str,
    binary: str | None = None,
) -> dict[str, Any]:
    owner, name = _split_repo(repo)
    endpoint = f"repos/{owner}/{name}/issues/comments/{comment_id}"
    return _mutate_with_readback(
        endpoint,
        "PATCH",
        {"body": body},
        endpoint,
        binary=binary,
    )


def edit_pr_body(
    repo: str,
    pr: int,
    *,
    body: str,
    binary: str | None = None,
) -> dict[str, Any]:
    owner, name = _split_repo(repo)
    endpoint = f"repos/{owner}/{name}/pulls/{pr}"
    return _mutate_with_readback(
        endpoint,
        "PATCH",
        {"body": body},
        endpoint,
        binary=binary,
    )


def _add_body_file(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--body-file",
        required=True,
        help="UTF-8 Markdown body file, or '-' to read from stdin",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Safely create/edit GitHub Markdown bodies without shell interpolation. "
            "Reads body text from --body-file or stdin and performs live gh read-back."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    issue_create = subparsers.add_parser("issue-create", help="Create an issue body")
    issue_create.add_argument("--repo", required=True)
    issue_create.add_argument("--title", required=True)
    _add_body_file(issue_create)

    issue_edit = subparsers.add_parser("issue-edit", help="Edit an issue body")
    issue_edit.add_argument("--repo", required=True)
    issue_edit.add_argument("--issue", required=True, type=int)
    _add_body_file(issue_edit)

    comment_create = subparsers.add_parser(
        "comment-create", help="Create an issue or PR comment body"
    )
    comment_create.add_argument("--repo", required=True)
    comment_create.add_argument("--issue", required=True, type=int)
    _add_body_file(comment_create)

    comment_edit = subparsers.add_parser("comment-edit", help="Edit an issue comment body")
    comment_edit.add_argument("--repo", required=True)
    comment_edit.add_argument("--comment", required=True, type=int)
    _add_body_file(comment_edit)

    pr_edit = subparsers.add_parser("pr-edit", help="Edit a pull request body")
    pr_edit.add_argument("--repo", required=True)
    pr_edit.add_argument("--pr", required=True, type=int)
    _add_body_file(pr_edit)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    try:
        body = read_body(args.body_file)
        if args.command == "issue-create":
            result = create_issue(args.repo, title=args.title, body=body)
        elif args.command == "issue-edit":
            result = edit_issue_body(args.repo, args.issue, body=body)
        elif args.command == "comment-create":
            result = create_issue_comment(args.repo, args.issue, body=body)
        elif args.command == "comment-edit":
            result = edit_issue_comment_body(args.repo, args.comment, body=body)
        elif args.command == "pr-edit":
            result = edit_pr_body(args.repo, args.pr, body=body)
        else:  # pragma: no cover -- argparse enforces choices.
            parser.error(f"unknown command {args.command!r}")
    except (GitHubBodyError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
