import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAgentHookDeposit } from "../init-deposit/agent-hooks.js";
import { DEFAULT_HOST_HOOKS_POLICY } from "../policy/host-hooks.js";
import {
  AGENT_HOOK_WORKTREE_REPAIR_RECOVERY,
  evaluateAgentHooks,
  formatAgentHookRepairDisposition,
} from "./agent-hooks.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-agent-hook-health-"));
  temps.push(root);
  return root;
}

describe("evaluateAgentHooks", () => {
  it("passes when all P0 registrations are structurally healthy", () => {
    const root = project();
    writeAgentHookDeposit(root);

    const result = evaluateAgentHooks(root);
    expect(result.code).toBe(0);
    expect(result.message).toContain("Claude, Grok, Cursor, Codex");
    expect(result.message).toContain("spawn/Task tools");
    expect(result.message).toContain("DEFT_HOOK_READ_ONLY");
    expect(result.message).toContain("manual-review-required");
    expect(result.message).not.toMatch(/reviewed with `\/hooks`/);
    expect(result.message).not.toMatch(/open\s+`\/hooks`/i);
  });

  it("reports missing registrations separately from git hooks", () => {
    const result = evaluateAgentHooks(project());
    expect(result.code).toBe(1);
    expect(result.message).toContain("agent hook registration INCOMPLETE");
    expect(result.message).toContain(".grok/hooks/deft.json");
    expect(result.message).toContain(".codex/hooks.json");
    expect(result.stream).toBe("stderr");
  });

  it("fails when an enabled Codex registration file is removed", () => {
    const root = project();
    writeAgentHookDeposit(root);
    rmSync(join(root, ".codex", "hooks.json"));

    const result = evaluateAgentHooks(root);
    expect(result.code).toBe(1);
    expect(result.registrations.find((entry) => entry.host === "codex")).toMatchObject({
      status: "missing",
    });
  });

  it.each([
    "SessionStart",
    "PreToolUse",
  ])("fails when the enabled Codex %s matcher drifts", (eventName) => {
    const root = project();
    writeAgentHookDeposit(root);
    const hookPath = join(root, ".codex", "hooks.json");
    const parsed = JSON.parse(readFileSync(hookPath, "utf8")) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    const registrations = parsed.hooks[eventName];
    if (!registrations?.[0]) throw new Error(`missing test registration for ${eventName}`);
    registrations[0].matcher = "drifted-matcher";
    writeFileSync(hookPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const result = evaluateAgentHooks(root);
    expect(result.code).toBe(1);
    expect(result.registrations.find((entry) => entry.host === "codex")).toMatchObject({
      status: "drifted",
    });
  });

  it("returns a configuration error for a missing project root", () => {
    const root = project();
    const result = evaluateAgentHooks(join(root, "missing"));
    expect(result.code).toBe(2);
    expect(result.message).toContain("does not exist");
  });

  it("passes when Claude is opted out via plan.policy.hostHooks", () => {
    const root = project();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({ plan: { policy: { hostHooks: { claude: false } } } }, null, 2)}\n`,
      "utf8",
    );
    writeAgentHookDeposit(
      root,
      { printf: () => undefined },
      {
        ...DEFAULT_HOST_HOOKS_POLICY,
        claude: false,
      },
    );

    const result = evaluateAgentHooks(root);
    expect(result.code).toBe(0);
    expect(result.registrations.find((entry) => entry.host === "claude")).toMatchObject({
      status: "disabled",
    });
    expect(result.message).toContain("disabled: Claude");
  });

  it("offers hostHooks opt-out recovery for an enabled missing host", () => {
    const result = evaluateAgentHooks(project());

    expect(result.code).toBe(1);
    expect(result.message).toContain("deft policy:show --field=hostHooks");
    expect(result.message).toContain("deft policy:disable-host-hooks");
    expect(result.message).toContain("--confirm");
    expect(result.message).toContain("deft-hook pre-execution guardrails");
    expect(result.message).not.toContain("hostHooks.<host> = false");
    expect(result.message).not.toContain("disable-host-hooks -- --host");
  });

  it("fails closed on a tool-surface gap the registration check cannot see (#3987)", () => {
    const root = project();
    writeAgentHookDeposit(root);
    expect(evaluateAgentHooks(root).coverage).toEqual([]);

    const result = evaluateAgentHooks(root, DEFAULT_HOST_HOOKS_POLICY, () => [
      {
        host: "grok",
        path: ".grok/hooks/deft.json",
        kind: "uncovered-tool",
        toolName: "run_terminal_command",
        detail: "shell tool is absent from every deposited PreToolUse matcher.",
      },
    ]);
    expect(result.code).toBe(1);
    expect(result.message).toContain("tool-surface coverage INCOMPLETE");
    expect(result.message).toContain("run_terminal_command");
    expect(result.stream).toBe("stderr");
    expect(result.coverage).toHaveLength(1);
  });

  it("keeps the stale-deposit remedy ahead of the coverage one", () => {
    const root = project();
    writeAgentHookDeposit(root);
    const hookPath = join(root, ".grok", "hooks", "deft.json");
    writeFileSync(
      hookPath,
      readFileSync(hookPath, "utf8").replace("|run_terminal_command", ""),
      "utf8",
    );

    const result = evaluateAgentHooks(root);
    expect(result.code).toBe(1);
    // A hand-edited deposit is stale first; `deft update` restores both.
    expect(result.message).toContain("registration INCOMPLETE");
    expect(result.coverage).toContainEqual(
      expect.objectContaining({ host: "grok", kind: "uncovered-tool" }),
    );
  });
});

describe("evaluateAgentHooks worktree repair recovery (#4711)", () => {
  it("prints the thin --repair command and liveness from registration INCOMPLETE", () => {
    const result = evaluateAgentHooks(project());
    expect(result.code).toBe(1);
    expect(result.message).toContain(AGENT_HOOK_WORKTREE_REPAIR_RECOVERY);
    expect(result.message).toContain("verify:hooks-installed --scope=agent --repair");
    expect(result.message).toContain("this worktree");
    expect(result.message).toContain("do not copy from another checkout");
    expect(result.message).toContain("relaunch or reload host matchers");
    expect(result.message).toContain("retry");
    expect(result.message).toContain("session:ready");
    expect(result.message).toContain("agents:refresh");
    expect(result.message).toContain("do not write these files");
  });

  it("formatAgentHookRepairDisposition reports exact changedPaths and dirty tracked JSON", () => {
    const message = formatAgentHookRepairDisposition({
      changed: true,
      changedPaths: [".claude/settings.json", ".cursor/hooks.json"],
    });
    expect(message).toContain("changedPaths: .claude/settings.json, .cursor/hooks.json");
    expect(message).toContain("may now be dirty");
    expect(message).toContain("Do not copy from another checkout");
    expect(message).toContain("committing refreshed deposits");
    expect(message).toContain("stays denied");
    expect(message).toContain("Relaunch or reload host matchers");
    expect(message).toContain("file+shim, not host interception");
  });

  it("formatAgentHookRepairDisposition prints (none) when nothing changed", () => {
    expect(formatAgentHookRepairDisposition({ changed: false, changedPaths: [] })).toContain(
      "changedPaths: (none)",
    );
  });
});
