import { describe, expect, it } from "vitest";
import { repoRoot } from "../content-contracts/standards/_helpers.js";
import { rehearseGreenfieldPythonFreeSmoke } from "./greenfield-python-free-smoke.js";

describe("rehearseGreenfieldPythonFreeSmoke (#2022 Phase 3)", () => {
  it("soft-skips when npm is absent", () => {
    const [ok, reason] = rehearseGreenfieldPythonFreeSmoke("/tmp/unused", { which: () => null });
    expect(ok).toBe(true);
    expect(reason).toContain("SKIP");
  });

  it("soft-skips when task is absent", () => {
    const [ok, reason] = rehearseGreenfieldPythonFreeSmoke("/tmp/unused", {
      which: (name) => (name === "npm" ? "/usr/bin/npm" : null),
    });
    expect(ok).toBe(true);
    expect(reason).toContain("SKIP");
  });

  it("fails when pnpm and corepack are absent", () => {
    const [ok, reason] = rehearseGreenfieldPythonFreeSmoke("/tmp/unused", {
      which: (name) => (name === "npm" ? "/usr/bin/npm" : name === "task" ? "/usr/bin/task" : null),
    });
    expect(ok).toBe(false);
    expect(reason).toContain("pnpm");
  });

  it("fails when version alignment cannot read package manifests", () => {
    const [ok, reason] = rehearseGreenfieldPythonFreeSmoke(
      "/tmp/deft-greenfield-missing-packages",
      {
        which: (name) => {
          if (name === "npm" || name === "task" || name === "pnpm") return `/usr/bin/${name}`;
          return null;
        },
      },
      { skipWorkspacePrep: true },
    );
    expect(ok).toBe(false);
    expect(reason).toContain("version-align FAIL");
  });

  it("emits progress callbacks before failing early (#2554)", () => {
    const progress: string[] = [];
    rehearseGreenfieldPythonFreeSmoke(
      "/tmp/deft-greenfield-missing-packages",
      {
        which: (name) => {
          if (name === "npm" || name === "task" || name === "pnpm") return `/usr/bin/${name}`;
          return null;
        },
      },
      {
        skipWorkspacePrep: true,
        onProgress: (message) => progress.push(message),
      },
    );
    expect(progress.some((line) => line.includes("aligning npm package versions"))).toBe(true);
  });

  it("reports spawn timeout diagnostics when a step is killed (#2554)", () => {
    const [ok, reason] = rehearseGreenfieldPythonFreeSmoke(
      repoRoot(),
      {
        which: (name) => {
          if (name === "npm" || name === "task" || name === "pnpm") return `/usr/bin/${name}`;
          return null;
        },
        spawnText: () => ({ status: 128, stdout: "", stderr: "" }),
      },
      { skipWorkspacePrep: true },
    );
    expect(ok).toBe(false);
    expect(reason).toContain("spawn budget");
  });
});
