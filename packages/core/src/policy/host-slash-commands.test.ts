import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSlashEmitterHosts } from "../slash/emitters.js";
import {
  DEFAULT_HOST_SLASH_COMMANDS_POLICY,
  FIELD_HOST_SLASH_COMMANDS_CLI_ALIAS,
  inspectHostSlashCommands,
  isHostSlashCommandDepositEnabled,
  loadHostSlashCommandsPolicyFromProject,
  resolveHostSlashCommandsPolicy,
  validateHostSlashCommands,
} from "./host-slash-commands.js";
import { inspectOnePolicy } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-host-slash-policy-"));
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

describe("hostSlashCommands policy (#3054)", () => {
  it("defaults all four emitter hosts to true (not single-host-only)", () => {
    expect(resolveHostSlashCommandsPolicy(undefined)).toEqual(DEFAULT_HOST_SLASH_COMMANDS_POLICY);
    expect(listSlashEmitterHosts().every((h) => isHostSlashCommandDepositEnabled(h))).toBe(true);
    expect(isHostSlashCommandDepositEnabled("claude")).toBe(true);
  });

  it("honors per-host false without affecting unspecified hosts", () => {
    const resolved = resolveHostSlashCommandsPolicy({ claude: false, cursor: false });
    expect(resolved.claude).toBe(false);
    expect(resolved.cursor).toBe(false);
    expect(resolved.grok).toBe(true);
    expect(resolved.codex).toBe(true);
    expect(isHostSlashCommandDepositEnabled("claude", resolved)).toBe(false);
    expect(isHostSlashCommandDepositEnabled("grok", resolved)).toBe(true);
  });

  it("validates boolean host keys and rejects unknown hosts", () => {
    expect(validateHostSlashCommands({ claude: false })).toEqual([]);
    expect(validateHostSlashCommands({ claude: "no" })).toContain(
      "plan.policy.hostSlashCommands.claude must be a boolean",
    );
    expect(validateHostSlashCommands({ opencode: false })).toContain(
      "plan.policy.hostSlashCommands.opencode is not a slash emitter host (claude, cursor, grok, codex)",
    );
  });

  it("loads typed policy from PROJECT-DEFINITION", () => {
    const root = project();
    writeProjectDefinition(root, { hostSlashCommands: { claude: false } });
    expect(loadHostSlashCommandsPolicyFromProject(root).claude).toBe(false);
    expect(loadHostSlashCommandsPolicyFromProject(root).grok).toBe(true);
  });

  it("registers policy:show --field=hostSlashCommands", () => {
    const root = project();
    writeProjectDefinition(root, { hostSlashCommands: { codex: false } });
    const field = inspectOnePolicy(FIELD_HOST_SLASH_COMMANDS_CLI_ALIAS, root);
    expect(field?.current).toMatchObject({ codex: false, claude: true });
    expect(field?.source).toBe("typed");
  });

  it("inspectHostSlashCommands returns default when key is absent", () => {
    expect(inspectHostSlashCommands({ plan: { policy: {} } }).source).toBe("default");
  });
});
