import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateOpenClawSkillArtifacts, isManagedOpenClawL2Skill } from "./openclaw-adapter.js";
import {
  depositOpenClawL2ProductCommands,
  resolveOpenClawProductCommandsPolicy,
  validateOpenClawProductCommands,
} from "./openclaw-deposit.js";
import { OPENCLAW_ROUTER_SLUG } from "./openclaw-slugs.js";
import { PRODUCT_COMMAND_COUNT } from "./product-set.js";

const tempRoots: string[] = [];

function makeTemp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("OpenClaw L2 deposit (#3064 D4/D5)", () => {
  it("skips when OpenClaw is not detected (fail-closed)", () => {
    const home = makeTemp("oc-l2-none-");
    const result = depositOpenClawL2ProductCommands({
      env: {},
      homeDir: home,
    });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("openclaw-not-detected");
    expect(result.writtenPaths).toHaveLength(0);
  });

  it("deposits router + 13 skills into main workspace skills (copy, not symlink)", () => {
    const home = makeTemp("oc-l2-dep-");
    const state = join(home, ".openclaw");
    mkdirSync(join(state, "workspace", "skills"), { recursive: true });
    const result = depositOpenClawL2ProductCommands({
      env: { OPENCLAW_STATE_DIR: state },
      homeDir: home,
    });
    expect(result.skipped).toBe(false);
    expect(result.writtenPaths.length).toBe(PRODUCT_COMMAND_COUNT + 1);

    const skillsDir = join(state, "workspace", "skills");
    const router = readFileSync(join(skillsDir, OPENCLAW_ROUTER_SLUG, "SKILL.md"), "utf8");
    expect(isManagedOpenClawL2Skill(router)).toBe(true);
    expect(router).toContain("user-invocable: true");

    const interview = readFileSync(join(skillsDir, "deft_run_interview", "SKILL.md"), "utf8");
    expect(interview).toContain("strategies/interview.md");
    expect(interview).toContain("/deft:directive:run:interview");
  });

  it("is idempotent on second deposit", () => {
    const home = makeTemp("oc-l2-idemp-");
    const state = join(home, ".openclaw");
    mkdirSync(join(state, "workspace", "skills"), { recursive: true });
    const opts = { env: { OPENCLAW_STATE_DIR: state }, homeDir: home };
    const first = depositOpenClawL2ProductCommands(opts);
    expect(first.changed).toBe(true);
    const second = depositOpenClawL2ProductCommands(opts);
    expect(second.changed).toBe(false);
    expect(second.writtenPaths).toHaveLength(0);
  });

  it("rewrites stale managed skills and preserves consumer custom skills", () => {
    const home = makeTemp("oc-l2-own-");
    const state = join(home, ".openclaw");
    const skillsDir = join(state, "workspace", "skills");
    mkdirSync(skillsDir, { recursive: true });

    // Pre-seed stale managed router + consumer custom at a product slug.
    mkdirSync(join(skillsDir, OPENCLAW_ROUTER_SLUG), { recursive: true });
    writeFileSync(
      join(skillsDir, OPENCLAW_ROUTER_SLUG, "SKILL.md"),
      `---\nname: deft\nuser-invocable: true\n---\n\n<!-- deft-managed: openclaw-l2-product-command -->\n<!-- deft-openclaw-role: router -->\n# stale\n`,
      "utf8",
    );
    mkdirSync(join(skillsDir, "deft_continue"), { recursive: true });
    writeFileSync(
      join(skillsDir, "deft_continue", "SKILL.md"),
      "---\nname: deft_continue\n---\n\n# my custom continue\n",
      "utf8",
    );

    const result = depositOpenClawL2ProductCommands({
      env: { OPENCLAW_STATE_DIR: state },
      homeDir: home,
    });
    expect(result.preservedCustomPaths.some((p) => p.includes("deft_continue"))).toBe(true);
    const custom = readFileSync(join(skillsDir, "deft_continue", "SKILL.md"), "utf8");
    expect(custom).toContain("my custom continue");

    const router = readFileSync(join(skillsDir, OPENCLAW_ROUTER_SLUG, "SKILL.md"), "utf8");
    expect(router).toBe(
      generateOpenClawSkillArtifacts().find((a) => a.role === "router")?.skillMarkdown,
    );
  });

  it("removes managed skills on policy opt-out", () => {
    const home = makeTemp("oc-l2-opt-");
    const state = join(home, ".openclaw");
    mkdirSync(join(state, "workspace", "skills"), { recursive: true });
    depositOpenClawL2ProductCommands({
      env: { OPENCLAW_STATE_DIR: state },
      homeDir: home,
      policy: true,
    });
    const removed = depositOpenClawL2ProductCommands({
      env: { OPENCLAW_STATE_DIR: state },
      homeDir: home,
      policy: false,
    });
    expect(removed.removedPaths.length).toBe(PRODUCT_COMMAND_COUNT + 1);
  });

  it("validates policy type", () => {
    expect(validateOpenClawProductCommands(true)).toEqual([]);
    expect(validateOpenClawProductCommands(false)).toEqual([]);
    expect(validateOpenClawProductCommands("yes").length).toBeGreaterThan(0);
    expect(resolveOpenClawProductCommandsPolicy(undefined)).toBe(true);
    expect(resolveOpenClawProductCommandsPolicy(false)).toBe(false);
  });
});
