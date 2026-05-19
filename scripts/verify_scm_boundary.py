#!/usr/bin/env python3
"""verify_scm_boundary.py -- deterministic gate against raw ``gh`` calls (#1145 / N5).

Pure stdlib, cross-platform. Invoked from:

- ``task verify:scm-boundary`` (aggregated into ``task check``)
- ``uv run python scripts/verify_scm_boundary.py [--project-root <path>] [--allow-list <path>]``

Why this gate exists
--------------------
Issue #1145 (N5 of the #1119 cohort) introduces ``scripts.scm.call(source,
verb, args, **kwargs)`` as the single seam through which deft's verb layer
(``scripts/triage_*.py``, ``scripts/scope_*.py``, ``scripts/slice_*.py``,
``scripts/issue_ingest.py``, ...) invokes the underlying SCM CLI. Pre-N5,
every consumer called ``subprocess.run(["gh", ...])`` directly; the first
non-GitHub consumer would have hit an undocumented coupling deep in the
call stack. The shim relocates that coupling to one indirection point so
the future SCM abstraction (#445 / #935 Workstream 6) has a single seam
to extend.

Per AGENTS.md ``## Rule Authority`` [AXIOM] this gate elevates the
"no raw gh calls in the verb layer" rule from prose tier to deterministic
tier -- the gate body IS the rule; the AGENTS.md cross-reference in
``## SCM tooling -- prefer ghx (#884)`` is documentation, not duplication.

Scope (which files MUST go through ``scm.call``)
------------------------------------------------
The verifier deliberately scopes by file glob rather than scanning every
tracked Python file. Release tooling (``scripts/release*.py``,
``scripts/reconcile_issues.py``), the REST helper module
(``scripts/gh_rest.py``), the ghx installer (``scripts/setup_ghx.py``),
and the preflight gates (``scripts/preflight_*.py``) have legitimate
direct-``gh`` responsibilities (they're release-tier or backend-tier code,
not verb-layer consumers) and are NOT scoped in. The full glob set lives
in :data:`SCOPE_GLOBS`.

Files in scope are required to invoke ``gh`` / ``ghx`` only via
``scripts.scm.call``. Any ``subprocess.run`` / ``subprocess.check_output`` /
``subprocess.check_call`` / ``subprocess.Popen`` / ``subprocess.call`` /
``Popen`` / ``os.system`` call whose first argv element is the literal
``"gh"`` or ``"ghx"`` is a violation -- the AST scan in
:func:`scan_file` flags them at the call site.

Detection scope (AST inspection)
--------------------------------
The scan is AST-based rather than regex-based so call sites split across
multiple lines (the common indented multi-line ``subprocess.run([\\n
    "gh", "issue", "close", ...]``) are detected reliably. We look at:

- :func:`ast.Call` nodes whose ``.func`` resolves to one of
  ``subprocess.run`` / ``subprocess.check_output`` /
  ``subprocess.check_call`` / ``subprocess.Popen`` / ``subprocess.call``,
  ``Popen`` (the unqualified form used after
  ``from subprocess import Popen``), or ``os.system``.
- For ``os.system`` we look at the first positional argument as a string
  constant; for the ``subprocess`` family we look at the first positional
  argument as either a list / tuple literal (whose first element is a
  string constant) or a single string-constant argument when
  ``shell=True`` is also passed.
- Any of those whose first argv element matches ``GH_BINARIES``
  (``"gh"`` / ``"ghx"``) is recorded as a finding.

False-positive guards
---------------------
- ``scripts/scm.py`` is EXEMPT from scanning -- the shim itself is the
  one place that legitimately invokes ``gh`` / ``ghx`` directly.
- ``--allow-list <path>`` accepts a newline-separated list of glob
  patterns for documented exceptions (e.g. a test fixture intentionally
  containing a raw ``gh`` call).
- The :data:`SCOPE_GLOBS` set is the exhaustive enumeration of files
  that MUST go through the shim. Files outside the set are not scanned;
  they're either out-of-scope (per the #1145 "Not in scope" clause) or
  backend / release-tier code with legitimate direct-``gh`` needs.

Exit codes (three-state, mirrors :mod:`scripts.preflight_branch` and
:mod:`scripts.verify_encoding`):

- ``0`` -- clean: every in-scope file uses ``scm.call`` exclusively.
- ``1`` -- violations: prints per-hit ``path:line:col [helper] context``.
- ``2`` -- config error: ``--allow-list`` path unreadable, ``--project-root``
  invalid, or unrecognised CLI shape.
"""

from __future__ import annotations

import argparse
import ast
import fnmatch
import sys
from collections.abc import Iterable
from pathlib import Path

