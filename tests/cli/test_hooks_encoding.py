"""Tests for cp1252 -> UTF-8 stdout self-reconfigure at hook-script entry (#814).

Pin the contract that every script under ``scripts/`` referenced from
``.githooks/`` reconfigures ``sys.stdout`` and ``sys.stderr`` to UTF-8 with
``errors='replace'`` at ``main()`` entry, BEFORE any ``print()``.

Without this fix, a Windows shell whose Python defaults to ``cp1252``
stdout (the OS default) crashes with ``UnicodeEncodeError`` when the gate
prints its U+2713 success glyph AFTER the gate has already approved the
commit -- the user sees a Python traceback after a successful check, and
git aborts the commit. See the issue body of #814 for the verbatim
reproduction.

Strategy: monkeypatch ``sys.stdout`` and ``sys.stderr`` to a
``TextIOWrapper`` wrapping a ``BytesIO`` with ``encoding='cp1252'`` and
``errors='strict'`` so the test ENVIRONMENT exactly mirrors the production
Windows-cp1252 shape. Invoke ``preflight_branch.main(...)`` and assert:

- main() returns 0 (no exception, no traceback).
- ``sys.stdout.encoding`` is ``utf-8`` post-call (the reconfigure landed).
- The U+2713 success glyph reaches the underlying ``BytesIO`` buffer
  encoded as the canonical UTF-8 byte sequence (0xE2 0x9C 0x93).

The audit surface is currently exactly one script: ``scripts/preflight_branch.py``
is the only file referenced from ``.githooks/pre-commit`` and ``.githooks/pre-push``.
The ``HOOK_SCRIPTS`` registry below makes the contract trivially extensible --
add a new (label, path, args, env) tuple when a future hook script lands.
"""

from __future__ import annotations

import importlib.util
import io
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
GITHOOKS_DIR = REPO_ROOT / ".githooks"

#: U+2713 (CHECK MARK) encoded as canonical UTF-8 -- the success-path glyph
#: the production hook prints. cp1252 has no mapping for this code point,
#: so a strict cp1252 wrapper raises UnicodeEncodeError on encode.
U2713_UTF8_BYTES = b"\xe2\x9c\x93"

#: Registry of every hook-invoked script under ``scripts/``. Each entry is
#: (label, relative_script_path, argv_for_main, env_to_set_for_test). The
#: env_to_set value is consumed by the test fixture and reset by monkeypatch.
HOOK_SCRIPTS: list[tuple[str, str, list[str], dict[str, str]]] = [
    (
        "preflight_branch",
        "scripts/preflight_branch.py",
        # --quiet is intentionally NOT passed: the test must exercise the
        # success-path print so we can observe the UTF-8 bytes in the
        # underlying buffer. The setup-interview env-var short-circuits
        # the policy lookup so the test does not need a real PROJECT-DEFINITION.
        ["--project-root", "{tmp_path}"],
        {"DEFT_SETUP_INTERVIEW": "1"},
    ),
    (
        # #798: deterministic-tier PS 5.1 non-ASCII corruption gate. Invoked
        # from .githooks/pre-commit AFTER preflight_branch via
        # ``verify_encoding.py --staged``. Pinned to the same UTF-8 self-
        # reconfigure contract; sibling regression coverage in
        # tests/cli/test_verify_encoding.py exercises evaluate() and the
        # full main() exit-code matrix beyond what this audit asserts.
        # The fixture ``_init_git_repo`` flag below tells the parametrized
        # test to ``git init`` ``{tmp_path}`` before invoking main(), so
        # ``git ls-files`` (the --all dispatch) returns an empty clean set
        # and the script prints its U+2713 success glyph the contract pins.
        "verify_encoding",
        "scripts/verify_encoding.py",
        ["--all", "--project-root", "{tmp_path}"],
        {"_init_git_repo": "1"},
    ),
]


def _load_module(name: str, path: Path):
    """Load a sibling-import-style module by file path (mirrors test_preflight_branch)."""
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _make_cp1252_wrapper() -> tuple[io.BytesIO, io.TextIOWrapper]:
    """Return (buffer, wrapper) emulating a Windows-cp1252 stdout/stderr.

    ``write_through=True`` ensures every write hits the underlying BytesIO
    immediately so we don't have to flush before asserting on bytes.
    ``errors='strict'`` ensures any non-cp1252-encodable codepoint raises
    UnicodeEncodeError -- which is exactly the production failure mode
    on Windows with PYTHONIOENCODING unset.
    """
    buf = io.BytesIO()
    wrapper = io.TextIOWrapper(
        buf,
        encoding="cp1252",
        errors="strict",
        write_through=True,
    )
    return buf, wrapper


