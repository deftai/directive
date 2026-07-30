import { describe, expect, it } from "vitest";
import {
  isDirectWriteTool,
  isMcpTool,
  isShellTool,
  isSpawnTool,
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
    expect(isDirectWriteTool("Shell")).toBe(false);
    expect(isSpawnTool("Task")).toBe(true);
    expect(isSpawnTool("Shell")).toBe(false);
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
  });
});
