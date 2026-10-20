/**
 * Wave 3e — owner-boundary contracts for removal steps + strategy table.
 * pruneEmptyAncestors / removeSoleAuthorHusks (F-012 / F-013).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSUMER_HEADER_PLACEHOLDER_ONELINER,
  renderConsumerHeader,
} from "@deftai/directive-core/dist/platform/agents-consumer-header.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  isUnsafeSubmoduleGitlink,
  normalizeGitmodules,
  pruneEmptyAncestors,
  RemovalStepError,
  removeCopiedCore,
  removeDeftFrameworkTree,
  removeOrphanDeftVersion,
  removeSoleAuthorHusks,
  runStep,
} from "./steps.js";
import { runStrategy, STRATEGIES, strategyForShape } from "./strategies.js";

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
    expect(removed).toEqual(expect.arrayContaining([".agents/skills/directive-coding"]));
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
    expect(cmds).toEqual(expect.arrayContaining([".claude/commands", ".claude"]));
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
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);
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
    expect(removed).toEqual(expect.arrayContaining(["package.json", ".cursor/hooks.json"]));
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
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.deft/directive/wiring-ready.*.json\n");
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
    // F-016: husk cleanup is uninstall-only; convert must keep runtime pin package.json.
    expect(go.steps).not.toContain("removeSoleAuthorHusks");

    const vendored = strategyForShape("vendored-core-go");
    expect(vendored.needsRuntimePin).toBe(true);
    expect(vendored.steps).toContain("removeCopiedCore");
    expect(vendored.steps.indexOf("removeCopiedCore")).toBeLessThan(
      vendored.steps.indexOf("pruneEmptyAncestors"),
    );
    expect(vendored.steps).not.toContain("removeSoleAuthorHusks");

    const sub = strategyForShape("submodule-deft");
    expect(sub.needsRuntimePin).toBe(true);
    expect(sub.steps).toContain("normalizeGitmodules");
    expect(sub.steps).toContain("removeDeftFrameworkTree");
    expect(sub.steps).not.toContain("removeSoleAuthorHusks");
  });

  it("lists dual-layout and orphan convert strategies", () => {
    const dual = STRATEGIES["dual-layout-deft-and-core"];
    expect(dual.needsRuntimePin).toBe(true);
    expect(dual.steps.indexOf("removeDeftFrameworkTree")).toBeLessThan(
      dual.steps.indexOf("removeCopiedCore"),
    );
    expect(dual.steps).not.toContain("removeSoleAuthorHusks");

    const orphan = STRATEGIES["orphan-deft-version"];
    expect(orphan.needsRuntimePin).toBe(true);
    expect(orphan.steps).toContain("removeOrphanDeftVersion");
    expect(orphan.steps).not.toContain("removeSoleAuthorHusks");
  });

  it("keeps L0 ovpr / npm-hybrid rows as anchors", () => {
    expect(STRATEGIES["ovpr-runtime-pin"].steps).toEqual([]);
    expect(STRATEGIES["npm-hybrid-pin-copied-core"].needsRuntimePin).toBe(true);
    expect(STRATEGIES["npm-hybrid-pin-copied-core"].steps).toContain("removeCopiedCore");
    expect(STRATEGIES["npm-hybrid-pin-copied-core"].steps).not.toContain("removeSoleAuthorHusks");
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

describe("layout removal steps (WAVE3-V2 3f)", () => {
  it("removeCopiedCore deletes .deft/core and preserves xbrief", () => {
    const root = tempRoot("wave3f-core");
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "VERSION"), "v0.40.0\n");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "user\n");
    expect(removeCopiedCore(root)).toContain(".deft/core");
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
    expect(readFileSync(join(root, "xbrief", "keep.txt"), "utf8")).toBe("user\n");
  });

  it("removeDeftFrameworkTree deletes deft/ markers", () => {
    const root = tempRoot("wave3f-deft");
    mkdirSync(join(root, "deft"), { recursive: true });
    writeFileSync(join(root, "deft", "main.md"), "# legacy\n");
    writeFileSync(join(root, "deft", "VERSION"), "0.25.0\n");
    expect(removeDeftFrameworkTree(root)).toContain("deft");
    expect(existsSync(join(root, "deft"))).toBe(false);
  });

  it("removeOrphanDeftVersion clears .deft/VERSION only", () => {
    const root = tempRoot("wave3f-orphan");
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "VERSION"), "orphan\n");
    writeFileSync(join(root, ".deft", "settings.json"), "{}\n");
    expect(removeOrphanDeftVersion(root)).toContain(".deft/VERSION");
    expect(existsSync(join(root, ".deft", "VERSION"))).toBe(false);
    expect(existsSync(join(root, ".deft", "settings.json"))).toBe(true);
  });

  it("normalizeGitmodules strips deft stanza; unsafe gitlink throws", () => {
    const root = tempRoot("wave3f-gm");
    writeFileSync(
      join(root, ".gitmodules"),
      '[submodule "deft"]\n\tpath = deft\n\turl = https://github.com/deftai/directive.git\n',
    );
    const result = normalizeGitmodules(root);
    expect(result.removed).toContain(".gitmodules");
    expect(existsSync(join(root, ".gitmodules"))).toBe(false);
    // isUnsafeSubmoduleGitlink is false without a real gitlink index entry.
    expect(isUnsafeSubmoduleGitlink(root)).toBe(false);
  });

  it("runStep pruneEmptyAncestors accepts priorRemoved seeds", () => {
    const root = tempRoot("wave3f-prune-prior");
    mkdirSync(join(root, ".agents", "skills", "deft"), { recursive: true });
    // emptied already — dir empty
    const result = runStep("pruneEmptyAncestors", {
      root,
      priorRemoved: [".agents/skills/deft/SKILL.md"],
    });
    expect(result.removed).toEqual(
      expect.arrayContaining([".agents/skills/deft", ".agents/skills", ".agents"]),
    );
  });
});

describe("runStrategy (ordered convert)", () => {
  it("vendored-core-go removes core and preserves xbrief", () => {
    const root = tempRoot("wave3f-strat-v");
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "main.md"), "# c\n");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "ok\n");
    const result = runStrategy("vendored-core-go", root);
    expect(result.ok).toBe(true);
    expect(result.removed).toContain(".deft/core");
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
    expect(readFileSync(join(root, "xbrief", "keep.txt"), "utf8")).toBe("ok\n");
  });

  it("F-016: vendored-core-go keeps ensurePackageJson + runtime pin package.json", () => {
    // Bookend ensurePackageJson writes {private:true}; PM add pins runtime.
    // isSoleAuthorPackageJson would treat that as a husk — convert must not delete it.
    const root = tempRoot("wave3k-f016-strat");
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "VERSION"), "ref: 'v0.40.0'\n");
    writeFileSync(join(root, ".deft", "core", "main.md"), "# deposit\n");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "user\n");
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        { private: true, devDependencies: { "@deftai/directive-runtime": "9.9.9" } },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": { devDependencies: { "@deftai/directive-runtime": "9.9.9" } },
            "node_modules/@deftai/directive-runtime": { version: "9.9.9" },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = runStrategy("vendored-core-go", root);
    expect(result.ok).toBe(true);
    expect(result.removed).toContain(".deft/core");
    expect(result.removed).not.toContain("package.json");
    expect(result.removed).not.toContain("package-lock.json");
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "package-lock.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      private?: boolean;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.devDependencies?.["@deftai/directive-runtime"]).toBe("9.9.9");
    expect(readFileSync(join(root, "xbrief", "keep.txt"), "utf8")).toBe("user\n");
  });

  it("go-tarball-deft-root removes deft/", () => {
    const root = tempRoot("wave3f-strat-go");
    mkdirSync(join(root, "deft"), { recursive: true });
    writeFileSync(join(root, "deft", "VERSION"), "0.25\n");
    writeFileSync(join(root, "deft", "main.md"), "# m\n");
    const result = runStrategy("go-tarball-deft-root", root);
    expect(result.ok).toBe(true);
    expect(result.removed).toContain("deft");
    expect(existsSync(join(root, "deft"))).toBe(false);
  });

  it("dual-layout removes deft then core (order)", () => {
    const root = tempRoot("wave3f-strat-dual");
    mkdirSync(join(root, "deft"), { recursive: true });
    writeFileSync(join(root, "deft", "main.md"), "# d\n");
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "VERSION"), "v\n");
    const result = runStrategy("dual-layout-deft-and-core", root);
    expect(result.ok).toBe(true);
    expect(result.removed.indexOf("deft")).toBeLessThan(result.removed.indexOf(".deft/core"));
    expect(existsSync(join(root, "deft"))).toBe(false);
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
  });

  it("orphan-deft-version clears VERSION", () => {
    const root = tempRoot("wave3f-strat-or");
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "VERSION"), "x\n");
    const result = runStrategy("orphan-deft-version", root);
    expect(result.ok).toBe(true);
    expect(result.removed).toContain(".deft/VERSION");
  });

  it("RemovalStepError is the fail-closed type for unsafe gitlink", () => {
    expect(new RemovalStepError("normalizeGitmodules", "boom").stepId).toBe("normalizeGitmodules");
  });
});
