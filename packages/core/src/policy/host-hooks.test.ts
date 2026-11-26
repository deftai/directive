import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE } from "../install-health/constants.js";
import {
  hostHookOuterGlobRel,
  hostHookRegistrationRelPath,
  hostHookRepairDisclosurePaths,
  hostHookRepairOptOutDisclosureBullet,
} from "../init-deposit/host-hook-outer.js";
import {
  DEFAULT_HOST_HOOKS_POLICY,
  disableHostHooks,
  disableHostHooksInvocation,
  FIELD_HOST_HOOKS_CLI_ALIAS,
  HOST_HOOKS_DISABLE_CAPABILITY_COST_DISCLOSURE,
  HOST_HOOKS_DISABLE_DISCLOSURE_REFUSAL_CAN_CLEAR,
  inspectHostHooks,
  isHostHookDepositEnabled,
  loadHostHooksPolicyFromProject,
  parseHookHost,
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
    expect(result.stdout).toContain(HOST_HOOKS_DISABLE_DISCLOSURE_REFUSAL_CAN_CLEAR);
    expect(HOST_HOOKS_DISABLE_CAPABILITY_COST_DISCLOSURE).toContain(
      "A hook refusal in the current session can clear when the gate is removed.",
    );
    expect(HOST_HOOKS_DISABLE_CAPABILITY_COST_DISCLOSURE).not.toContain("is clearing");
    expect(HOST_HOOKS_DISABLE_CAPABILITY_COST_DISCLOSURE).not.toContain("was removed");
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
    expect(result.stdout).toContain(hostHookRegistrationRelPath("cursor"));
    expect(result.stdout).toContain("launch checkout");
    expect(result.stdout).not.toContain(
      "Run `directive install --repair` to strip Directive-managed hook entries",
    );
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

  it("strips Claude settings and deft-hook module before exit 0 (#7349)", () => {
    const root = project();
    writeProjectDefinition(root, {});
    mkdirSync(join(root, ".claude"), { recursive: true });
    const outerRel = ".claude/deft-hook-deadbeef.mjs";
    writeFileSync(join(root, outerRel), "export {}\n", "utf8");
    writeFileSync(
      join(root, ".claude/settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: `node ${outerRel} --host claude --event tool.before`,
                  },
                ],
              },
            ],
          },
          permissions: { allow: ["Read"] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor/hooks.json"),
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            preToolUse: [
              {
                command: "node .cursor/hooks/deft-hook-abcd1234.mjs --host cursor --event tool.before",
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = disableHostHooks(root, { host: "claude", confirm: true, actor: "test" });
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.stdout).toContain("Cleared live Directive host-hook registration");
    expect(result.stdout).toContain(".claude/settings.json");
    expect(result.stdout).toContain(outerRel);
    expect(result.stdout).toContain(hostHookOuterGlobRel("claude"));
    expect(result.touchedPaths).toEqual(
      expect.arrayContaining([".claude/settings.json", outerRel, hostHookOuterGlobRel("claude")]),
    );

    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as {
      hooks?: unknown;
      permissions?: { allow?: string[] };
    };
    expect(settings.hooks).toBeUndefined();
    expect(settings.permissions?.allow).toEqual(["Read"]);
    expect(existsSync(join(root, outerRel))).toBe(false);
    expect(loadHostHooksPolicyFromProject(root).claude).toBe(false);
    expect(loadHostHooksPolicyFromProject(root).cursor).toBe(true);
    expect(readFileSync(join(root, ".cursor/hooks.json"), "utf8")).toContain("--host cursor");
  });

  it("names launch-checkout repair in root-mismatch recovery (#7349 P2)", () => {
    expect(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE).toContain("launch checkout");
    expect(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE).toContain("directive install --repair");
    expect(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE).toContain("a new session alone is not enough");
    expect(HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE).not.toContain(
      "the disable takes effect in a new session",
    );
  });

  it("exposes repair disclosure paths for Claude settings and outers (#7349 P3)", () => {
    expect(hostHookRepairDisclosurePaths("claude")).toEqual([
      ".claude/settings.json",
      ".claude/deft-hook-*.mjs",
    ]);
    expect(hostHookRepairOptOutDisclosureBullet("claude")).toContain(".claude/settings.json");
    expect(hostHookRepairOptOutDisclosureBullet("claude")).toContain(".claude/deft-hook-*.mjs");
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

  it("disable-host-hooks invocation names the confirm verb without go-task --", () => {
    expect(disableHostHooksInvocation()).toBe(
      "deft policy:disable-host-hooks --host <host> --confirm",
    );
    expect(disableHostHooksInvocation()).not.toContain(" -- --");
    expect(disableHostHooksInvocation()).not.toContain("disable-host-hooks -- --host");
  });
});