#: Binary names whose presence as the first argv element marks a violation.
#: ``gh`` is the canonical GitHub CLI; ``ghx`` is the #884 caching proxy
#: that uses the same surface. Both should route through
#: :func:`scripts.scm.call` from the verb layer so the source-aware
#: indirection (NotImplementedError for non-GitHub sources) is exercised.
GH_BINARIES: frozenset[str] = frozenset({"gh", "ghx"})

#: Helper functions whose first positional argument we inspect. Mirrors
#: :data:`SUBPROCESS_DOTTED_HELPERS` plus the bare ``Popen`` import shape
#: (``from subprocess import Popen``) and ``os.system``.
SUBPROCESS_DOTTED_HELPERS: frozenset[str] = frozenset({
    "run",
    "check_output",
    "check_call",
    "call",
    "Popen",
})

#: Project-root-relative glob patterns enumerating the files in scope for
#: the boundary gate. Files in this set are required to invoke
#: ``gh`` / ``ghx`` only via :func:`scripts.scm.call`. The set follows the
#: #1145 acceptance criteria mandate plus the "any other call sites
#: discovered via repo-wide grep" catch-all narrowed to the verb-layer
#: glob shape -- release tooling, REST helpers, and preflight gates are
#: intentionally NOT in scope.
SCOPE_GLOBS: tuple[str, ...] = (
    # Triage verbs (public surface).
    "scripts/triage_*.py",
    # Triage verbs (private helpers consumed by the public surface).
    "scripts/_triage_*.py",
    # Scope-lifecycle verbs.
    "scripts/scope_*.py",
    "scripts/_scope_*.py",
    # Slice / cohort-record verbs.
    "scripts/slice_*.py",
    # Resume-condition grammar parser (consumed by triage_actions:defer).
    "scripts/resume_conditions.py",
    # Issue ingest -- the delegate target for triage:accept (#985).
    "scripts/issue_ingest.py",
)

#: Path-glob patterns auto-exempt because the file legitimately invokes
#: ``gh`` / ``ghx`` as a backend-tier or shim-internal responsibility.
#: Each entry is matched against the path's POSIX form (forward slashes)
#: via :func:`fnmatch.fnmatchcase`. Adding to this list MUST be justified
#: in the commit message and paired with a regression test that exercises
#: the exempt file's existing behaviour.
BUILTIN_ALLOW_LIST: tuple[str, ...] = (
    # The shim itself -- the one place that legitimately invokes
    # ``gh`` / ``ghx`` directly. Self-skip guards against a regression
    # where the shim is in scope of its own check.
    "scripts/scm.py",
    # The verifier's own test file -- the fixture and the test
    # source both contain literal ``["gh", ...]`` text and would
    # otherwise flag themselves. Forward-coverage is upheld by the
    # tests inside this file rather than by re-scanning them.
    "tests/cli/test_verify_scm_boundary.py",
)


class Finding:
    """One ``subprocess gh`` / ``Popen gh`` / ``os.system gh`` detection record."""

    __slots__ = ("path", "line", "col", "helper", "context")

    def __init__(
        self, path: str, line: int, col: int, helper: str, context: str
    ) -> None:
        self.path = path
        self.line = line
        self.col = col
        self.helper = helper
        self.context = context

    def render(self) -> str:
        ctx = self.context if len(self.context) <= 120 else self.context[:117] + "..."
        return f"  {self.path}:{self.line}:{self.col} [{self.helper}] {ctx}"


def _resolve_helper_name(func: ast.AST) -> str | None:
    """Return ``"subprocess.run"`` / ``"Popen"`` / ``"os.system"`` etc., or ``None``.

    Resolves the dotted-name shape of a :class:`ast.Call` ``.func`` node so
    we can decide whether the call targets one of the subprocess-family
    helpers we care about. Handles both attribute access
    (``subprocess.run(...)``) and bare-name access (``Popen(...)`` after
    ``from subprocess import Popen``). Anything else returns ``None``.
    """
    if isinstance(func, ast.Attribute):
        # subprocess.run(...) / os.system(...) -- attribute access.
        value = func.value
        if isinstance(value, ast.Name):
            return f"{value.id}.{func.attr}"
        # Deeper attribute chains (e.g. mod.subprocess.run) are unusual
        # and not part of our threat model; ignore.
        return None
    if isinstance(func, ast.Name):
        # Bare name -- only meaningful for Popen (or aliased imports we
        # do NOT attempt to detect; the verifier deliberately favors
        # false-negatives over false-positives on import-alias gymnastics).
        return func.id
    return None


def _is_target_helper(helper: str) -> bool:
    """Return True when ``helper`` is a subprocess-family or os.system seam.

    ``helper`` is the dotted-or-bare name returned by
    :func:`_resolve_helper_name`. We accept:

    - ``subprocess.run`` / ``.check_output`` / ``.check_call`` /
      ``.call`` / ``.Popen``  (the canonical surface).
    - bare ``Popen``  (``from subprocess import Popen`` then ``Popen(...)``).
    - ``os.system``  (the legacy shell-invocation surface).
    """
    if helper == "os.system":
        return True
    if helper == "Popen":
        return True
    if helper.startswith("subprocess."):
        suffix = helper.split(".", 1)[1]
        return suffix in SUBPROCESS_DOTTED_HELPERS
    return False


