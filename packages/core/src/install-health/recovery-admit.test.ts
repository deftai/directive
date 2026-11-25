/**
 * Pin-mismatch recovery admit (#6313): only the named recovery commands, as
 * simple uncompounded commands at the project root, when pin ≠ installed is the
 * only fault.
 */
import { describe, expect, it } from "vitest";
import {
  admitPinMismatchRecovery,
  isPinMismatchOnly,
  matchPinMismatchRecoveryCommand,
  PIN_MISMATCH_RECOVERY_COMMANDS,
  PIN_MISMATCH_SIMPLE_COMMAND_SOURCE,
} from "./index.js";
import {
  admitHardRefuseNonGatedMcp,
  admitRootMismatchRecovery,
  matchRootMismatchRecoveryCommand,
  rootMismatchRecoveryCommands,
} from "./recovery-admit.js";
import type { CheapInSyncResult } from "./types.js";

function cheap(overrides: Partial<CheapInSyncResult> = {}): CheapInSyncResult {
  return {
    ok: false,
    pinVersion: "0.129.9",
    installedVersion: "0.129.8",
    identityMatch: false,
    readinessValid: false,
    failClosed: true,
    pinMismatchOnly: true,
    allowSetup: false,
    recoveryGuidance: "x",
    ...overrides,
  };
}

describe("matchPinMismatchRecoveryCommand (#6313)", () => {
  it.each([
    ["pnpm install --frozen-lockfile", "pnpm install --frozen-lockfile"],
    ["npm install", "npm install"],
    ["npm ci", "npm ci"],
    ["  pnpm   install\t--frozen-lockfile  ", "pnpm install --frozen-lockfile"],
  ])("admits %j", (command, canonical) => {
    expect(matchPinMismatchRecoveryCommand(command)).toBe(canonical);
  });

  it.each([
    "pnpm install --frozen-lockfile && git status",
    "pnpm install --frozen-lockfile; rm -rf x",
    "pnpm install --frozen-lockfile || true",
    "pnpm install --frozen-lockfile | tee log",
    "pnpm install --frozen-lockfile > log",
    "pnpm install --frozen-lockfile &",
    "cd other && pnpm install --frozen-lockfile",
    "pnpm install --frozen-lockfile\ngit status",
    "pnpm install --frozen-lockfile $(echo x)",
    "pnpm install --frozen-lockfile `echo x`",
    'pnpm install "--frozen-lockfile"',
    "pnpm --dir other install --frozen-lockfile",
    "pnpm -C other install --frozen-lockfile",
    "pnpm install",
    "pnpm install --frozen-lockfile --force",
    "npm install left-pad",
    "npm i -g @deftai/directive@latest",
    // Global AC9.7 pair is not admitted (#6313 operator correction; sealed #5956).
    "npm i -g @deftai/directive",
    "directive install --repair",
    "directive install",
    "git status",
    "",
  ])("refuses %j", (command) => {
    expect(matchPinMismatchRecoveryCommand(command)).toBeNull();
  });

  it("refuses a null command", () => {
    expect(matchPinMismatchRecoveryCommand(null)).toBeNull();
  });

  it("names exactly the refusal's recovery set", () => {
    expect(PIN_MISMATCH_RECOVERY_COMMANDS.map((tokens) => tokens.join(" "))).toEqual([
      "pnpm install --frozen-lockfile",
      "npm install",
      "npm ci",
    ]);
  });

  it("exports the simple-command source shared with the host-hook outer (#7275)", () => {
    expect(new RegExp(PIN_MISMATCH_SIMPLE_COMMAND_SOURCE).test("npm install")).toBe(true);
    expect(new RegExp(PIN_MISMATCH_SIMPLE_COMMAND_SOURCE).test("npm install; rm -rf x")).toBe(
      false,
    );
  });
});

describe("isPinMismatchOnly (#6313)", () => {
  it("is true only for a fail-closed pin mismatch with no other fault", () => {
    expect(isPinMismatchOnly(cheap())).toBe(true);
    expect(isPinMismatchOnly(cheap({ pinMismatchOnly: false }))).toBe(false);
    expect(isPinMismatchOnly(cheap({ failClosed: false }))).toBe(false);
  });

  it("reads an absent field as false", () => {
    const { pinMismatchOnly: _omit, ...rest } = cheap();
    expect(isPinMismatchOnly(rest)).toBe(false);
  });
});

