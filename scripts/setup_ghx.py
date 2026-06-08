#!/usr/bin/env python3
"""setup_ghx.py -- consent-gated ghx proxy installer for `task setup` (#884).

Wraps the `brunoborges/ghx <https://github.com/brunoborges/ghx>`_ caching
proxy installer behind an explicit-consent prompt so the maintainer's
``task setup`` never auto-installs network-fetched binaries by default. ghx
is the recommended drop-in proxy for ``gh`` -- it caches read-only API
calls so multi-agent swarms (and the deft ``scm:*`` task surface) do not
hammer the GitHub rate limiter; v0.26.0's ``scm:*`` stub already prefers
``ghx`` over ``gh`` at runtime via :mod:`scripts.scm`'s
``_BINARY_PREFERENCE`` ladder when ``ghx`` is on PATH. It is maintainer and
swarm tooling, not a consumer installer prerequisite: consumer installs require
``gh`` for GitHub-backed workflows and transparently ignore ``ghx`` when absent.

Behaviour matrix:

- ``ghx`` already on PATH -> print a one-line acknowledgement, exit 0.
- ``ghx`` missing, default (interactive) -> prompt for explicit consent
  (default *no*); on decline print a one-line "recommended for speed"
  note and exit 0.
- ``ghx`` missing, ``--yes`` flag -> skip the prompt and install
  unconditionally (CI / scripted approval path).
- ``ghx`` missing, ``--check`` flag -> never install, never prompt;
  print a one-line note when missing and exit 0. Used by the Taskfile
  step so ``task setup`` is non-interactive on a clean re-run.

Install dispatch is host-platform aware:

- Windows -> ``pwsh -Command "irm <install.ps1> | iex"``
- macOS / Linux -> ``curl -fsSL <install.sh> | bash``

The upstream URLs come from the ghx README; both installers honour the
upstream's documented contract. Network failures during install are
surfaced as exit 1 (the script does NOT retry).

Three-state exit (mirrors :mod:`scripts.preflight_branch` (#747) and
:mod:`scripts.migrate_preflight` (#793)):

- ``0`` -- ghx already present, user declined, or install succeeded.
- ``1`` -- install failure (subprocess non-zero, network error, or no
  install method available for the detected host).
- ``2`` -- config error (e.g. ``--yes`` and ``--check`` combined).

This script is intentionally pure-stdlib + ``subprocess`` so it can be
invoked from a fresh maintainer worktree before ``uv sync`` has run.

Refs #884.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from collections.abc import Sequence

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Pinned ghx version. CI workflows reference the same constant via env-var
#: indirection (see ``.github/workflows/ci.yml``); bump both surfaces in
#: lockstep so a future ghx security advisory only requires one edit.
GHX_VERSION: str = "v1.5.1"

#: Upstream installer URLs, pinned to :data:`GHX_VERSION` so the script the
#: pipe-trampoline executes is the script as it existed at the pinned tag
#: (closes Greptile #950 P2). The PowerShell installer drops binaries under
#: ``%LOCALAPPDATA%\\ghx\\bin`` and adds them to the user PATH; the bash
#: installer drops them under ``/usr/local/bin`` (override via
#: ``INSTALL_DIR=...``). Pinning the URL by tag rather than ``main``
#: prevents an upstream regression -- or a hypothetical compromise of the
#: default branch between when CI runs and when an operator runs
#: ``task setup:ghx`` -- from silently feeding altered shell into either
#: trampoline. Bump in lockstep with ``.github/workflows/ci.yml``
#: ``env.GHX_VERSION`` and the URLs under each ``Install ghx`` step.
INSTALL_PS1_URL: str = (
    f"https://raw.githubusercontent.com/brunoborges/ghx/{GHX_VERSION}/install.ps1"
)
INSTALL_SH_URL: str = (
    f"https://raw.githubusercontent.com/brunoborges/ghx/{GHX_VERSION}/install.sh"
)


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def ghx_present() -> bool:
    """Return True when ``ghx`` (or ``ghx.exe`` on Windows) is on PATH.

    Mirrors :func:`scripts.scm.resolve_binary` so the Taskfile-side check
    and the ``scm:*`` runtime ladder agree on the detection contract.
    """
    return shutil.which("ghx") is not None


def detect_host() -> str:
    """Return the canonical host tag: ``windows`` / ``darwin`` / ``linux``.

    Falls back to ``platform.system().lower()`` for anything else; the
    install-dispatch branch raises a friendly error in that case.
    """
    system = platform.system().lower()
    # Normalise the macOS reporting (``platform.system()`` returns
    # ``Darwin``); other hosts come through with sensible names already.
    if system == "darwin":
        return "darwin"
    if system == "windows":
        return "windows"
    if system == "linux":
        return "linux"
    return system


# ---------------------------------------------------------------------------
# Consent prompt
# ---------------------------------------------------------------------------


def prompt_consent(stream_in: object | None = None, stream_out: object | None = None) -> bool:
    """Render an interactive y/N consent prompt; default *no*.

    Args:
        stream_in: Optional input stream override (tests inject
            ``io.StringIO``). Defaults to ``sys.stdin``.
        stream_out: Optional output stream override. Defaults to
            ``sys.stdout``.

    Returns:
        True when the operator typed ``y`` / ``yes`` (case-insensitive);
        False on empty / EOF / anything else. Default-deny matches the
        #884 constraint that install MUST require explicit consent.
    """
    sin = stream_in if stream_in is not None else sys.stdin
    sout = stream_out if stream_out is not None else sys.stdout
    print(
        "\n[setup_ghx] ghx is the recommended GitHub CLI cache proxy for deft "
        "maintainers (prevents rate-limiting in multi-agent swarms; speeds up "
        "scm:* calls). Consumer projects only require gh.",
        file=sout,
    )
    print(f"[setup_ghx] Upstream: https://github.com/brunoborges/ghx ({GHX_VERSION})", file=sout)
    print("[setup_ghx] Install ghx via the upstream installer? [y/N]: ", end="", file=sout)
    sout.flush()
    try:
        # ``readline`` returns ``""`` on EOF (e.g. piped non-tty); treat
        # as decline so a non-interactive ``task setup`` never installs by
        # accident -- ``--yes`` is the explicit non-interactive path.
        line = sin.readline()
    except (EOFError, KeyboardInterrupt):
        return False
    answer = (line or "").strip().lower()
    return answer in ("y", "yes")


# ---------------------------------------------------------------------------
# Install dispatch
# ---------------------------------------------------------------------------


def build_install_command(host: str) -> list[str]:
    """Return the argv that will fetch + run the upstream installer.

    Tests assert against the returned shape so a regression that changed
    the installer URL or the shell trampoline would fail loudly here
    rather than silently dispatching the wrong network call.

    Args:
        host: One of ``windows`` / ``darwin`` / ``linux``. Anything else
            raises :class:`RuntimeError`.

    Returns:
        Argv list ready for :func:`subprocess.run`.
    """
    if host == "windows":
        # Use ``pwsh`` (PS 7+) when available, falling back to
        # ``powershell`` (Windows PS 5.1). The installer itself is
        # ASCII-only per the upstream README so PS 5.1's cp1252 default
        # does not corrupt the script body.
        ps_bin = shutil.which("pwsh") or shutil.which("powershell") or "powershell"
        return [
            ps_bin,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            f"irm {INSTALL_PS1_URL} | iex",
        ]
    if host in ("darwin", "linux"):
        # ``curl | bash`` mirrors the upstream README's "Quick install
        # script" path. ``-fsSL`` makes curl fail loud on HTTP 4xx/5xx
        # rather than piping an HTML error page into bash.
        return ["bash", "-c", f"curl -fsSL {INSTALL_SH_URL} | bash"]
    raise RuntimeError(
        f"no upstream ghx installer available for host {host!r}; "
        "see https://github.com/brunoborges/ghx#install for manual options"
    )


def install_ghx(host: str, *, runner: object | None = None) -> int:
    """Invoke the upstream installer. Returns the subprocess exit code.

    Args:
        host: The detected host tag (see :func:`detect_host`).
        runner: Optional ``subprocess.run``-compatible callable for
            test injection. Defaults to :func:`subprocess.run`.

    Returns:
        The installer's exit code (0 on success).

    Closes Greptile #950 P1: ``GHX_VERSION`` MUST be injected into the
    subprocess environment because the upstream ``install.sh`` /
    ``install.ps1`` honour ``${GHX_VERSION}`` as the version-pin hook.
    Without this, the version constant in this module was a no-op at
    install time -- the operator-side ``task setup:ghx`` could install a
    different binary version than the CI pre-install step despite the
    documented lockstep contract.
    """
    cmd = build_install_command(host)
    run = runner if runner is not None else subprocess.run
    print(f"[setup_ghx] Invoking upstream installer: {' '.join(cmd)}", file=sys.stderr)
    install_env = {**os.environ, "GHX_VERSION": GHX_VERSION}
    proc = run(cmd, check=False, env=install_env)
    return int(getattr(proc, "returncode", 1))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="setup_ghx.py",
        description=(
            "Consent-gated installer for the ghx GitHub CLI cache proxy "
            "(brunoborges/ghx). See #884 for the adoption rationale."
        ),
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help=(
            "Non-interactive consent (CI / scripted approval). Skip the y/N "
            "prompt and install unconditionally when ghx is missing."
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help=(
            "Detection-only mode: print whether ghx is on PATH, then exit 0. "
            "Never prompt, never install. Used by the Taskfile step so "
            "`task setup` stays non-interactive on a clean re-run."
        ),
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point. See module docstring for the exit-code contract."""
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.yes and args.check:
        print(
            "[setup_ghx] error: --yes and --check are mutually exclusive.",
            file=sys.stderr,
        )
        return 2

    if ghx_present():
        # ASCII-only success line so PS 5.1 cp1252 stdout never corrupts
        # the output. The leading tag mirrors `[setup_windows] ...` in
        # scripts/setup_windows.ps1 so operators see one consistent
        # provenance prefix across the setup surface.
        print("[setup_ghx] ghx already on PATH -- skipping install.")
        return 0

    if args.check:
        print(
            "[setup_ghx] ghx not on PATH; recommended for speed -- "
            "run `task setup` (without --check) to opt in. Consumer projects "
            "only require gh. Refs #884."
        )
        return 0

    consent: bool
    if args.yes:
        consent = True
        print("[setup_ghx] --yes provided; skipping interactive consent prompt.")
    else:
        # Honour the documented opt-out env-var so non-interactive shells
        # (CI hooks, dotfile bootstraps) can suppress the prompt without
        # passing --check explicitly. This is purely additive -- the
        # default still requires explicit consent.
        if os.environ.get("DEFT_SETUP_GHX_SKIP", "").strip() in ("1", "true", "yes"):
            print(
                "[setup_ghx] DEFT_SETUP_GHX_SKIP set; skipping ghx install. "
                "Refs #884."
            )
            return 0
        consent = prompt_consent()

    if not consent:
        print(
            "[setup_ghx] Skipping ghx install. ghx is recommended for speed "
            "for maintainers and swarm runs; consumer projects only require gh "
            "(see https://github.com/brunoborges/ghx, #884)."
        )
        return 0

    host = detect_host()
    try:
        rc = install_ghx(host)
    except RuntimeError as exc:
        print(f"[setup_ghx] error: {exc}", file=sys.stderr)
        return 1
    if rc != 0:
        print(
            f"[setup_ghx] error: upstream installer exited {rc}. "
            "See https://github.com/brunoborges/ghx#install for manual options.",
            file=sys.stderr,
        )
        return 1
    print(
        "[setup_ghx] ghx installed. Open a fresh shell so the updated PATH "
        "takes effect, then re-run `task setup` to verify."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
