import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectOnePolicy } from "../policy/index.js";
import {
  DEFAULT_HOST_SKILL_DISCOVERY_POLICY,
  FIELD_HOST_SKILL_DISCOVERY_CLI_ALIAS,
  getHostSkillDiscoveryLayout,
  HOST_SKILL_DISCOVERY_LAYOUTS,
  hostSkillRelativePath,
  inspectHostSkillDiscovery,
  isHostSkillDiscoveryEnabled,
  listSkillDiscoveryHosts,
  loadHostSkillDiscoveryPolicyFromProject,
  resolveHostSkillDiscoveryPolicy,
  SKILL_DISCOVERY_HOSTS,
  validateHostSkillDiscovery,
} from "./skill-discovery-hosts.js";

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-skill-discovery-hosts-"));
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

describe("skill discovery hosts (#75 residual)", () => {
  it("documents the residual path matrix for all four hosts", () => {
    expect(listSkillDiscoveryHosts()).toEqual(["claude", "cursor", "codex", "github"]);
    expect(HOST_SKILL_DISCOVERY_LAYOUTS.claude.relativeDir).toBe(".claude/skills");
    expect(HOST_SKILL_DISCOVERY_LAYOUTS.cursor.relativeDir).toBe(".cursor/skills");
    expect(HOST_SKILL_DISCOVERY_LAYOUTS.codex.relativeDir).toBe(".codex/skills");
    expect(HOST_SKILL_DISCOVERY_LAYOUTS.github.relativeDir).toBe(".github/skills");
    for (const host of SKILL_DISCOVERY_HOSTS) {
      const layout = getHostSkillDiscoveryLayout(host);
      expect(layout.skillFilename).toBe("SKILL.md");
      // Skill paths must not collide with #55 slash/command dirs.
      expect(layout.relativeDir).not.toMatch(/commands|prompts$/);
    }
  });

  it("builds stable host skill relative paths", () => {
    expect(hostSkillRelativePath("claude", "deft-directive-build")).toBe(
      ".claude/skills/deft-directive-build/SKILL.md",
    );
    expect(hostSkillRelativePath("github", "deft")).toBe(".github/skills/deft/SKILL.md");
  });

  it("defaults all skill-discovery hosts to enabled", () => {
    expect(resolveHostSkillDiscoveryPolicy(undefined)).toEqual(DEFAULT_HOST_SKILL_DISCOVERY_POLICY);
    expect(isHostSkillDiscoveryEnabled("claude")).toBe(true);
    expect(isHostSkillDiscoveryEnabled("github")).toBe(true);
  });

  it("honors per-host opt-out without affecting unspecified hosts", () => {
    const resolved = resolveHostSkillDiscoveryPolicy({ claude: false, github: false });
    expect(resolved.claude).toBe(false);
    expect(resolved.github).toBe(false);
    expect(resolved.cursor).toBe(true);
    expect(resolved.codex).toBe(true);
  });

  it("validates boolean host keys and rejects unknown hosts", () => {
    expect(validateHostSkillDiscovery({ claude: false })).toEqual([]);
    expect(validateHostSkillDiscovery({ claude: "no" })).toContain(
      "plan.policy.hostSkillDiscovery.claude must be a boolean",
    );
    expect(validateHostSkillDiscovery({ grok: false })).toContain(
      "plan.policy.hostSkillDiscovery.grok is not a skill-discovery host (claude, cursor, codex, github)",
    );
  });

  it("loads typed policy from PROJECT-DEFINITION", () => {
    const root = project();
    writeProjectDefinition(root, { hostSkillDiscovery: { codex: false } });
    expect(loadHostSkillDiscoveryPolicyFromProject(root).codex).toBe(false);
    expect(loadHostSkillDiscoveryPolicyFromProject(root).claude).toBe(true);
  });

  it("registers policy:show --field=hostSkillDiscovery", () => {
    const root = project();
    writeProjectDefinition(root, { hostSkillDiscovery: { cursor: false } });
    const field = inspectOnePolicy(FIELD_HOST_SKILL_DISCOVERY_CLI_ALIAS, root);
    expect(field?.current).toMatchObject({ cursor: false, claude: true });
    expect(field?.source).toBe("typed");
  });

  it("inspectHostSkillDiscovery returns default when key is absent", () => {
    expect(inspectHostSkillDiscovery({ plan: { policy: {} } }).source).toBe("default");
  });
});
