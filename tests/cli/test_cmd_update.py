"""tests/cli/test_cmd_update.py -- vendored `run update` npm signpost (#1998).

The vendored ``run update`` command must not dead-end with a manual
"replace the deft directory" message post-freeze (#1912). It signposts
the canonical npm upgrade path instead.
"""

from __future__ import annotations

_DEAD_END = "Replace deft directory with latest version from repository"
_NOT_IMPLEMENTED = "Deft update functionality not yet implemented"


class TestCmdUpdateNpmSignpost:
    """#1998: cmd_update emits npm-canonical guidance, not the legacy dead-end."""

    def test_emits_npm_global_upgrade_command(self, run_command):
        result = run_command("cmd_update", [])
        assert result.return_code == 0
        assert "npm i -g @deftai/directive@latest" in result.stdout

    def test_emits_npx_project_refresh_command(self, run_command):
        result = run_command("cmd_update", [])
        assert result.return_code == 0
        assert "npx @deftai/directive update" in result.stdout

    def test_does_not_emit_replace_directory_dead_end(self, run_command):
        result = run_command("cmd_update", [])
        assert _DEAD_END not in result.stdout
        assert _NOT_IMPLEMENTED not in result.stdout

    def test_explains_run_update_does_not_replace_payload(self, run_command):
        result = run_command("cmd_update", [])
        assert "does not replace the payload" in result.stdout
