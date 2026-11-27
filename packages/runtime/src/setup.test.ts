/**
 * Runtime setup install|repair owner tests (Wave 2a / R8).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectDataStatus } from "./data-status.js";
import { inventoryEntry } from "./installer-output-inventory.js";
import { CURRENT_DATA_SCHEMA_VERSION, DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { runSetup, setupChangeCount } from "./setup.js";
import { GIT_HOOKS_INACTIVE_NO_GIT } from "./setup-wiring.js";

const TEMPS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-2a-"));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

/** Minimal .git so setup can set core.hooksPath=.githooks (AC9.9 / AC8.6). */
function initGit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("runSetup install|repair (R8 / AC8.*)", { timeout: 30_000 }, () => {
  it("install writes GENERATION, wiring-ready, AGENTS managed section, gitignore, seed", () => {
    const root = tempRoot();
    initGit(root);
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.stub).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(true);
    const gen = JSON.parse(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")) as {
      runtimeVersion: string;
      packageManager: string;
    };
    expect(gen.runtimeVersion).toBeTruthy();
    expect(["npm", "pnpm"]).toContain(gen.packageManager);
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${gen.runtimeVersion}.json`)),
    ).toBe(true);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/node_modules\/@deftai\/directive-runtime/);
    expect(agents).toMatch(/deft:managed-section/);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/node_modules/);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/wiring-ready/);
    expect(existsSync(join(root, "xbrief", ".directive-seed-placeholder"))).toBe(true);
    expect(result.created.length).toBeGreaterThan(0);
  });

  it("install deposits the .deft/* block: runtime state ignored, committed records trackable (#6795)", () => {
    const root = tempRoot();
    initGit(root);
    // A `!` line placed before `.deft/*` would not apply; setup re-appends it in order.
    writeFileSync(join(root, ".gitignore"), "dist/\n!.deft/plan-sequence.json\n");
    runSetup({ operation: "install", from: "none", root });
    const lines = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
    expect(lines[0]).toBe("dist/");
    const star = lines.lastIndexOf(".deft/*");
    expect(star).toBeGreaterThan(0);
    expect(lines.lastIndexOf("!.deft/plan-sequence.json")).toBeGreaterThan(star);
    expect(lines.lastIndexOf("!.deft/approved-scope/**")).toBeGreaterThan(star);
    expect(lines.lastIndexOf(".deft/approved-scope/*.bak")).toBeGreaterThan(
      lines.lastIndexOf("!.deft/approved-scope/**"),
    );
    expect(lines).toContain(".deft-cache/");

    const ignored = (rel: string): boolean => {
      try {
        execFileSync("git", ["check-ignore", "-q", "--no-index", rel], { cwd: root });
        return true;
      } catch {
        return false;
      }
    };
    for (const rel of [
      ".deft/occupancy.json",
      ".deft/ritual-state.json",
      ".deft/applying-host.json",
      ".deft/authz/grants/x.json",
      ".deft/approved-scope/story.json.bak",
      ".deft/intent-constraint/story.json.next.tmp",
      ".deft-cache/github-issue/1.json",
      // #6842: readiness markers stay ignored after the `!.deft/directive/` lines.
      ".deft/directive/wiring-ready.1.2.3.json",
    ]) {
      expect(ignored(rel), rel).toBe(true);
    }
    for (const rel of [
      ".deft/plan-sequence.json",
      ".deft/GENERATION.json",
      ".deft/approved-scope/story.json",
      ".deft/intent-constraint/story.json",
      ".deft/observable-scope/story.json",
      DATA_SCHEMA_MARKER_REL,
    ]) {
      expect(ignored(rel), rel).toBe(false);
    }

    // A second run finds the block in order and adds nothing.
    const before = readFileSync(join(root, ".gitignore"), "utf8");
    runSetup({ operation: "repair", from: "0.0.0", root });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(before);
  });

  it("repair of a 0.130.1 .gitignore appends only the `.deft/directive/` lines (#6842)", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });
    // The 0.130.1 deposit: wiring-ready before `.deft/*`, no `.deft/directive/` lines.
    const old = readFileSync(join(root, ".gitignore"), "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("!.deft/directive/") && !l.startsWith(".deft/directive/"));
    old.splice(1, 0, ".deft/directive/wiring-ready.*.json");
    const oldText = old.join("\n");
    writeFileSync(join(root, ".gitignore"), oldText);
    runSetup({ operation: "repair", from: "0.130.1", root });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(
      `${oldText}!.deft/directive/\n!.deft/directive/**\n.deft/directive/wiring-ready.*.json\n`,
    );
  });

  it("repair does not create seed placeholders (AC8.4)", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });
    rmSync(join(root, "xbrief"), { recursive: true, force: true });
    const result = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(existsSync(join(root, "xbrief", ".directive-seed-placeholder"))).toBe(false);
    expect(result.created.some((p) => p.includes("seed"))).toBe(false);
  });

  it("install leaves data-schema current; repair does not migrate (AC6.2 / SEAM-DOC)", () => {
    const root = tempRoot();
    initGit(root);
    const installed = runSetup({ operation: "install", from: "none", root });
    expect(installed.conflicts).toEqual([]);
    expect(existsSync(join(root, DATA_SCHEMA_MARKER_REL))).toBe(true);
    const marker = JSON.parse(readFileSync(join(root, DATA_SCHEMA_MARKER_REL), "utf8")) as {
      schemaVersion: number;
    };
    expect(marker.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    expect(readProjectDataStatus(root).dataStatus).toBe("current");

    // Repair may restore a missing currency marker (not a migration).
    rmSync(join(root, DATA_SCHEMA_MARKER_REL), { force: true });
    expect(existsSync(join(root, DATA_SCHEMA_MARKER_REL))).toBe(false);
    const repaired = runSetup({ operation: "repair", from: installed.runtimeVersion, root });
    expect(repaired.conflicts).toEqual([]);
    expect(existsSync(join(root, DATA_SCHEMA_MARKER_REL))).toBe(true);
    expect(readProjectDataStatus(root).dataStatus).toBe("current");

    // Repair must not bump an already-behind schema marker (upgrade owns migration).
    writeFileSync(
      join(root, DATA_SCHEMA_MARKER_REL),
      `${JSON.stringify({ schemaVersion: CURRENT_DATA_SCHEMA_VERSION - 1 }, null, 2)}\n`,
    );
    const repairedBehind = runSetup({
      operation: "repair",
      from: installed.runtimeVersion,
      root,
    });
    expect(repairedBehind.conflicts).toEqual([]);
    const behind = JSON.parse(readFileSync(join(root, DATA_SCHEMA_MARKER_REL), "utf8")) as {
      schemaVersion: number;
    };
    expect(behind.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION - 1);
    expect(readProjectDataStatus(root).dataStatus).toBe("migration_needed");
  });

  it("second repair is idempotent (AC6.9 / AC8.2)", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });
    const second = runSetup({ operation: "repair", from: "0.0.0", root });
    const third = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(setupChangeCount(third)).toBe(0);
    // second may still settle; third must be empty
    expect(second.conflicts).toEqual([]);
    expect(third.created).toEqual([]);
    expect(third.modified).toEqual([]);
  });

  it("preserves existing xbrief bytes on repair (AC6.8)", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });
    const marker = join(root, "xbrief", "active", "user.xbrief.json");
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(marker, '{"keep":true}\n');
    const before = readFileSync(marker, "utf8");
    runSetup({ operation: "repair", from: "0.0.0", root });
    expect(readFileSync(marker, "utf8")).toBe(before);
  });

  it("does not write wiring-ready on AGENTS conflict and invalidates prior marker", () => {
    const root = tempRoot();
    initGit(root);
    const first = runSetup({ operation: "install", from: "none", root });
    const readyPath = join(root, ".deft", "directive", `wiring-ready.${first.runtimeVersion}.json`);
    expect(existsSync(readyPath)).toBe(true);
    writeFileSync(
      join(root, "AGENTS.md"),
      "<!-- deft:managed-section v3 -->\nbroken without close\n",
    );
    const result = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(existsSync(readyPath)).toBe(false);
    expect(result.message).toMatch(/conflict/i);
  });

  it("upgrade refreshes GENERATION/wiring-ready without creating seeds", () => {
    const root = tempRoot();
    initGit(root);
    const result = runSetup({ operation: "upgrade", from: "1.0.0", root });
    expect(result.stub).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(result.message).not.toMatch(/deferred/i);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(true);
    const gen = JSON.parse(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")) as {
      runtimeVersion: string;
    };
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${gen.runtimeVersion}.json`)),
    ).toBe(true);
    expect(existsSync(join(root, "xbrief", ".directive-seed-placeholder"))).toBe(false);
  });

  it("refuses AGENTS.md symlink escape outside the project", () => {
    const root = tempRoot();
    initGit(root);
    const outsideDir = mkdtempSync(join(tmpdir(), "setup-escape-"));
    TEMPS.push(outsideDir);
    const outsideFile = join(outsideDir, "escaped-agents.md");
    writeFileSync(outsideFile, "outside\n");
    try {
      symlinkSync(outsideFile, join(root, "AGENTS.md"));
    } catch {
      // Windows without symlink privilege: skip rather than fail the suite
      return;
    }
    const before = readFileSync(outsideFile, "utf8");
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(readFileSync(outsideFile, "utf8")).toBe(before);
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${result.runtimeVersion}.json`)),
    ).toBe(false);
  });
});

describe("GIT-HOOKS-INACTIVE no-git vs with-git (AC8.6 / AC2.5 / AC9.9)", () => {
  it("no .git: writes .githooks, discloses inactive, withholds wiring-ready", () => {
    const root = tempRoot();
    expect(existsSync(join(root, ".git"))).toBe(false);
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(root, ".githooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(root, ".githooks", "_directive-run.sh"))).toBe(true);
    expect(existsSync(join(root, ".deft", "GENERATION.json"))).toBe(true);
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${result.runtimeVersion}.json`)),
    ).toBe(false);
    expect(result.message).toContain(GIT_HOOKS_INACTIVE_NO_GIT);
    expect(result.created.some((p) => p.includes("wiring-ready."))).toBe(false);
  });

  it("with .git: sets core.hooksPath=.githooks and writes wiring-ready", () => {
    const root = tempRoot();
    initGit(root);
    const result = runSetup({ operation: "install", from: "none", root });
    expect(result.conflicts).toEqual([]);
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${result.runtimeVersion}.json`)),
    ).toBe(true);
    expect(result.message).not.toMatch(/Git hooks inactive/i);
    const hooksPath = execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
    }).trim();
    expect(hooksPath).toBe(".githooks");
  });

  it("after git init, repair activates hooksPath and writes readiness", () => {
    const root = tempRoot();
    const first = runSetup({ operation: "install", from: "none", root });
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${first.runtimeVersion}.json`)),
    ).toBe(false);
    initGit(root);
    const repaired = runSetup({
      operation: "repair",
      from: first.runtimeVersion,
      root,
    });
    expect(repaired.conflicts).toEqual([]);
    expect(
      existsSync(join(root, ".deft", "directive", `wiring-ready.${repaired.runtimeVersion}.json`)),
    ).toBe(true);
    expect(repaired.message).not.toMatch(/Git hooks inactive/i);
    const hooksPath = execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
    }).trim();
    expect(hooksPath).toBe(".githooks");
  });
});

describe("runSetup old-style conversion (Wave 2f / AC10.3 / AC10.6 / AC10.9)", () => {
  function seedLegacyCore(root: string, edited = false): void {
    const core = join(root, ".deft", "core");
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, "VERSION"), "ref: 'v0.119.2'\ninstall_root: '.deft/core'\n");
    writeFileSync(join(core, "main.md"), edited ? "# edited\nKEEP-EDIT\n" : "# deposit\n");
    writeFileSync(
      join(root, ".deft", "GENERATION.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          generation: 7,
          contentVersion: "0.119.2",
          stampedAt: "2026-09-17T20:29:29Z",
          stampedBy: "directive-update",
        },
        null,
        2,
      )}\n`,
    );
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "USER-NOTE.txt"), "preserve-me\n");
    writeFileSync(
      join(root, ".deft", "settings.json"),
      `${JSON.stringify({ keep: true }, null, 2)}\n`,
    );
    writeFileSync(join(root, "AGENTS.md"), "Follow `.deft/core/main.md`.\n");
  }

  it("from old-style removes edited .deft/core, raises generation, rewires package-relative", () => {
    const root = tempRoot();
    seedLegacyCore(root, true);
    const result = runSetup({ operation: "upgrade", from: "old-style", root });
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
    expect(result.removed).toContain(".deft/core");
    expect(readFileSync(join(root, "xbrief", "USER-NOTE.txt"), "utf8")).toBe("preserve-me\n");
    expect(readFileSync(join(root, ".deft", "settings.json"), "utf8")).toMatch(/"keep": true/);
    const gen = JSON.parse(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")) as {
      generation?: number;
      runtimeVersion?: string;
    };
    expect(gen.runtimeVersion).toBeTruthy();
    expect(gen.generation).toBeGreaterThan(7);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/node_modules\/@deftai\/directive-runtime/);
    // User-owned prose outside the managed section is preserved (AC10.6); the
    // managed section itself must not point at .deft/core.
    const managed = agents.match(
      /<!-- deft:managed-section[\s\S]*?<!-- \/deft:managed-section -->/,
    );
    expect(managed?.[0] ?? "").toMatch(/node_modules\/@deftai\/directive-runtime/);
    expect(managed?.[0] ?? "").not.toMatch(/\.deft\/core/);
  });

  it("#5838: from old-style rewrites the 0.126 pointer set so none targets .deft/core", () => {
    const root = tempRoot();
    seedLegacyCore(root);
    const hostRoots = [
      ".agents/skills",
      ".claude/skills",
      ".cursor/skills",
      ".codex/skills",
      ".github/skills",
    ];
    for (const host of hostRoots) {
      for (const name of [
        "deft-directive-tutorial",
        "deft-directive-feedback",
        "deft-directive-sync",
      ]) {
        mkdirSync(join(root, host, name), { recursive: true });
        writeFileSync(
          join(root, host, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: >-\n  old\n---\n\nRead and follow: .deft/core/skills/${name}/SKILL.md\n`,
        );
      }
    }
    const result = runSetup({ operation: "upgrade", from: "old-style", root });
    expect(result.conflicts).toEqual([]);
    for (const host of hostRoots) {
      for (const name of [
        "deft-directive-tutorial",
        "deft-directive-feedback",
        "deft-directive-sync",
      ]) {
        const body = readFileSync(join(root, host, name, "SKILL.md"), "utf8");
        expect(body).not.toContain(".deft/core/skills");
        expect(body).toContain(`node_modules/@deftai/directive-runtime/skills/${name}/SKILL.md`);
      }
    }
  });

  it("non-old-style upgrade does not remove an unrelated .deft/core tree", () => {
    // Defence: only conversion from old-style deletes core (AC10.3 scope).
    const root = tempRoot();
    seedLegacyCore(root, false);
    runSetup({ operation: "upgrade", from: "1.2.3", root });
    expect(existsSync(join(root, ".deft", "core", "VERSION"))).toBe(true);
  });

  it("D-022 / #6001: old-style upgrade removes version-only markers and lists them", () => {
    const root = tempRoot();
    seedLegacyCore(root);
    writeFileSync(join(root, "xbrief", ".deft-version"), "0.126.2\n");
    writeFileSync(join(root, ".deft-version"), "0.126.2\n");
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", ".deft-version"), "custom: keep\n");
    const result = runSetup({ operation: "upgrade", from: "old-style", root });
    expect(result.conflicts).toEqual([]);
    expect(result.removed).toEqual(
      expect.arrayContaining(["xbrief/.deft-version", ".deft-version"]),
    );
    expect(result.removed).not.toContain("vbrief/.deft-version");
    expect(existsSync(join(root, "xbrief", ".deft-version"))).toBe(false);
    expect(existsSync(join(root, ".deft-version"))).toBe(false);
    expect(readFileSync(join(root, "vbrief", ".deft-version"), "utf8")).toBe("custom: keep\n");
    expect(readFileSync(join(root, "xbrief", "USER-NOTE.txt"), "utf8")).toBe("preserve-me\n");
  });

  it("D-022: install and repair never remove the markers", () => {
    for (const operation of ["install", "repair"] as const) {
      const root = tempRoot();
      seedLegacyCore(root);
      writeFileSync(join(root, "xbrief", ".deft-version"), "0.126.2\n");
      const result = runSetup({ operation, from: "old-style", root });
      expect(result.removed).not.toContain("xbrief/.deft-version");
      expect(existsSync(join(root, "xbrief", ".deft-version"))).toBe(true);
    }
  });

  it("D-022: a non-conversion upgrade leaves the markers alone", () => {
    const root = tempRoot();
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".deft-version"), "0.126.2\n");
    const result = runSetup({ operation: "upgrade", from: "1.2.3", root });
    expect(result.removed).not.toContain("xbrief/.deft-version");
    expect(existsSync(join(root, "xbrief", ".deft-version"))).toBe(true);
  });
});

describe("runSetup convert-via-removals (WAVE3-V2 3f)", () => {
  it("D-022 / #6001: convert upgrade removes a version-only xbrief marker; inventory names it", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "VERSION"), "ref: 'v0.40.0'\n");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".deft-version"), "v0.40.0\n");
    writeFileSync(join(root, "xbrief", "keep.txt"), "user-data\n");
    const result = runSetup({ operation: "upgrade", from: "vendored-core-go", root });
    expect(result.conflicts).toEqual([]);
    expect(result.removed).toContain("xbrief/.deft-version");
    expect(existsSync(join(root, "xbrief", ".deft-version"))).toBe(false);
    expect(readFileSync(join(root, "xbrief", "keep.txt"), "utf8")).toBe("user-data\n");
    const entry = inventoryEntry("bare-version-marker");
    expect(entry?.disposition).toBe("na-retired-copy-model");
    expect(entry?.justification).toContain("AC8.10");
  });

  it("from vendored-core-go removes .deft/core and preserves xbrief", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "VERSION"), "ref: 'v0.40.0'\n");
    writeFileSync(join(root, ".deft", "core", "main.md"), "# deposit\n");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "user-data\n");
    const result = runSetup({ operation: "upgrade", from: "vendored-core-go", root });
    expect(result.conflicts).toEqual([]);
    expect(result.removed).toContain(".deft/core");
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
    expect(readFileSync(join(root, "xbrief", "keep.txt"), "utf8")).toBe("user-data\n");
  });

  it("F-016: vendored-core-go setup keeps private+runtime-pin package.json", () => {
    // Simulate bookend ensurePackageJson + PM exact add before setup handoff.
    const root = mkdtempSync(join(tmpdir(), "setup-f016-"));
    TEMPS.push(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "VERSION"), "ref: 'v0.40.0'\n");
    writeFileSync(join(root, ".deft", "core", "main.md"), "# deposit\n");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "keep-me\n");
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        { private: true, devDependencies: { "@deftai/directive-runtime": "9.9.9" } },
        null,
        2,
      )}\n`,
    );
    const result = runSetup({ operation: "upgrade", from: "vendored-core-go", root });
    expect(result.conflicts).toEqual([]);
    expect(result.removed).toContain(".deft/core");
    expect(result.removed).not.toContain("package.json");
    expect(existsSync(join(root, "package.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      private?: boolean;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.devDependencies?.["@deftai/directive-runtime"]).toBe("9.9.9");
    expect(readFileSync(join(root, "xbrief", "keep.txt"), "utf8")).toBe("keep-me\n");
  });

  it("from go-tarball-deft-root removes deft/", () => {
    const root = tempRoot();
    mkdirSync(join(root, "deft"), { recursive: true });
    writeFileSync(join(root, "deft", "main.md"), "# legacy\n");
    writeFileSync(join(root, "deft", "VERSION"), "0.25.0\n");
    const result = runSetup({ operation: "upgrade", from: "go-tarball-deft-root", root });
    expect(result.conflicts).toEqual([]);
    expect(result.removed).toContain("deft");
    expect(existsSync(join(root, "deft"))).toBe(false);
  });

  it("from dual-layout-deft-and-core removes deft then core", () => {
    const root = tempRoot();
    mkdirSync(join(root, "deft"), { recursive: true });
    writeFileSync(join(root, "deft", "main.md"), "# d\n");
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "VERSION"), "v\n");
    const result = runSetup({
      operation: "upgrade",
      from: "dual-layout-deft-and-core",
      root,
    });
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(root, "deft"))).toBe(false);
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
  });

  it("records every .mjs outer setup wrote as whole-file (#6615 AC1)", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });
    const gen = JSON.parse(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")) as {
      ownership: Array<{ path: string; kind: string }>;
    };
    const outers = gen.ownership.filter((o) => /deft-hook-[a-f0-9]{8}\.mjs$/.test(o.path));
    expect(outers.map((o) => o.path.replace(/deft-hook-[a-f0-9]{8}/, "X")).sort()).toEqual([
      ".agents/X.mjs",
      ".claude/X.mjs",
      ".codex/X.mjs",
      ".cursor/hooks/X.mjs",
      ".grok/hooks/X.mjs",
    ]);
    expect(outers.every((o) => o.kind === "whole-file")).toBe(true);
    for (const o of outers) expect(existsSync(join(root, o.path))).toBe(true);
  });

  it("a second setup with no change leaves GENERATION.json byte-identical (#6615 AC7 / AC13.2)", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });
    const first = readFileSync(join(root, ".deft", "GENERATION.json"), "utf8");
    runSetup({ operation: "repair", from: "none", root });
    expect(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")).toBe(first);
  });

  it("a CRLF checkout of the .mjs outers does not change GENERATION.json", () => {
    const root = tempRoot();
    initGit(root);
    runSetup({ operation: "install", from: "none", root });
    const first = readFileSync(join(root, ".deft", "GENERATION.json"), "utf8");
    const gen = JSON.parse(first) as { ownership: Array<{ path: string }> };
    for (const o of gen.ownership.filter((e) => e.path.endsWith(".mjs"))) {
      const abs = join(root, o.path);
      writeFileSync(abs, readFileSync(abs, "utf8").replace(/\r?\n/g, "\r\n"));
    }
    runSetup({ operation: "repair", from: "none", root });
    expect(readFileSync(join(root, ".deft", "GENERATION.json"), "utf8")).toBe(first);
  });
});

describe("GENERATION.json keeps the raised generation (#6012 / AC10.9)", () => {
  const genPath = (root: string): string => join(root, ".deft", "GENERATION.json");
  const readGen = (root: string): { generation?: number; runtimeVersion?: string } =>
    JSON.parse(readFileSync(genPath(root), "utf8")) as {
      generation?: number;
      runtimeVersion?: string;
    };

  function convertLegacy(root: string, generation: number): void {
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    writeFileSync(join(root, ".deft", "core", "main.md"), "# deposit\n");
    writeFileSync(genPath(root), `${JSON.stringify({ schemaVersion: 1, generation }, null, 2)}\n`);
    const result = runSetup({ operation: "upgrade", from: "old-style", root });
    expect(result.conflicts).toEqual([]);
  }

  it("conversion raises N to N+1 and a later version upgrade keeps it", () => {
    const root = tempRoot();
    initGit(root);
    convertLegacy(root, 12);
    expect(readGen(root).generation).toBe(13);

    // Simulate the record written by an older runtime so the next upgrade rewrites it.
    const prior = readGen(root);
    writeFileSync(
      genPath(root),
      `${JSON.stringify({ ...prior, runtimeVersion: "0.0.1-older" }, null, 2)}\n`,
    );
    const result = runSetup({ operation: "upgrade", from: "0.0.1-older", root });
    expect(result.conflicts).toEqual([]);
    expect(result.modified).toContain(".deft/GENERATION.json");
    const after = readGen(root);
    expect(after.runtimeVersion).not.toBe("0.0.1-older");
    expect(after.generation).toBe(13);
  });

  it("repair keeps the generation", () => {
    const root = tempRoot();
    initGit(root);
    convertLegacy(root, 12);
    const prior = readGen(root);
    writeFileSync(
      genPath(root),
      `${JSON.stringify({ ...prior, runtimeVersion: "0.0.1-older" }, null, 2)}\n`,
    );
    runSetup({ operation: "repair", from: "0.0.1-older", root });
    expect(readGen(root).generation).toBe(13);
  });

  it("a second identical run does not rewrite GENERATION.json (AC8.2 / AC13.2)", () => {
    const root = tempRoot();
    initGit(root);
    convertLegacy(root, 12);
    const version = readGen(root).runtimeVersion ?? "";
    runSetup({ operation: "upgrade", from: version, root });
    const before = readFileSync(genPath(root), "utf8");
    const result = runSetup({ operation: "upgrade", from: version, root });
    expect(result.modified).not.toContain(".deft/GENERATION.json");
    expect(readFileSync(genPath(root), "utf8")).toBe(before);
    expect(readGen(root).generation).toBe(13);
  });
});

describe("retired deft-core-guard workflow on upgrade (#5835)", () => {
  const guardRel = ".github/workflows/deft-core-guard.yml";
  function writeGuard(root: string, body: string): void {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, guardRel), body);
  }

  it("upgrade from a version removes Directive's guard and lists it", () => {
    const root = tempRoot();
    writeGuard(root, "name: deft-core-guard\non:\n  pull_request:\n");
    const result = runSetup({ operation: "upgrade", from: "0.129.1", root });
    expect(result.removed).toContain(guardRel);
    expect(existsSync(join(root, guardRel))).toBe(false);
    expect(result.preserved ?? []).not.toContain(guardRel);
  });

  it("upgrade keeps a user-edited file at that path and names it", () => {
    const root = tempRoot();
    writeGuard(root, "name: team-guard\n");
    const result = runSetup({ operation: "upgrade", from: "0.129.1", root });
    expect(result.removed).not.toContain(guardRel);
    expect(result.preserved).toContain(guardRel);
    expect(readFileSync(join(root, guardRel), "utf8")).toBe("name: team-guard\n");
  });

  it("install that converts an old layout also removes Directive's guard or names a kept one", () => {
    const managed = tempRoot();
    mkdirSync(join(managed, ".deft", "core"), { recursive: true });
    writeFileSync(join(managed, ".deft", "core", "main.md"), "# c\n");
    writeGuard(managed, "name: deft-core-guard\n");
    const removedResult = runSetup({
      operation: "install",
      from: "vendored-core-go",
      root: managed,
    });
    expect(removedResult.removed).toContain(guardRel);
    expect(existsSync(join(managed, guardRel))).toBe(false);

    const kept = tempRoot();
    mkdirSync(join(kept, ".deft", "core"), { recursive: true });
    writeFileSync(join(kept, ".deft", "core", "main.md"), "# c\n");
    writeGuard(kept, "name: team-guard\n");
    const keptResult = runSetup({ operation: "install", from: "vendored-core-go", root: kept });
    expect(keptResult.preserved).toContain(guardRel);
    expect(existsSync(join(kept, guardRel))).toBe(true);
  });

  it("install and repair leave the guard in place", () => {
    for (const operation of ["install", "repair"] as const) {
      const root = tempRoot();
      writeGuard(root, "name: deft-core-guard\n");
      const result = runSetup({ operation, from: "0.129.1", root });
      expect(result.removed).not.toContain(guardRel);
      expect(existsSync(join(root, guardRel))).toBe(true);
    }
  });
});

// #5961 / AC8.10: setup removes the retired `.deft/core` lines Directive wrote
// into shared files, lists them as modified, and writes no `.deft/core` text.
// #6167 / AC13.3: an existing `.prettierignore` gets the hook-file line.

const CODEQL_REL = ".github/codeql/codeql-config.yml";
const OLD_CODEQL =
  "# Deft framework: exclude the vendored payload from CodeQL analysis (#1430).\n" +
  "# .deft/core/** is packaged framework code, not consumer source.\n" +
  'name: "CodeQL config (deft)"\n' +
  "paths-ignore:\n" +
  "  - 'vendor/**'\n" +
  "  - '.deft/core/**'\n";
const OLD_ATTRS =
  "*.png binary\n\n" +
  "# Deft framework: the vendored payload is packaged framework code, not\n" +
  "# consumer source. text=auto + eol=lf normalizes text only; binaries keep\n" +
  "# byte identity. Mark generated + vendored (#1430, #2118, #5245).\n" +
  ".deft/core/** text=auto eol=lf\n" +
  ".deft/core/** linguist-generated=true\n" +
  ".deft/core/** linguist-vendored=true\n";

function writeRel(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function readRel(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" });
}

function committedProject(): string {
  const root = tempRoot();
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  return root;
}

function commitAll(root: string): void {
  git(root, ["add", "-A"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "old layout"]);
}

/** Every file under root except .git, project-relative. */
function allFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git") continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...allFiles(root, abs));
    else out.push(relative(root, abs));
  }
  return out;
}

function seedOldFiles(root: string): void {
  writeRel(root, ".gitattributes", OLD_ATTRS);
  writeRel(
    root,
    ".prettierignore",
    "dist/\n\n# Deft framework: the vendored payload is outside the consumer Prettier gate (#2534).\n.deft/core/\n",
  );
  writeRel(
    root,
    "greptile.json",
    '{\n  "ignorePatterns": "dist/**\\n.deft/core/**",\n  "x": 1\n}\n',
  );
  writeRel(root, CODEQL_REL, OLD_CODEQL);
}

const SHARED_FILES = [".gitattributes", ".prettierignore", "greptile.json", CODEQL_REL];

// Each case runs full setup more than once; the Windows VM needs about 2 minutes.
describe("setup and retired .deft/core lines (#5961)", { timeout: 240_000 }, () => {
  it("install on an empty project writes no .deft/core text anywhere", () => {
    const root = committedProject();
    runSetup({ operation: "install", from: "none", root });
    for (const rel of allFiles(root)) {
      expect(readRel(root, rel), rel).not.toContain(".deft/core");
    }
  });

  it("repair removes exactly the retired lines, reports them, and a second run changes nothing", () => {
    const root = committedProject();
    seedOldFiles(root);
    commitAll(root);

    const first = runSetup({ operation: "repair", from: "0.0.0", root });

    for (const rel of SHARED_FILES) {
      expect(first.modified).toContain(rel);
      expect(readRel(root, rel), rel).not.toContain(".deft/core");
    }
    expect(readRel(root, ".gitattributes").startsWith("*.png binary\n")).toBe(true);
    expect(readRel(root, ".prettierignore")).toBe(
      "dist/\n\n# Deft managed wiring: Directive's committed hook files are not formatted (AC13.3).\n**/deft-hook-*.mjs\n",
    );
    expect(readRel(root, "greptile.json")).toBe('{\n  "ignorePatterns": "dist/**",\n  "x": 1\n}\n');
    expect(readRel(root, CODEQL_REL)).toBe(
      "name: \"CodeQL config (deft)\"\npaths-ignore:\n  - 'vendor/**'\n",
    );

    const snapshot = Object.fromEntries(SHARED_FILES.map((rel) => [rel, readRel(root, rel)]));
    const second = runSetup({ operation: "repair", from: "0.0.0", root });
    for (const [rel, body] of Object.entries(snapshot)) {
      expect(readRel(root, rel), rel).toBe(body);
      expect(second.modified).not.toContain(rel);
    }
  });

  it("upgrade leaves a shared file with unstaged customer edits unstaged", () => {
    const root = committedProject();
    seedOldFiles(root);
    commitAll(root);
    writeRel(
      root,
      "greptile.json",
      '{\n  "ignorePatterns": "dist/**\\n.deft/core/**",\n  "x": 2\n}\n',
    );

    const result = runSetup({ operation: "upgrade", from: "0.0.0", root });

    expect(result.modified).toContain("greptile.json");
    expect(git(root, ["diff", "--cached", "--name-only", "--", "greptile.json"])).toBe("");
    expect(git(root, ["diff", "--cached", "--name-only", "--", CODEQL_REL]).trim()).toBe(
      CODEQL_REL,
    );
  });

  it("upgrade does not stage an untracked .prettierignore it adds the hook line to", () => {
    const root = committedProject();
    writeRel(root, "README.md", "x\n");
    commitAll(root);
    writeRel(root, ".prettierignore", "dist/\n");

    const result = runSetup({ operation: "upgrade", from: "0.0.0", root });

    expect(result.modified).toContain(".prettierignore");
    expect(readRel(root, ".prettierignore")).toContain("**/deft-hook-*.mjs");
    expect(git(root, ["status", "--porcelain", "--", ".prettierignore"]).trim()).toBe(
      "?? .prettierignore",
    );
  });

  it("no .prettierignore: setup does not create one (AC13.3)", () => {
    const root = committedProject();
    runSetup({ operation: "install", from: "none", root });
    expect(allFiles(root)).not.toContain(".prettierignore");
  });

  it("the inventory lists the managed LF block and the retired Prettier line", () => {
    expect(inventoryEntry("gitattributes-managed-wiring-lf")?.disposition).toBe("retained");
    expect(inventoryEntry("gitattributes-managed-wiring-lf")?.setupActivator).toBe(
      "ensureManagedPathGitattributes",
    );
    expect(inventoryEntry("prettierignore-core-exclusion")?.disposition).toBe(
      "na-retired-copy-model",
    );
    expect(inventoryEntry("prettierignore-hook-files")?.disposition).toBe("conditional");
  });
});