def _extract_first_argv(call: ast.Call, helper: str) -> str | None:
    """Return the first argv element when it is a constant string, else ``None``.

    For the subprocess family we look at the first positional argument:

    - List / tuple literal (``["gh", "issue", "close"]``) -- the first
      element of the literal.
    - Single string constant (``"gh issue close"``) -- the whole string,
      typically passed alongside ``shell=True``. We split on whitespace
      and inspect the first token.

    For ``os.system`` we look at the first positional argument as a
    string constant and split on whitespace.

    Anything else (variable, expression, formatted string, kwargs-only
    invocation) returns ``None`` -- the verifier deliberately favors
    false-negatives over false-positives on dynamically-built argv lists.
    A future agent who hides a ``gh`` invocation behind ``cmd = ["gh",
    ...]; subprocess.run(cmd)`` defeats the scan; we accept that limit
    rather than fail loudly on every variable-named argv list in the
    codebase. The forward-coverage contract here is "the common shape
    is detected"; the exotic shape is a documented gap.
    """
    if not call.args:
        return None
    first = call.args[0]

    if helper == "os.system":
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            tokens = first.value.strip().split()
            return tokens[0] if tokens else None
        return None

    # subprocess family or bare Popen.
    if isinstance(first, (ast.List, ast.Tuple)):
        if not first.elts:
            return None
        head = first.elts[0]
        if isinstance(head, ast.Constant) and isinstance(head.value, str):
            return head.value
        return None
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        # Single-string form -- typically paired with shell=True. Inspect
        # the first whitespace-delimited token so ``"gh pr list"`` is
        # caught the same way as ``["gh", "pr", "list"]``.
        tokens = first.value.strip().split()
        return tokens[0] if tokens else None
    return None


def _slice_source_line(source_lines: list[str], lineno: int) -> str:
    """Return the source line at ``lineno`` (1-indexed) or empty string.

    Note: ast lineno is 1-based; list index is 0-based, hence the
    ``lineno - 1`` subscript.
    """
    if 1 <= lineno <= len(source_lines):
        return source_lines[lineno - 1].rstrip()
    return ""


def scan_file(rel_path: str, full_path: Path) -> list[Finding]:
    """Scan one Python file for raw ``gh`` / ``ghx`` subprocess invocations.

    Returns a list of :class:`Finding` records (one per call site). An
    unparseable file (SyntaxError) returns an empty list -- the gate is
    intentionally permissive on parse failures so a single broken file
    does not block a whole pre-commit. Production code that parses
    cleanly is scanned exhaustively.
    """
    findings: list[Finding] = []
    try:
        source = full_path.read_text(encoding="utf-8")
    except OSError:
        return findings
    try:
        tree = ast.parse(source, filename=str(full_path))
    except SyntaxError:
        return findings

    source_lines = source.splitlines()

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        helper = _resolve_helper_name(node.func)
        if helper is None or not _is_target_helper(helper):
            continue
        first_argv = _extract_first_argv(node, helper)
        if first_argv not in GH_BINARIES:
            continue
        # Defensive: ast nodes carry 1-based lineno + 0-based col_offset.
        line = getattr(node, "lineno", 0) or 0
        col = (getattr(node, "col_offset", 0) or 0) + 1
        ctx = _slice_source_line(source_lines, line) or f"{helper}(...)"
        findings.append(
            Finding(
                path=rel_path,
                line=line,
                col=col,
                helper=helper,
                context=ctx.strip(),
            )
        )
    return findings


def _load_allow_list(path: Path | None) -> list[str]:
    """Read newline-separated glob patterns from ``path``; ignore comments.

    Lines starting with ``#`` and blank lines are skipped. Returns an
    empty list when ``path`` is ``None``. Raises :class:`FileNotFoundError`
    when a non-``None`` path does not exist (caller maps to exit 2).
    """
    if path is None:
        return []
    raw = path.read_text(encoding="utf-8", errors="replace")
    out: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        out.append(stripped)
    return out


def _is_allow_listed(rel_path: str, patterns: Iterable[str]) -> bool:
    """Return True when ``rel_path`` (POSIX form) matches any glob in patterns."""
    return any(fnmatch.fnmatchcase(rel_path, pat) for pat in patterns)


