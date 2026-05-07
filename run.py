"""
run.py — Test import shim for the Deft Directive CLI.

This file is NOT a CLI entry point. It exists solely to allow test code to import
functions from the extension-less `run` file using standard Python import machinery.

Usage in tests:
    from run import cmd_bootstrap, get_script_dir, get_default_paths

The `run` CLI itself is invoked via `run.bat` (Windows) or `./run` (Unix),
neither of which uses this file.

Author: Scott Adams (msadams) — 2026-03-09
"""

import importlib.machinery
import importlib.util
import sys
from pathlib import Path

# Load the extension-less `run` file as a Python module.
# spec_from_file_location returns None for extension-less files (can't detect type),
# so we explicitly use SourceFileLoader which treats the file as Python source.
_run_path = str(Path(__file__).parent / "run")
_loader = importlib.machinery.SourceFileLoader("deft_run", _run_path)
_spec = importlib.util.spec_from_loader("deft_run", _loader, origin=_run_path)
_module = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
# Explicitly set __file__ so functions like get_script_dir() that use
# Path(__file__) work correctly when called from tests.
_module.__file__ = _run_path  # type: ignore[assignment]
sys.modules["deft_run"] = _module
_loader.exec_module(_module)

# Re-export everything at module level so tests can do:
#   from run import cmd_bootstrap
# instead of:
#   from deft_run import cmd_bootstrap
from deft_run import *  # noqa: F401, F403
from deft_run import (
    cmd_bootstrap,
    cmd_project,
    cmd_validate,
    cmd_doctor,
    cmd_spec,
    cmd_install,
    cmd_reset,
    cmd_update,
    get_script_dir,
    get_default_paths,
    get_available_languages,
    get_available_strategies,
    ask_input,
    ask_choice,
    ask_confirm,
    print_header,
    print_section,
    print_info,
    print_success,
    print_warn,
    print_error,
    VERSION,
    _slugify,
)

__all__ = [
    "cmd_bootstrap",
    "cmd_project",
    "cmd_validate",
    "cmd_doctor",
    "cmd_spec",
    "cmd_install",
    "cmd_reset",
    "cmd_update",
    "get_script_dir",
    "get_default_paths",
    "get_available_languages",
    "get_available_strategies",
    "ask_input",
    "ask_choice",
    "ask_confirm",
    "print_header",
    "print_section",
    "print_info",
    "print_success",
    "print_warn",
    "print_error",
    "VERSION",
    "_slugify",
]
