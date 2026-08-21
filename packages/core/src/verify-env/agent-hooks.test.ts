import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAgentHookDeposit } from "../init-deposit/agent-hooks.js";
import { DEFAULT_HOST_HOOKS_POLICY } from "../policy/host-hooks.js";
import { evaluateAgentHooks } from "./agent-hooks.js";

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
  });
});
