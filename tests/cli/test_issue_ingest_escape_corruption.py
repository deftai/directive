"""Regression coverage for issue ingest escape preservation (#1036).

Synthetic GitHub issue bodies that contain literal JSON-escape-looking text
must stay opaque through cache read/write and vBRIEF construction. Bodies that
already contain decoded control characters should be preserved, but made
visible before they silently land in ``plan.narratives.Overview``.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent.resolve()
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cache = _load_module("cache_for_escape_corruption_test", SCRIPTS_DIR / "cache.py")
issue_ingest = _load_module(
    "issue_ingest_escape_corruption_test",
    SCRIPTS_DIR / "issue_ingest.py",
)


def _issue_payload(number: int, body: str) -> dict:
    return {
        "number": number,
        "title": "Escape preservation",
        "body": body,
        "url": f"https://github.com/deftai/directive/issues/{number}",
        "labels": [{"name": "bug"}],
    }


def test_cache_and_ingest_preserve_literal_escape_looking_body(
    tmp_path: Path,
) -> None:
    body = (
        "Literal paths stay literal: \\vbrief/proposed/ and \\task.\n"
        "Literal escape-looking sequences stay literal too: "
        "\\n \\r \\b \\f \\\\ \\\" \\u0041."
    )
    assert issue_ingest._body_control_character_labels(body) == []

    cache.cache_put(
        "github-issue",
        "deftai/directive/1036",
        _issue_payload(1036, body),
        cache_root=tmp_path,
    )

    cached_issue = issue_ingest._fetch_from_cache(
        "deftai/directive",
        1036,
        cache_root=tmp_path,
    )
    assert cached_issue is not None
    assert cached_issue["body"] == body

    vbrief, _folder = issue_ingest._build_issue_vbrief(
        cached_issue,
        "proposed",
        "https://github.com/deftai/directive",
    )
    overview = vbrief["plan"]["narratives"]["Overview"]
    assert overview == body
    assert "\\vbrief/proposed/" in overview
    assert "\\task" in overview
    assert "\\n" in overview
    assert "\\u0041" in overview
    assert "\v" not in overview
    assert "\t" not in overview

    raw_path = tmp_path / "github-issue" / "deftai" / "directive" / "1036" / "raw.json"
    raw_on_disk = json.loads(raw_path.read_text(encoding="utf-8"))
    assert raw_on_disk["body"] == body


def test_ingest_warns_when_upstream_body_already_has_control_chars(
    capsys,
) -> None:
    body = "Already corrupted: \vbrief and \task plus \bbackspace and \fform."

    vbrief, _folder = issue_ingest._build_issue_vbrief(
        _issue_payload(1037, body),
        "proposed",
        "https://github.com/deftai/directive",
    )

    assert vbrief["plan"]["narratives"]["Overview"] == body
    err = capsys.readouterr().err
    assert "unexpected control characters" in err
    assert "U+000B vertical tab" in err
    assert "U+0009 tab" in err
    assert "U+0008 backspace" in err
    assert "U+000C form feed" in err
