import { describe, expect, it } from "vitest";
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
});
