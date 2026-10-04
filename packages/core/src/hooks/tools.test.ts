import { describe, expect, it } from "vitest";
import {
  DIRECT_WRITE_HOOK_MATCHER,
  HOST_TOOL_SURFACE_AUDIT,
  isApplyPatchTool,
  isDirectWriteTool,
  isKillTool,
  isMcpTool,
  isShellTool,
  isSpawnTool,
  KILL_HOOK_MATCHER,
  MCP_HOOK_MATCHER,
  MCP_PUSH_MERGE_BARE_NAMES,
  SHELL_HOOK_MATCHER,
  SHELL_TOOL_NAMES,
} from "./tools.js";

describe("hooks tools classifiers (#2711 / #2952)", () => {
  it("isShellTool recognizes host shell spellings and rejects others", () => {
    expect(isShellTool("Shell")).toBe(true);
    expect(isShellTool("Bash")).toBe(true);
    expect(isShellTool("shell")).toBe(true);
    expect(isShellTool("run_terminal_command")).toBe(true);
    expect(isShellTool("monitor")).toBe(true);
    expect(isShellTool("run_terminal_cmd")).toBe(false);
    expect(isShellTool("Write")).toBe(false);
    expect(isShellTool("")).toBe(false);
  });

  it("isMcpTool covers prefix, bare-prefix, and server__ bridge shapes", () => {
    expect(isMcpTool("")).toBe(false);
    expect(isMcpTool("   ")).toBe(false);
    expect(isMcpTool("mcp__github__create_issue")).toBe(true);
    expect(isMcpTool("mcp_github_create_issue")).toBe(true);
    expect(isMcpTool("server__push_to_remote")).toBe(true);
    // Direct-write / shell tools with __ must not be treated as MCP.
    expect(isMcpTool("Write")).toBe(false);
    expect(isMcpTool("Shell")).toBe(false);
    // Bare push/merge names are NOT isMcpTool — classifyMcpTool owns them.
    expect(isMcpTool("merge_pull_request")).toBe(false);
    expect(isMcpTool("git_push")).toBe(false);
  });

  it("isDirectWriteTool and isSpawnTool stay narrow", () => {
    expect(isDirectWriteTool("Write")).toBe(true);
    expect(isDirectWriteTool("Edit")).toBe(true);
    expect(isDirectWriteTool("EditNotebook")).toBe(true);
    expect(isDirectWriteTool("edit_notebook")).toBe(true);
    expect(DIRECT_WRITE_HOOK_MATCHER.split("|")).toContain("EditNotebook");
    expect(DIRECT_WRITE_HOOK_MATCHER.split("|")).toContain("edit_notebook");
    expect(isDirectWriteTool("Shell")).toBe(false);
    expect(isSpawnTool("Task")).toBe(true);
    expect(isSpawnTool("Shell")).toBe(false);
    expect(isApplyPatchTool("ApplyPatch")).toBe(true);
    expect(isApplyPatchTool("apply_patch")).toBe(true);
    expect(isApplyPatchTool("apply-patch")).toBe(true);
    expect(isApplyPatchTool("Write")).toBe(false);
    expect(isApplyPatchTool("Bash")).toBe(false);
  });

  it("downgrades Codex apply_patch write-form until a live payload is observed (#5094)", () => {
    expect(HOST_TOOL_SURFACE_AUDIT.codex.mutation.directWrite).toEqual([]);
    expect(HOST_TOOL_SURFACE_AUDIT.codex.mutation.shell).toContain("shell");
    expect(HOST_TOOL_SURFACE_AUDIT.codex.unobservedReason).toMatch(/apply_patch/i);
    expect(HOST_TOOL_SURFACE_AUDIT.codex.unobservedReason).toMatch(/#5094/);
    expect(HOST_TOOL_SURFACE_AUDIT.codex.unobservedReason).toMatch(/#5129/);
  });

  it("SHELL / MCP hook matchers include expected tokens", () => {
    for (const name of SHELL_TOOL_NAMES) {
      expect(SHELL_HOOK_MATCHER).toContain(name);
    }
    for (const bare of MCP_PUSH_MERGE_BARE_NAMES) {
      expect(MCP_HOOK_MATCHER).toContain(bare);
    }
    expect(MCP_HOOK_MATCHER).toContain("mcp__.*");
    expect(MCP_HOOK_MATCHER).toContain("git[_-]?push");
    expect(MCP_HOOK_MATCHER).toContain("CallMcpTool");
    expect(MCP_HOOK_MATCHER).toContain("use_tool");
  });

  it("isKillTool and KILL_HOOK_MATCHER cover Grok kill (#5281)", () => {
    expect(isKillTool("kill_command_or_subagent")).toBe(true);
    expect(isKillTool("Kill_Command_Or_Subagent")).toBe(true);
    expect(isKillTool("Write")).toBe(false);
    expect(KILL_HOOK_MATCHER).toBe("kill_command_or_subagent");
    expect(HOST_TOOL_SURFACE_AUDIT.grok.mutation.kill).toContain("kill_command_or_subagent");
    expect(HOST_TOOL_SURFACE_AUDIT.grok.nonMutation.kill_command_or_subagent).toBeUndefined();
  });
});
