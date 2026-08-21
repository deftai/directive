import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_HOOKS_POLICY,
  disableHostHooks,
  disableHostHooksInvocation,
  FIELD_HOST_HOOKS_CLI_ALIAS,
  HOST_HOOKS_DISABLE_CAPABILITY_COST_DISCLOSURE,
  inspectHostHooks,
  isHostHookDepositEnabled,
  loadHostHooksPolicyFromProject,
  parseHookHost,
  resolveHostHooksPolicy,
  UNUSED_HOST_HOOKS_RECOVERY,
  validateHostHooks,
} from "./host-hooks.js";
import { inspectOnePolicy } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-host-hooks-policy-"));
  temps.push(root);
  return root;
}

function writeProjectDefinition(root: string, policy: Record<string, unknown>): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief/PROJECT-DEFINITION.xbrief.json"),
    `${JSON.stringify({ plan: { policy } }, null, 2)}\n`,
    "utf8",
  );
}

describe("hostHooks policy (#2752)", () => {
  it("defaults all four deposited hosts to true", () => {
    expect(resolveHostHooksPolicy(undefined)).toEqual(DEFAULT_HOST_HOOKS_POLICY);
    expect(isHostHookDepositEnabled("claude")).toBe(true);
  });

  it("honors per-host false without affecting unspecified hosts", () => {
    const resolved = resolveHostHooksPolicy({ claude: false, cursor: false });
    expect(resolved.claude).toBe(false);
    expect(resolved.cursor).toBe(false);
    expect(resolved.grok).toBe(true);
    expect(resolved.codex).toBe(true);
  });

  it("validates boolean host keys and rejects unknown hosts", () => {
    expect(validateHostHooks({ claude: false })).toEqual([]);
    expect(validateHostHooks({ claude: "no" })).toContain(
      "plan.policy.hostHooks.claude must be a boolean",
    );
    expect(validateHostHooks({ opencode: false })).toContain(
      "plan.policy.hostHooks.opencode is not a deposited host (claude, grok, cursor, codex)",
    );
  });

  it("loads typed policy from PROJECT-DEFINITION", () => {
    const root = project();
    writeProjectDefinition(root, { hostHooks: { claude: false } });
    expect(loadHostHooksPolicyFromProject(root).claude).toBe(false);
    expect(loadHostHooksPolicyFromProject(root).grok).toBe(true);
  });

  it("registers policy:show --field=hostHooks", () => {
    const root = project();
    writeProjectDefinition(root, { hostHooks: { codex: false } });
    const field = inspectOnePolicy(FIELD_HOST_HOOKS_CLI_ALIAS, root);
    expect(field?.current).toMatchObject({ codex: false, claude: true });
    expect(field?.source).toBe("typed");
  });

  it("inspectHostHooks returns default when key is absent", () => {
    expect(inspectHostHooks({ plan: { policy: {} } }).source).toBe("default");
  });

  it("parses deposited hosts and rejects unknown names", () => {
    expect(parseHookHost("cursor")).toBe("cursor");
    expect(parseHookHost("opencode")).toBeNull();
    expect(parseHookHost(undefined)).toBeNull();
  });

  it("refuses disableHostHooks without --confirm and prints capability-cost disclosure", () => {
    const root = project();
    writeProjectDefinition(root, {});
    const result = disableHostHooks(root, { host: "cursor", confirm: false });
    expect(result.exitCode).toBe(1);
    expect(result.changed).toBe(false);
    expect(result.stdout).toContain(HOST_HOOKS_DISABLE_CAPABILITY_COST_DISCLOSURE);
    expect(result.stdout).toContain("--confirm");
    expect(result.stdout).toContain("deft-hook pre-execution guardrails");
    expect(result.stdout).toContain("tracked");
    expect(loadHostHooksPolicyFromProject(root).cursor).toBe(true);
  });

  it("persists hostHooks.host=false after --confirm", () => {
    const root = project();
    writeProjectDefinition(root, {});
    const result = disableHostHooks(root, { host: "cursor", confirm: true, actor: "test" });
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.stdout).toContain("guardrails removed");
    expect(loadHostHooksPolicyFromProject(root)).toMatchObject({
      cursor: false,
      claude: true,
    });
  });

  it("is a no-op when the host is already disabled", () => {
    const root = project();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify(
        { plan: { "x-directive/policy": { hostHooks: { cursor: false } } } },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = disableHostHooks(root, { host: "cursor", confirm: true, actor: "test" });
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(false);
    expect(result.stdout).toContain("ledger unchanged");
  });

  it("returns config error when PROJECT-DEFINITION is missing", () => {
    const root = project();
    const result = disableHostHooks(root, { host: "cursor", confirm: true });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("not found");
  });

  it("returns config error when plan is not an object", () => {
    const root = project();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief/PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({ plan: [] })}\n`,
      "utf8",
    );
    const result = disableHostHooks(root, { host: "cursor", confirm: true });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Config error");
  });

  it("unused-host recovery names the confirm verb and guardrail cost", () => {
    expect(UNUSED_HOST_HOOKS_RECOVERY).toContain("deft policy:disable-host-hooks");
    expect(UNUSED_HOST_HOOKS_RECOVERY).toContain("--confirm");
    expect(UNUSED_HOST_HOOKS_RECOVERY).toContain("deft-hook pre-execution guardrails");
    expect(UNUSED_HOST_HOOKS_RECOVERY).not.toContain("hostHooks.<host> = false");
    expect(disableHostHooksInvocation()).toBe(
      "deft policy:disable-host-hooks --host <host> --confirm",
    );
    expect(disableHostHooksInvocation()).not.toContain(" -- --");
    expect(UNUSED_HOST_HOOKS_RECOVERY).not.toContain("disable-host-hooks -- --host");
  });
});
