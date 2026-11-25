/**
 * Root-mismatch recovery admit (#6599): the refusal's own named recovery
 * commands run as exact simple commands; everything else stays refused, and
 * the foreign-runtime-link branch (#6185) admits nothing.
 */
import { HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE } from "@deftai/directive-core/dist/install-health/constants.js";
import type { CheapInSyncResult } from "@deftai/directive-core/dist/install-health/types.js";
import { describe, expect, it } from "vitest";
import { run } from "./hook-dispatch.js";

const OK_CHEAP: CheapInSyncResult = {
  ok: true,
  pinVersion: "0.129.9",
  installedVersion: "0.129.9",
  identityMatch: true,
  readinessValid: true,
  failClosed: false,
  pinMismatchOnly: false,
  allowSetup: true,
  recoveryGuidance: null,
};

const HOSTS = ["claude", "cursor", "grok", "codex"] as const;

function toolFor(host: string): string {
  if (host === "cursor") return "Shell";
  if (host === "grok") return "run_terminal_command";
  return "Bash";
}

function payloadFor(host: string, toolName: string, command: string): string {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: { command },
    cwd: "/worktree",
    ...(host === "cursor" ? { workspace_roots: ["/worktree"] } : {}),
  });
}

interface Outcome {
  readonly raw: string;
  readonly wire: Record<string, unknown>;
  readonly text: string;
}

function dispatch(host: string, command: string, opts: { toolName?: string } = {}): Outcome {
  const out: string[] = [];
  const code = run([`--host=${host}`, "--event=tool.before", "--project-root=/worktree"], {
    readStdin: () => payloadFor(host, opts.toolName ?? toolFor(host), command),
    writeOut: (t) => out.push(t),
    writeErr: () => undefined,
    cwd: () => "/worktree",
    stdinEmptyRetryMs: 0,
    launchingCheckoutRoot: () => "/primary",
    launcherPath: () => undefined,
    cheapInSync: () => OK_CHEAP,
  });
  expect(code).toBe(0);
  const raw = out.join("").trim();
  const wire = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
  return { raw, wire, text: raw };
}

function denied(o: Outcome): boolean {
  return (
    o.wire.decision === "deny" ||
    o.wire.permission === "deny" ||
    o.text.includes("payload project root does not match")
  );
}

describe("root-mismatch recovery admit (#6599)", () => {
  it.each(HOSTS)("admits each recovery command on %s and names the admission", (host) => {
    const commands = [
      "directive --version",
      "deft --version",
      "directive doctor",
      `directive policy:disable-host-hooks --host ${host} --confirm`,
      `deft policy:disable-host-hooks --host ${host} --confirm`,
    ];
    for (const command of commands) {
      const o = dispatch(host, command);
      expect(denied(o), `${host}: ${command}`).toBe(false);
      expect(o.text.includes("payload project root does not match")).toBe(false);
    }
  });

  it.each(HOSTS)("refuses chained, extended and other commands on %s", (host) => {
    const commands = [
      "directive doctor && rm x",
      "directive doctor; echo hi",
      "directive doctor | cat",
      "directive doctor > out.txt",
      "directive doctor --full",
      "git status",
      "echo hi",
      `directive policy:disable-host-hooks --host ${host}`,
      `directive policy:disable-host-hooks --host ${host === "grok" ? "cursor" : "grok"} --confirm`,
    ];
    for (const command of commands) {
      const o = dispatch(host, command);
      expect(denied(o), `${host}: ${command}`).toBe(true);
      expect(o.text).toContain(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE);
    }
  });

  it("refuses a non-shell tool even with a recovery command", () => {
    const o = dispatch("grok", "directive doctor", { toolName: "write_file" });
    expect(denied(o)).toBe(true);
  });

  it("lists the admitted commands in the refusal text", () => {
    const o = dispatch("grok", "echo hi");
    for (const needle of [
      "directive --version",
      "deft --version",
      "directive doctor",
      "policy:disable-host-hooks",
      "new session",
    ]) {
      expect(o.text).toContain(needle);
    }
  });
});

describe("Claude hard-refuse non-gated MCP admit under root-mismatch (#7352)", () => {
  function mcpDispatch(
    host: string,
    toolName: string,
    toolInput: Record<string, unknown> = {},
  ): Outcome {
    const out: string[] = [];
    const code = run([`--host=${host}`, "--event=tool.before", "--project-root=/worktree"], {
      readStdin: () =>
        JSON.stringify({
          tool_name: toolName,
          tool_input: toolInput,
          cwd: "/worktree",
        }),
      writeOut: (t) => out.push(t),
      writeErr: () => undefined,
      cwd: () => "/worktree",
      stdinEmptyRetryMs: 0,
      launchingCheckoutRoot: () => "/primary",
      launcherPath: () => undefined,
      cheapInSync: () => OK_CHEAP,
    });
    expect(code).toBe(0);
    const raw = out.join("").trim();
    const wire = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
    return { raw, wire, text: raw };
  }

  it("admits sanitized Claude host UI MCP names", () => {
    for (const toolName of ["mcp__ccd_turn__wrap_up", "mcp__ccd_turn__task_list"]) {
      const o = mcpDispatch("claude", toolName);
      expect(denied(o), toolName).toBe(false);
      expect(o.text).toMatch(/not-gated|non-gated|#7352/i);
    }
  });

  it.each([
    ["Bash", {}],
    ["Edit", { file_path: "/worktree/x.ts" }],
    ["Write", { file_path: "/worktree/x.ts" }],
    ["CallMcpTool", { tool_name: "mcp__ccd_turn__wrap_up" }],
    ["use_tool", { tool_name: "mcp__ccd_turn__wrap_up" }],
    ["mcp__github__merge_pull_request", {}],
    ["mcp__fs__edit_record", { path: "/tmp/x" }],
  ])("still refuses %s", (toolName, toolInput) => {
    const o = mcpDispatch("claude", toolName, toolInput);
    expect(denied(o)).toBe(true);
    expect(o.text).toContain(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE);
  });

  it("does not admit on non-Claude hosts", () => {
    const o = mcpDispatch("grok", "mcp__ccd_turn__wrap_up");
    expect(denied(o)).toBe(true);
  });
});
