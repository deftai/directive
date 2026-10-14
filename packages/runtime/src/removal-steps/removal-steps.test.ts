/**
 * Wave 3e — owner-boundary contracts for removal steps + strategy table.
 * pruneEmptyAncestors / removeSoleAuthorHusks (F-012 / F-013).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONSUMER_HEADER_PLACEHOLDER_ONELINER,
  renderConsumerHeader,
} from "@deftai/directive-core/dist/platform/agents-consumer-header.js";
import { pruneEmptyAncestors, removeSoleAuthorHusks } from "./steps.js";
import { STRATEGIES, strategyForShape } from "./strategies.js";

const TEMPS: string[] = [];

afterEach(() => {
  while (TEMPS.length > 0) {
    const root = TEMPS.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(name = "wave3e-removal"): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  TEMPS.push(root);
  return root;
}

describe("pruneEmptyAncestors (C4 / F-012)", () => {
  it("removes empty dirs after file delete and stops at non-empty / foreign", () => {
    const root = tempRoot();
    const skillDir = join(root, ".agents", "skills", "directive-coding");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "# owned\n");
    // Sibling foreign content under .agents must survive prune walk-up.
    mkdirSync(join(root, ".agents", "skills", "user-skill"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "user-skill", "SKILL.md"), "# user\n");

    rmSync(skillFile);

    const removed = pruneEmptyAncestors(root, ".agents/skills/directive-coding/SKILL.md");
    expect(removed).toEqual(
      expect.arrayContaining([".agents/skills/directive-coding"]),
    );
    expect(existsSync(join(root, ".agents", "skills", "directive-coding"))).toBe(false);
    // Must not delete .agents/skills (holds foreign skill) or .agents.
    expect(existsSync(join(root, ".agents", "skills", "user-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills"))).toBe(true);
  });

  it("prunes empty command and githooks trees up to host roots", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".claude", "commands"), { recursive: true });
    writeFileSync(join(root, ".claude", "commands", "deft-continue.md"), "# cmd\n");
    mkdirSync(join(root, ".githooks"), { recursive: true });
    writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\n");

    rmSync(join(root, ".claude", "commands", "deft-continue.md"));
    rmSync(join(root, ".githooks", "pre-commit"));

    const cmds = pruneEmptyAncestors(root, ".claude/commands/deft-continue.md");
    expect(cmds).toEqual(
      expect.arrayContaining([".claude/commands", ".claude"]),
    );
    expect(existsSync(join(root, ".claude"))).toBe(false);

    const hooks = pruneEmptyAncestors(root, ".githooks/pre-commit");
    expect(hooks).toContain(".githooks");
    expect(existsSync(join(root, ".githooks"))).toBe(false);
  });

  it("does not prune outside known host / .deft / .githooks trees", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src", "empty-nest"), { recursive: true });
    writeFileSync(join(root, "src", "empty-nest", "x.ts"), "export {};\n");
    rmSync(join(root, "src", "empty-nest", "x.ts"));

    const removed = pruneEmptyAncestors(root, "src/empty-nest/x.ts");
    expect(removed).toEqual([]);
    expect(existsSync(join(root, "src", "empty-nest"))).toBe(true);
  });
});

describe("removeSoleAuthorHusks (C5 / F-013)", () => {
  it("removes {private:true}-only package.json and {} hooks we created", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor", "hooks.json"), "{}\n");
    // User content must stay.
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "user\n");
    writeFileSync(
      join(root, "real-pkg.json"),
      `${JSON.stringify({ name: "app", private: true, dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
    );

    const removed = removeSoleAuthorHusks(root);
    expect(removed).toEqual(
      expect.arrayContaining(["package.json", ".cursor/hooks.json"]),
    );
    expect(existsSync(join(root, "package.json"))).toBe(false);
    expect(existsSync(join(root, ".cursor", "hooks.json"))).toBe(false);
    expect(existsSync(join(root, "xbrief", "keep.txt"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "real-pkg.json"), "utf8")).name).toBe("app");
  });

  it("removes install-seeded AGENTS stub but preserves user body", () => {
    const root = tempRoot();
    writeFileSync(join(root, "AGENTS.md"), `${renderConsumerHeader()}\n`);
    const removed = removeSoleAuthorHusks(root);
    expect(removed).toContain("AGENTS.md");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);

    const root2 = tempRoot("wave3e-agents-user");
    writeFileSync(
      join(root2, "AGENTS.md"),
      `# Project\n\nUser prose stays.\n\n## Session orientation\n\nCustom notes.\n`,
    );
    expect(removeSoleAuthorHusks(root2)).not.toContain("AGENTS.md");
    expect(readFileSync(join(root2, "AGENTS.md"), "utf8")).toContain("User prose stays.");
  });

  it("removes Directive-only pin package.json + near-empty lockfile", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        { private: true, devDependencies: { "@deftai/directive-runtime": "0.0.0-yolo" } },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "t",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              devDependencies: { "@deftai/directive-runtime": "0.0.0-yolo" },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const removed = removeSoleAuthorHusks(root);
    expect(removed).toEqual(expect.arrayContaining(["package.json", "package-lock.json"]));
    expect(existsSync(join(root, "package.json"))).toBe(false);
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
  });

  it("preserves host hooks JSON that still have foreign entries", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "hooks.json"),
      `${JSON.stringify(
        { version: 1, hooks: { sessionStart: [{ command: "echo user" }] } },
        null,
        2,
      )}\n`,
    );
    expect(removeSoleAuthorHusks(root)).not.toContain(".cursor/hooks.json");
    expect(existsSync(join(root, ".cursor", "hooks.json"))).toBe(true);
  });

  it("removes sole-author Taskfile / .gitignore seed residue", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "Taskfile.yml"),
      "version: '3'\n\n# Installed by Directive setup (Wave 2c). Framework tasks under deft:.\nincludes:\n",
    );
    writeFileSync(
      join(root, ".gitignore"),
      "node_modules/\n.deft/directive/wiring-ready.*.json\n",
    );
    // Placeholder one-liner present confirms seed recognition helpers stay imported.
    expect(CONSUMER_HEADER_PLACEHOLDER_ONELINER.length).toBeGreaterThan(0);

    const removed = removeSoleAuthorHusks(root);
    expect(removed).toEqual(expect.arrayContaining(["Taskfile.yml", ".gitignore"]));
    expect(existsSync(join(root, "Taskfile.yml"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });
});

describe("STRATEGIES table (WAVE3-V2 convert shapes)", () => {
  it("lists go-tarball / vendored-core-go / submodule with ordered steps + pin", () => {
    const go = strategyForShape("go-tarball-deft-root");
    expect(go.needsRuntimePin).toBe(true);
    expect(go.steps).toContain("removeDeftFrameworkTree");
    expect(go.steps).toContain("pruneEmptyAncestors");
    expect(go.steps).toContain("removeSoleAuthorHusks");

    const vendored = strategyForShape("vendored-core-go");
    expect(vendored.needsRuntimePin).toBe(true);
    expect(vendored.steps).toContain("removeCopiedCore");
    expect(vendored.steps.indexOf("removeCopiedCore")).toBeLessThan(
      vendored.steps.indexOf("pruneEmptyAncestors"),
    );

    const sub = strategyForShape("submodule-deft");
    expect(sub.needsRuntimePin).toBe(true);
    expect(sub.steps).toContain("normalizeGitmodules");
    expect(sub.steps).toContain("removeDeftFrameworkTree");
  });

  it("lists dual-layout and orphan convert strategies", () => {
    const dual = STRATEGIES["dual-layout-deft-and-core"];
    expect(dual.needsRuntimePin).toBe(true);
    expect(dual.steps.indexOf("removeDeftFrameworkTree")).toBeLessThan(
      dual.steps.indexOf("removeCopiedCore"),
    );

    const orphan = STRATEGIES["orphan-deft-version"];
    expect(orphan.needsRuntimePin).toBe(true);
    expect(orphan.steps).toContain("removeOrphanDeftVersion");
  });

  it("keeps L0 ovpr / npm-hybrid rows as anchors", () => {
    expect(STRATEGIES["ovpr-runtime-pin"].steps).toEqual([]);
    expect(STRATEGIES["npm-hybrid-pin-copied-core"].needsRuntimePin).toBe(true);
    expect(STRATEGIES["npm-hybrid-pin-copied-core"].steps).toContain("removeCopiedCore");
  });
});

describe("prune + husks composition", () => {
  it("husk-delete of {} hooks also prunes empty .cursor parent", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor", "hooks.json"), "{}\n");
    const removed = removeSoleAuthorHusks(root);
    expect(removed).toEqual(expect.arrayContaining([".cursor/hooks.json", ".cursor"]));
    expect(existsSync(join(root, ".cursor"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
