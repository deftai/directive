import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../content-contracts/standards/_helpers.js";
import {
  rehearseGreenfieldPythonFreeSmoke,
  runConsumerDocsImpactSmoke,
} from "./greenfield-python-free-smoke.js";

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

describe("runConsumerDocsImpactSmoke (#4356)", () => {
  it("fails closed when the deposited task still hits MODULE_NOT_FOUND", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-smoke-"));
    writeFileSync(join(dir, "keep.txt"), "x\n");
    const [ok, reason] = runConsumerDocsImpactSmoke(
      () => ({
        status: 1,
        stdout: "",
        stderr:
          "Error: Cannot find module '.../packages/core/dist/docs/docs-impact.js'\ncode: 'MODULE_NOT_FOUND'\n",
      }),
      {
        taskBin: "/usr/bin/task",
        gitBin: "/usr/bin/git",
        projectDir: dir,
        env: {},
      },
    );
    expect(ok).toBe(false);
    expect(reason).toContain("MODULE_NOT_FOUND");
  });

  it("runs invalid body then origin/master fixture then valid body", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-smoke-ok-"));
    const calls: string[][] = [];
    const [ok, reason] = runConsumerDocsImpactSmoke(
      (_cmd, args) => {
        calls.push([...args]);
        if (
          args[0] === "deft:verify:docs-impact" &&
          args.some((a) => a.includes("docs-impact-invalid.md"))
        ) {
          return {
            status: 1,
            stdout: "",
            stderr:
              "missing documentation-impact declaration (change_class or `no user-doc impact`)\n",
          };
        }
        return { status: 0, stdout: "OK\n", stderr: "" };
      },
      {
        taskBin: "/usr/bin/task",
        gitBin: "/usr/bin/git",
        projectDir: dir,
        env: {},
      },
    );
    expect(ok, reason).toBe(true);
    expect(reason).toContain("origin/master");
    expect(calls.some((args) => args[0] === "init" && args.includes("-b"))).toBe(true);
    expect(calls.some((args) => args[0] === "rev-parse")).toBe(false);
    expect(calls.some((args) => args.includes("feat/docs-impact-smoke"))).toBe(true);
    expect(
      calls.some(
        (args) => args.includes("update-ref") && args.includes("refs/remotes/origin/master"),
      ),
    ).toBe(true);
    expect(
      calls.some((args) => args[0] === "deft:verify:docs-impact" && args.includes("--body-file")),
    ).toBe(true);
  });

  it("fails when git is missing so the origin/master fixture cannot be created", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-impact-smoke-nogit-"));
    const [ok, reason] = runConsumerDocsImpactSmoke(
      () => ({
        status: 1,
        stdout: "",
        stderr: "missing documentation-impact declaration\n",
      }),
      {
        taskBin: "/usr/bin/task",
        gitBin: null,
        projectDir: dir,
        env: {},
      },
    );
    expect(ok).toBe(false);
    expect(reason).toContain("origin/master");
  });
});
