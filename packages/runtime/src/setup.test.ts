/**
 * Runtime setup install|repair owner tests (Wave 2a / R8).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectDataStatus } from "./data-status.js";
import { CURRENT_DATA_SCHEMA_VERSION, DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { runSetup, setupChangeCount } from "./setup.js";

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

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("runSetup install|repair (R8 / AC8.*)", () => {
  it("install writes GENERATION, wiring-ready, AGENTS managed section, gitignore, seed", () => {
    const root = tempRoot();
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

  it("repair does not create seed placeholders (AC8.4)", () => {
    const root = tempRoot();
    runSetup({ operation: "install", from: "none", root });
    rmSync(join(root, "xbrief"), { recursive: true, force: true });
    const result = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(existsSync(join(root, "xbrief", ".directive-seed-placeholder"))).toBe(false);
    expect(result.created.some((p) => p.includes("seed"))).toBe(false);
  });

  it("install leaves data-schema current; repair does not migrate (AC6.2 / SEAM-DOC)", () => {
    const root = tempRoot();
    const installed = runSetup({ operation: "install", from: "none", root });
    expect(installed.conflicts).toEqual([]);
    expect(existsSync(join(root, DATA_SCHEMA_MARKER_REL))).toBe(true);
    const marker = JSON.parse(readFileSync(join(root, DATA_SCHEMA_MARKER_REL), "utf8")) as {
      schemaVersion: number;
    };
    expect(marker.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    expect(readProjectDataStatus(root).dataStatus).toBe("current");

    rmSync(join(root, DATA_SCHEMA_MARKER_REL), { force: true });
    expect(existsSync(join(root, DATA_SCHEMA_MARKER_REL))).toBe(false);
    const repaired = runSetup({ operation: "repair", from: installed.runtimeVersion, root });
    expect(repaired.conflicts).toEqual([]);
    expect(existsSync(join(root, DATA_SCHEMA_MARKER_REL))).toBe(false);
    expect(readProjectDataStatus(root).dataStatus).toBe("migration_needed");
  });

  it("second repair is idempotent (AC6.9 / AC8.2)", () => {
    const root = tempRoot();
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
    const first = runSetup({ operation: "install", from: "none", root });
    const readyPath = join(
      root,
      ".deft",
      "directive",
      `wiring-ready.${first.runtimeVersion}.json`,
    );
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

describe("runSetup old-style conversion (Wave 2f / AC10.3 / AC10.6 / AC10.9)", () => {
  function seedLegacyCore(root: string, edited = false): void {
    const core = join(root, ".deft", "core");
    mkdirSync(core, { recursive: true });
    writeFileSync(
      join(core, "VERSION"),
      "ref: 'v0.119.2'\ninstall_root: '.deft/core'\n",
    );
    writeFileSync(
      join(core, "main.md"),
      edited ? "# edited\nKEEP-EDIT\n" : "# deposit\n",
    );
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

  it("non-old-style upgrade does not remove an unrelated .deft/core tree", () => {
    // Defence: only conversion from old-style deletes core (AC10.3 scope).
    const root = tempRoot();
    seedLegacyCore(root, false);
    runSetup({ operation: "upgrade", from: "1.2.3", root });
    expect(existsSync(join(root, ".deft", "core", "VERSION"))).toBe(true);
  });
});
