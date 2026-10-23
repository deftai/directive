/**
 * #5854 bookend-level proof: `directive upgrade` on a pnpm project with a prior
 * exact runtime minimumReleaseAgeExclude row ends with exactly one target row,
 * even when the package manager appends its own row during the add.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUpgrade } from "./bookends.js";
import { readProjectInstallState } from "./pin.js";

const TEMPS: string[] = [];
afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

const WS = (rows: string) =>
  `packages:\n  - .\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n${rows}allowBuilds:\n  '@deftai/directive-runtime@1.2.3': true\n`;

function writeRuntime(root: string, version: string): void {
  const nm = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(join(nm, "dist"), { recursive: true });
  writeFileSync(
    join(nm, "package.json"),
    `${JSON.stringify({ name: "@deftai/directive-runtime", version, directive: { contract: 1 } }, null, 2)}\n`,
  );
  writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
}

function writePin(root: string, version: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "t",
        version: "0.0.0",
        private: true,
        devDependencies: { "@deftai/directive-runtime": version },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      '@deftai/directive-runtime':\n        specifier: ${version}\n        version: ${version}\n`,
  );
}

function pnpmProject(rows: string): string {
  const root = mkdtempSync(join(tmpdir(), "age-exclude-upgrade-"));
  TEMPS.push(root);
  writePin(root, "1.2.3");
  writeRuntime(root, "1.2.3");
  writeFileSync(join(root, "pnpm-workspace.yaml"), WS(rows), "utf8");
  return root;
}

function capture() {
  const out: string[] = [];
  return {
    io: { writeOut: (t: string) => void out.push(t), writeErr: (_t: string) => undefined },
    out: () => out.join(""),
  };
}

const okInvoke = (entry: "setup" | "migrate") => () => ({
  exitCode: 0,
  stdout: JSON.stringify(
    entry === "setup"
      ? {
          contract: 1,
          entry,
          operation: "upgrade",
          created: [],
          modified: [],
          removed: [],
          conflicts: [],
        }
      : { contract: 1, entry, migrated: [], created: [], modified: [], removed: [] },
  ),
  stderr: "",
  spawned: true,
  message: null,
});

const runtimeItems = (yaml: string) =>
  yaml.split(/\r?\n/).filter((l) => /^\s*-\s/.test(l) && l.includes("@deftai/directive-runtime@"));

describe("upgrade replaces the runtime AgeExclude row (#5854)", () => {
  it("old-only workspace + pnpm appending its own row -> exactly one quoted target", () => {
    const root = pnpmProject("  - '@deftai/directive-runtime@1.2.3'\n");
    let preAdd: string[] = [];
    const c = capture();
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: ({ projectRoot, version }) => {
          const ws = join(projectRoot, "pnpm-workspace.yaml");
          preAdd = runtimeItems(readFileSync(ws, "utf8"));
          // pnpm itself appends an exclude row for the freshly-published target.
          writeFileSync(
            ws,
            readFileSync(ws, "utf8").replace(
              "allowBuilds:",
              `  - '@deftai/directive-runtime@${version}'\nallowBuilds:`,
            ),
          );
          writePin(projectRoot, version);
          writeRuntime(projectRoot, version);
          return { ok: true as const };
        },
        invokeSetup: okInvoke("setup"),
        invokeMigrate: okInvoke("migrate"),
      },
    );
    expect(code).toBe(0);
    expect(preAdd).toEqual(["  - '@deftai/directive-runtime@2.0.0'"]);
    const after = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(runtimeItems(after)).toEqual(["  - '@deftai/directive-runtime@2.0.0'"]);
    expect(after).toContain("'@deftai/directive-runtime@1.2.3': true");
  });

  it("--dry-run discloses the replace and leaves the workspace byte-identical", () => {
    const root = pnpmProject("  - '@deftai/directive-runtime@1.2.3'\n");
    const before = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const c = capture();
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--dry-run", "--target-version", "2.0.0"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: () => {
          throw new Error("PM must not run");
        },
      },
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/minimumReleaseAgeExclude/);
    expect(c.out()).toMatch(/2\.0\.0/);
    expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).toBe(before);
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(true);
  });
});