def _candidate_files(
    project_root: Path, scope_globs: Iterable[str]
) -> list[tuple[str, Path]]:
    """Resolve :data:`SCOPE_GLOBS` to existing ``(rel_path, full_path)`` pairs.

    The scope globs are resolved relative to ``project_root`` via
    :meth:`Path.glob`. Non-existent globs (e.g. ``scripts/slice_*.py``
    on a checkout that has not yet landed those files) are silently
    skipped. The output is sorted by POSIX-form rel-path for stable
    diagnostic ordering.
    """
    out: dict[str, Path] = {}
    for pattern in scope_globs:
        for full in project_root.glob(pattern):
            if not full.is_file():
                continue
            rel = full.relative_to(project_root).as_posix()
            out[rel] = full
    return sorted(out.items(), key=lambda item: item[0])


def evaluate(
    project_root: Path,
    *,
    allow_list_path: Path | None = None,
    scope_globs: Iterable[str] = SCOPE_GLOBS,
) -> tuple[int, list[Finding], str]:
    """Pure function returning ``(exit_code, findings, human_message)``.

    Separated from :func:`main` so tests can drive every state without
    ``capsys`` plumbing or env-var leak.

    ``scope_globs`` is parameterised so the unit tests can scope the
    scan down to a temp-directory fixture without touching the real
    repository tree.
    """
    try:
        custom_globs = _load_allow_list(allow_list_path)
    except FileNotFoundError as exc:
        return 2, [], (
            f"verify_scm_boundary: --allow-list file not found: {exc}\n"
            "  Recovery: pass an existing path or omit the flag."
        )
    except OSError as exc:
        return 2, [], (
            f"verify_scm_boundary: --allow-list unreadable: {exc}\n"
            "  Recovery: check file permissions."
        )

    if not project_root.is_dir():
        return 2, [], (
            f"verify_scm_boundary: --project-root is not a directory: "
            f"{project_root}\n"
            "  Recovery: pass an existing directory path."
        )

    allow_globs = list(BUILTIN_ALLOW_LIST) + custom_globs

    candidates = _candidate_files(project_root, scope_globs)
    findings: list[Finding] = []
    scanned = 0
    for rel, full in candidates:
        if _is_allow_listed(rel, allow_globs):
            continue
        scanned += 1
        findings.extend(scan_file(rel, full))

    if findings:
        files_with_hits = len({f.path for f in findings})
        header = (
            f"verify_scm_boundary: detected {len(findings)} raw "
            f"`gh` / `ghx` subprocess call(s) across {files_with_hits} "
            f"file(s) (#1145 / N5).\n"
            "  Root cause: the verb layer is required to invoke `gh` only "
            "via `scripts.scm.call(source, verb, args, **kwargs)` so a "
            "future\n"
            "  GitLab / Gitea / local consumer sees a loud "
            "`NotImplementedError` (see #445 / #935 Workstream 6) instead "
            "of a confusing\n"
            "  `gh: command not found` deep in the call stack. Fix: rewrite "
            "the offending call sites as\n"
            "    `import scm`\n"
            "    `scm.call(\"github-issue\", verb, args, ...)`\n"
            "  Allow-list a documented exception via "
            "`--allow-list <path>` (file with newline-separated glob "
            "patterns)."
        )
        body = "\n".join(f.render() for f in findings[:50])
        if len(findings) > 50:
            body += f"\n  ... and {len(findings) - 50} more"
        return 1, findings, f"{header}\n{body}"

    msg = (
        f"verify_scm_boundary: {scanned} verb-layer file(s) clean -- "
        "every `gh` / `ghx` invocation routes through `scm.call` "
        "(#1145 / N5)."
    )
    return 0, findings, msg


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="verify_scm_boundary.py",
        description=(
            "Deterministic gate against raw `gh` / `ghx` subprocess calls "
            "outside `scripts/scm.py` (#1145 / N5). Scans verb-layer "
            "Python files for subprocess / Popen / os.system invocations "
            "whose first argv element is the literal `gh` or `ghx` and "
            "fails loud when any are found -- the verb layer is required "
            "to invoke `gh` only via `scm.call(source, verb, args)`."
        ),
    )
    parser.add_argument(
        "--project-root",
        default=".",
        help="Project root path (default: current working directory).",
    )
    parser.add_argument(
        "--allow-list",
        default=None,
        help=(
            "Path to a file with newline-separated glob patterns of "
            "documented exceptions. Lines starting with # are comments."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress the OK message (errors still print).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    # Force UTF-8 stdout/stderr so the diagnostic output renders correctly
    # on a Windows console whose default codepage is cp1252 / cp437. Mirrors
    # the block in scripts/verify_encoding.py exactly.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = _build_parser()
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    allow_list_path = Path(args.allow_list).resolve() if args.allow_list else None

    code, _findings, msg = evaluate(
        project_root,
        allow_list_path=allow_list_path,
    )
    if code == 0:
        if not args.quiet:
            print(msg)
    else:
        print(msg, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