describe("admitPinMismatchRecovery (#6313)", () => {
  const base = {
    cheap: cheap(),
    shellTool: true,
    command: "pnpm install --frozen-lockfile",
    atProjectRoot: true,
  };

  it("admits the named recovery through a shell tool at the project root", () => {
    expect(admitPinMismatchRecovery(base)).toBe("pnpm install --frozen-lockfile");
  });

  it("refuses when an overlay or other fault is present", () => {
    expect(admitPinMismatchRecovery({ ...base, cheap: cheap({ pinMismatchOnly: false }) })).toBe(
      null,
    );
  });

  it("refuses outside a shell tool", () => {
    expect(admitPinMismatchRecovery({ ...base, shellTool: false })).toBeNull();
  });

  it("refuses away from the project root", () => {
    expect(admitPinMismatchRecovery({ ...base, atProjectRoot: false })).toBeNull();
  });

  it("refuses any other command", () => {
    expect(admitPinMismatchRecovery({ ...base, command: "git status" })).toBeNull();
  });
});

describe("root-mismatch recovery admit (#6599)", () => {
  it("lists the diagnostics and both disable forms for the host", () => {
    expect(rootMismatchRecoveryCommands("cursor")).toEqual([
      "directive --version",
      "deft --version",
      "directive doctor",
      "directive policy:disable-host-hooks --host cursor --confirm",
      "deft policy:disable-host-hooks --host cursor --confirm",
    ]);
  });

  it.each([
    "directive --version",
    "deft --version",
    "directive doctor",
    "  directive   doctor  ",
    "deft policy:disable-host-hooks --host grok --confirm",
    "directive policy:disable-host-hooks --host grok --confirm",
  ])("admits %j for grok", (command) => {
    expect(admitRootMismatchRecovery({ shellTool: true, command, host: "grok" })).not.toBeNull();
  });

  it.each([
    "directive doctor && rm x",
    "directive doctor; echo hi",
    "directive doctor | cat",
    "directive doctor > out.txt",
    "directive doctor --full",
    "directive install --repair",
    "git status",
    "directive policy:disable-host-hooks --host cursor --confirm",
    "directive policy:disable-host-hooks --host grok",
    "",
  ])("refuses %j for grok", (command) => {
    expect(admitRootMismatchRecovery({ shellTool: true, command, host: "grok" })).toBeNull();
  });

  it("refuses a missing command and a non-shell tool", () => {
    expect(matchRootMismatchRecoveryCommand(null, "claude")).toBeNull();
    expect(
      admitRootMismatchRecovery({ shellTool: false, command: "directive doctor", host: "claude" }),
    ).toBeNull();
  });
});

describe("admitHardRefuseNonGatedMcp (#7352)", () => {
  it.each([
    "mcp__ccd_turn__wrap_up",
    "mcp__ccd_turn__task_list",
    "mcp__claude_code__browser",
  ])("admits host UI MCP %j", (toolName) => {
    expect(admitHardRefuseNonGatedMcp({ toolName, mcpArgsText: null })).toBe(true);
  });

  it.each([
    ["Bash", null],
    ["Edit", null],
    ["Write", null],
    ["CallMcpTool", '{"tool_name":"mcp__ccd_turn__wrap_up"}'],
    ["use_tool", '{"tool_name":"mcp__ccd_turn__wrap_up"}'],
    ["mcp__github__merge_pull_request", null],
    ["mcp__git__git_push", null],
    ["mcp__fs__edit_record", '{"path":"/tmp/x"}'],
    ["mcp__fs__create_note", '{"path":"/tmp/x"}'],
    ["mcp__github__create_issue", '{"title":"x"}'],
  ])("refuses %j", (toolName, mcpArgsText) => {
    expect(admitHardRefuseNonGatedMcp({ toolName, mcpArgsText })).toBe(false);
  });

  it("refuses blank tool names", () => {
    expect(admitHardRefuseNonGatedMcp({ toolName: "", mcpArgsText: null })).toBe(false);
    expect(admitHardRefuseNonGatedMcp({ toolName: "   ", mcpArgsText: null })).toBe(false);
  });
});