def test_audit_only_preflight_branch_is_hook_invoked():
    """Defence-in-depth: if a future hook script lands, this test fails loudly.

    The audit surface is the union of scripts under ``scripts/`` referenced
    from any file in ``.githooks/``. Today that set is exactly
    ``scripts/preflight_branch.py``. When a new hook script is added, the
    HOOK_SCRIPTS registry above MUST grow a corresponding entry so the
    contract test runs against it. This test detects the gap structurally
    by re-doing the audit at test time.
    """
    referenced: set[str] = set()
    for hook_path in sorted(GITHOOKS_DIR.iterdir()):
        if not hook_path.is_file():
            continue
        text = hook_path.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            # Match any 'scripts/<name>.py' token in the hook body.
            for token in stripped.replace('"', " ").replace("'", " ").split():
                # Normalise repo-root and $REPO_ROOT prefixes.
                if "scripts/" in token and token.endswith(".py"):
                    suffix = token[token.index("scripts/"):]
                    referenced.add(suffix)

    assert referenced, (
        "No scripts/*.py references found under .githooks/ -- the audit "
        "regex is broken or .githooks/ has been restructured."
    )

    registered = {entry[1] for entry in HOOK_SCRIPTS}
    missing = referenced - registered
    assert not missing, (
        "Hook script(s) discovered under .githooks/ are NOT registered in "
        f"HOOK_SCRIPTS: {sorted(missing)}. Add a tuple for each missing "
        "script so the cp1252 self-reconfigure contract is enforced for "
        "every hook-invoked surface (#814)."
    )


@pytest.mark.parametrize(
    ("label", "rel_path", "argv_template", "env"),
    HOOK_SCRIPTS,
    ids=[entry[0] for entry in HOOK_SCRIPTS],
)
def test_hook_script_self_reconfigures_stdout_to_utf8(
    label: str,
    rel_path: str,
    argv_template: list[str],
    env: dict[str, str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Contract test pinning the #814 cp1252 -> UTF-8 self-reconfigure.

    Reproduces the production Windows-cp1252 shape via a strict cp1252
    TextIOWrapper around a BytesIO. The fix is verified by three orthogonal
    assertions: (1) main() returns 0 with no exception, (2) sys.stdout.encoding
    is utf-8 after main() runs, (3) the U+2713 glyph reaches the underlying
    buffer as the canonical UTF-8 byte sequence (0xE2 0x9C 0x93).

    Without the reconfigure block at main() entry, assertion (1) raises
    UnicodeEncodeError -- this test would have caught the original bug
    if it had existed before #814.
    """
    # Sanity: a strict cp1252 wrapper truly cannot encode U+2713. If this
    # invariant ever changes (e.g. Python widens cp1252 fallbacks), this
    # whole test becomes vacuous and we want the failure to be obvious.
    pre_buf, pre_wrapper = _make_cp1252_wrapper()
    with pytest.raises(UnicodeEncodeError):
        pre_wrapper.write("\u2713")
    pre_buf.close()

    # Wire the test environment.
    out_buf, fake_stdout = _make_cp1252_wrapper()
    err_buf, fake_stderr = _make_cp1252_wrapper()
    monkeypatch.setattr(sys, "stdout", fake_stdout)
    monkeypatch.setattr(sys, "stderr", fake_stderr)

    # Pseudo-env keys (prefixed with ``_``) are fixture directives, not real
    # env vars. ``_init_git_repo`` initializes a minimal git working tree at
    # ``{tmp_path}`` so scripts that shell out to ``git ls-files`` /
    # ``git diff --cached`` (e.g. #798's verify_encoding.py) traverse a real
    # repo. Real env entries pass through to monkeypatch unchanged.
    needs_git_repo = env.pop("_init_git_repo", "") == "1"
    if needs_git_repo:
        subprocess.run(
            ["git", "init", "--quiet", "--initial-branch=main", str(tmp_path)],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(tmp_path), "config", "user.email", "test@example.com"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(tmp_path), "config", "user.name", "Test"],
            check=True,
        )
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    # Resolve argv template -- {tmp_path} is the only supported placeholder.
    argv = [arg.format(tmp_path=str(tmp_path)) for arg in argv_template]

    # Load the script as a module and call main() directly.
    script_path = REPO_ROOT / rel_path
    assert script_path.is_file(), f"hook script missing on disk: {script_path}"
    # policy.py must be import-resolvable as a sibling first; preflight_branch
    # uses ``from policy import ...`` after a sys.path tweak.
    _load_module("policy", SCRIPTS_DIR / "policy.py")
    module = _load_module(label, script_path)

    # Drive the script. main() must return cleanly -- if the reconfigure
    # block were absent, this would raise UnicodeEncodeError on the print.
    code = module.main(argv)
    assert code == 0, (
        f"{label}.main({argv}) returned {code}; expected 0 (setup-interview "
        "exemption short-circuit)."
    )

    # The reconfigure must have flipped the encoding on both streams.
    assert sys.stdout.encoding.lower() == "utf-8", (
        f"sys.stdout.encoding is {sys.stdout.encoding!r} after {label}.main(); "
        "expected 'utf-8' (the #814 self-reconfigure must run BEFORE any print)."
    )
    assert sys.stderr.encoding.lower() == "utf-8", (
        f"sys.stderr.encoding is {sys.stderr.encoding!r} after {label}.main(); "
        "expected 'utf-8' (stderr must reconfigure too because error-path "
        "messages also carry non-ASCII glyphs)."
    )

    # The U+2713 success glyph must have reached the underlying buffer
    # as canonical UTF-8 bytes. errors='replace' on the production
    # reconfigure ensures the print never crashes; this assertion ensures
    # the byte sequence is the *intended* UTF-8 encoding rather than a
    # silent replacement char.
    assert U2713_UTF8_BYTES in out_buf.getvalue(), (
        f"U+2713 (b'\\xe2\\x9c\\x93') not present in stdout buffer after "
        f"{label}.main(); buffer contents: {out_buf.getvalue()!r}"
    )
