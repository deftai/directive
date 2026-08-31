import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_HOSTS } from "../hooks/dispatcher.js";
import {
  HOST_TOOL_SURFACE_AUDIT,
  isDirectWriteTool,
  isShellTool,
  isSpawnTool,
} from "../hooks/tools.js";
import { DEFAULT_HOST_HOOKS_POLICY } from "../policy/host-hooks.js";
import {
  AGENT_HOOK_PATH_BY_HOST,
  depositedPreToolUseMatchers,
  writeAgentHookDeposit,
} from "./agent-hooks.js";
import { inspectHostToolCoverage } from "./host-tool-coverage.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function depositedProject(): string {
  const root = mkdtempSync(join(tmpdir(), "host-tool-coverage-"));
  temps.push(root);
  writeAgentHookDeposit(root, { printf: () => undefined });
  return root;
}

describe("host tool-surface coverage (#3987)", () => {
  it("passes on a current deposit", () => {
    expect(inspectHostToolCoverage(depositedProject(), DEFAULT_HOST_HOOKS_POLICY)).toEqual([]);
  });

  it("audits every supported host, coverage or a written reason", () => {
    for (const host of HOOK_HOSTS) {
      const audit = HOST_TOOL_SURFACE_AUDIT[host];
      expect(audit, `${host} has no tool-surface audit entry`).toBeDefined();
      expect(audit.source.trim().length).toBeGreaterThan(0);
      const named =
        audit.mutation.directWrite.length +
        audit.mutation.shell.length +
        audit.mutation.spawn.length;
      expect(named > 0 || (audit.unobservedReason ?? "").trim().length > 0).toBe(true);
      for (const reason of Object.values(audit.nonMutation)) {
        expect(reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("covers Grok's mutation surface in both layers", () => {
    const root = depositedProject();
    const matchers = depositedPreToolUseMatchers(root, "grok") ?? [];
    const audit = HOST_TOOL_SURFACE_AUDIT.grok;
    expect(audit.unobservedReason).toBeNull();
    for (const [group, classify] of [
      ["directWrite", isDirectWriteTool],
      ["shell", isShellTool],
      ["spawn", isSpawnTool],
    ] as const) {
      for (const name of audit.mutation[group]) {
        expect(
          matchers.some((m) => m.split("|").includes(name)),
          `${name} deposited`,
        ).toBe(true);
        expect(classify(name), `${name} classified as ${group}`).toBe(true);
      }
    }
    // The two shell surfaces this host actually exposes.
    expect(audit.mutation.shell).toContain("run_terminal_command");
    expect(audit.mutation.shell).toContain("monitor");
  });

  it("fails closed when a deposited matcher drops a catalogued tool name", () => {
    const root = depositedProject();
    const path = join(root, AGENT_HOOK_PATH_BY_HOST.grok);
    const raw = readFileSync(path, "utf8").replace("|run_terminal_command", "");
    writeFileSync(path, raw, "utf8");
    const findings = inspectHostToolCoverage(root, DEFAULT_HOST_HOOKS_POLICY);
    expect(findings).toContainEqual(
      expect.objectContaining({
        host: "grok",
        kind: "uncovered-tool",
        toolName: "run_terminal_command",
      }),
    );
  });

  it("fails closed when a renamed tool leaves the deposit behind", () => {
    const root = depositedProject();
    const path = join(root, AGENT_HOOK_PATH_BY_HOST.grok);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("spawn_subagent", "spawn_subagent_v2"),
      "utf8",
    );
    expect(inspectHostToolCoverage(root, DEFAULT_HOST_HOOKS_POLICY)).toContainEqual(
      expect.objectContaining({ kind: "uncovered-tool", toolName: "spawn_subagent" }),
    );
  });

  it("skips a host whose deposit is absent — that is a registration failure, not a coverage one", () => {
    const root = mkdtempSync(join(tmpdir(), "host-tool-coverage-bare-"));
    temps.push(root);
    expect(inspectHostToolCoverage(root, DEFAULT_HOST_HOOKS_POLICY)).toEqual([]);
    expect(depositedPreToolUseMatchers(root, "grok")).toBeNull();
  });

  it("skips a host the operator opted out of", () => {
    const root = depositedProject();
    const path = join(root, AGENT_HOOK_PATH_BY_HOST.grok);
    writeFileSync(path, readFileSync(path, "utf8").replace("|run_terminal_command", ""), "utf8");
    const optedOut = { ...DEFAULT_HOST_HOOKS_POLICY, grok: false };
    expect(inspectHostToolCoverage(root, optedOut)).toEqual([]);
  });
});
