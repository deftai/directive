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

function scaffoldProject(base: string): { project: string; deftDir: string } {
  const project = join(base, "consumer");
  const deftDir = join(project, ".deft", "core");
  mkdirSync(join(deftDir, "templates"), { recursive: true });
  writeFileSync(
    join(deftDir, "templates", "agents-entry.md"),
    "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
    "utf8",
  );
  writeFileSync(join(deftDir, "VERSION"), "tag: v0.0.0-dev\n", "utf8");
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
    const { project, deftDir } = scaffoldProject(base);
    writeFileSync(join(project, "vbrief", ".deft-version"), "0.0.0-old\n", "utf8");

    const lines: string[] = [];
    const code = runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect([0, 2]).toContain(code);
    expect(lines.join("")).toContain("Updated .deft-version from 0.0.0-old to 0.0.0-dev");
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
    const { project, deftDir } = scaffoldProject(base);

    const lines: string[] = [];
    const code = runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect([0, 2]).toContain(code);
    expect(lines.join("")).toContain("Recorded framework version");
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
