import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInstallUpgrade } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scaffoldProject(
  base: string,
  version = "0.0.0-dev",
): { project: string; deftDir: string } {
  const project = join(base, "consumer");
  const deftDir = join(project, ".deft", "core");
  mkdirSync(join(deftDir, "templates"), { recursive: true });
  writeFileSync(
    join(deftDir, "templates", "agents-entry.md"),
    "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
    "utf8",
  );
  writeFileSync(join(deftDir, "VERSION"), `tag: v${version}\n`, "utf8");
  mkdirSync(join(project, "vbrief"), { recursive: true });
  return { project, deftDir };
}

describe("install-upgrade", () => {
  it("refreshes AGENTS.md when version marker already matches", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const { project, deftDir } = scaffoldProject(base);
    writeFileSync(join(project, "vbrief", ".deft-version"), "0.0.0-dev\n", "utf8");

    const lines: string[] = [];
    const code = runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect([0, 2]).toContain(code);
    expect(lines.join("")).toContain("Upgrade");
  });

  it("records a new version marker when recorded version differs", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const { project, deftDir } = scaffoldProject(base, "1.2.3");
    writeFileSync(join(project, "vbrief", ".deft-version"), "0.0.0-old\n", "utf8");

    const lines: string[] = [];
    const code = runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect([0, 2]).toContain(code);
    expect(lines.join("")).toContain("Updated .deft-version from 0.0.0-old to 1.2.3");
  });

  it("surfaces pre-cutover legacy guidance", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const { project, deftDir } = scaffoldProject(base);
    writeFileSync(join(project, "SPECIFICATION.md"), "# legacy\n", "utf8");

    const lines: string[] = [];
    runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect(lines.join("")).toContain("Pre-v0.20 document model detected");
    expect(lines.join("")).toContain("task migrate:vbrief");
  });

  it("records first-time version marker when none exists", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const { project, deftDir } = scaffoldProject(base, "1.2.3");

    const lines: string[] = [];
    const code = runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect([0, 2]).toContain(code);
    expect(lines.join("")).toContain("Recorded framework version 1.2.3");
  });

  it("auto-detects the consumer .deft/core manifest when framework-root has no version (#2053)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const { project } = scaffoldProject(base, "0.61.0");
    writeFileSync(join(project, "vbrief", ".deft-version"), "0.60.0\n", "utf8");

    // Simulate an npm-global engine root: has the AGENTS.md template but no
    // install manifest / .deft-version / git — so resolveVersion dead-ends at
    // the dev fallback and the consumer-manifest auto-detect must recover it.
    const fakeGlobal = join(base, "global-npm");
    mkdirSync(join(fakeGlobal, "templates"), { recursive: true });
    writeFileSync(
      join(fakeGlobal, "templates", "agents-entry.md"),
      "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
      "utf8",
    );

    const lines: string[] = [];
    runInstallUpgrade(
      { projectRoot: project, frameworkRoot: fakeGlobal },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    const out = lines.join("");
    expect(out).toContain("Deft CLI v0.61.0 - Upgrade");
    expect(out).toContain("Updated .deft-version from 0.60.0 to 0.61.0");
    expect(out).not.toContain("0.0.0-dev");
    expect(readFileSync(join(project, "vbrief", ".deft-version"), "utf8").trim()).toBe("0.61.0");
  });

  it("renders AGENTS.md from the deposited .deft/core templates, not the engine root (#2057)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const { project, deftDir } = scaffoldProject(base, "0.61.0");
    writeFileSync(
      join(deftDir, "templates", "agents-entry.md"),
      "<!-- deft:managed-section v3 -->\nDEPOSITED-TEMPLATE-BODY\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    writeFileSync(join(project, "vbrief", ".deft-version"), "0.60.0\n", "utf8");

    // Engine root carries a DIFFERENT template body, simulating a global npm
    // engine at a newer content version than the deposited payload.
    const fakeGlobal = join(base, "global-npm");
    mkdirSync(join(fakeGlobal, "templates"), { recursive: true });
    writeFileSync(
      join(fakeGlobal, "templates", "agents-entry.md"),
      "<!-- deft:managed-section v3 -->\nGLOBAL-ENGINE-BODY\n<!-- /deft:managed-section -->\n",
      "utf8",
    );

    runInstallUpgrade(
      { projectRoot: project, frameworkRoot: fakeGlobal },
      { writeOut: () => {}, writeErr: () => {} },
    );
    const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(agents).toContain("DEPOSITED-TEMPLATE-BODY");
    expect(agents).not.toContain("GLOBAL-ENGINE-BODY");
  });

  it("does not claim a marker update when the version stays at the dev fallback (#2053)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const { project, deftDir } = scaffoldProject(base, "0.0.0-dev");
    writeFileSync(join(project, "vbrief", ".deft-version"), "0.0.0-old\n", "utf8");

    const lines: string[] = [];
    runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    const out = lines.join("");
    expect(out).toContain("Could not resolve a published framework version");
    expect(out).not.toContain("Updated .deft-version from 0.0.0-old to 0.0.0-dev");
    // The marker write is a no-op on the dev fallback, so the stale value remains.
    expect(readFileSync(join(project, "vbrief", ".deft-version"), "utf8").trim()).toBe("0.0.0-old");
  });

  it("preserves managed_by: npm in the rewritten install manifest (#2056)", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const { project, deftDir } = scaffoldProject(base, "1.2.3");
    writeFileSync(
      join(deftDir, "VERSION"),
      "ref: 'v1.2.3'\ntag: 'v1.2.3'\nsha: 'content-package'\ninstall_root: '.deft/core'\nmanaged_by: 'npm'\n",
      "utf8",
    );
    writeFileSync(join(project, "vbrief", ".deft-version"), "1.0.0\n", "utf8");

    runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: () => {}, writeErr: () => {} },
    );
    const manifest = readFileSync(join(deftDir, "VERSION"), "utf8");
    expect(manifest).toContain("fetched_by: 'deft-upgrade'");
    expect(manifest).toContain("managed_by: 'npm'");
  });

  it("writes install manifest under legacy deft/ deposit", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const project = join(base, "consumer");
    const deftDir = join(project, "deft");
    mkdirSync(join(deftDir, "templates"), { recursive: true });
    writeFileSync(
      join(deftDir, "templates", "agents-entry.md"),
      "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    writeFileSync(join(deftDir, "VERSION"), "tag: v1.2.3\nsha: abc\n", "utf8");
    mkdirSync(join(project, "vbrief"), { recursive: true });
    writeFileSync(join(project, "vbrief", ".deft-version"), "1.0.0\n", "utf8");

    const lines: string[] = [];
    runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect(readFileSync(join(deftDir, "VERSION"), "utf8")).toContain("fetched_by: 'deft-upgrade'");
  });

  it("migrates stale legacy .deft/VERSION when canonical manifest differs", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const project = join(base, "consumer");
    const deftDir = join(project, ".deft", "core");
    mkdirSync(join(deftDir, "templates"), { recursive: true });
    writeFileSync(
      join(deftDir, "templates", "agents-entry.md"),
      "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    writeFileSync(
      join(deftDir, "VERSION"),
      "tag: v2.0.0\nsha: content-package\ninstall_root: .deft/core\n",
      "utf8",
    );
    mkdirSync(join(project, ".deft"), { recursive: true });
    writeFileSync(join(project, ".deft", "VERSION"), "tag: v1.0.0\nsha: old\n", "utf8");
    mkdirSync(join(project, "vbrief"), { recursive: true });
    writeFileSync(join(project, "vbrief", ".deft-version"), "1.0.0\n", "utf8");

    runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: () => {}, writeErr: () => {} },
    );
    expect(existsSync(join(project, ".deft", "VERSION.premigrate"))).toBe(true);
    expect(readFileSync(join(deftDir, "VERSION"), "utf8")).toContain("fetched_by: 'deft-upgrade'");
  });

  it("reports current AGENTS.md when refresh is a no-op", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(base);
    const { project, deftDir } = scaffoldProject(base);
    writeFileSync(
      join(project, "AGENTS.md"),
      "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    writeFileSync(join(project, "vbrief", ".deft-version"), "0.0.0-dev\n", "utf8");

    const lines: string[] = [];
    const code = runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect(code).toBe(0);
    expect(lines.join("")).toContain("managed section is current");
  });
});
