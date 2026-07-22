import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_HOOKS_POLICY,
  FIELD_HOST_HOOKS_CLI_ALIAS,
  inspectHostHooks,
  isHostHookDepositEnabled,
  loadHostHooksPolicyFromProject,
  resolveHostHooksPolicy,
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
});
