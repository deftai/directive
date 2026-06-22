"""Tests for scripts/_content_root.py (#1875 C1 flatten dual-context resolver)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from _content_root import CONTENT_DIRNAME, content_root  # noqa: E402


def test_returns_content_subdir_when_present(tmp_path: Path) -> None:
    """Source checkout: content/ exists -> resolve under it."""
    (tmp_path / CONTENT_DIRNAME).mkdir()
    assert content_root(tmp_path) == tmp_path / CONTENT_DIRNAME


def test_returns_root_when_content_absent(tmp_path: Path) -> None:
    """Consumer deposit: no content/ dir -> resolve at the framework root."""
    assert content_root(tmp_path) == tmp_path


def test_accepts_str_framework_root(tmp_path: Path) -> None:
    """A string framework_root is coerced to Path (consumer layout)."""
    assert content_root(str(tmp_path)) == tmp_path


def test_content_file_does_not_count_as_root(tmp_path: Path) -> None:
    """A non-directory named ``content`` must not be mistaken for the dir."""
    (tmp_path / CONTENT_DIRNAME).write_text("not a dir", encoding="utf-8")
    assert content_root(tmp_path) == tmp_path
