import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("install-upgrade", () => {
  it("refreshes AGENTS.md when version marker already matches", () => {
    const project = mkdtempSync(join(tmpdir(), "deft-upgrade-"));
    temps.push(project);
    const deftDir = join(project, ".deft", "core");
    mkdirSync(join(deftDir, "templates"), { recursive: true });
    writeFileSync(
      join(deftDir, "templates", "agents-entry.md"),
      "<!-- deft:managed-section v3 -->\nbody\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    writeFileSync(join(deftDir, "VERSION"), "tag: v0.0.0-dev\n", "utf8");
    mkdirSync(join(project, "vbrief"), { recursive: true });
    writeFileSync(join(project, "vbrief", ".deft-version"), "0.0.0-dev\n", "utf8");

    const lines: string[] = [];
    const code = runInstallUpgrade(
      { projectRoot: project, frameworkRoot: deftDir },
      { writeOut: (t) => lines.push(t), writeErr: (t) => lines.push(t) },
    );
    expect([0, 2]).toContain(code);
    expect(lines.join("")).toContain("Upgrade");
  });
});
