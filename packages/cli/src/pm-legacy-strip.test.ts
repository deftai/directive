/**
 * Wave4e RED: convert strip must drop retired triad packages
 * (@deftai/directive-core|content|types) as well as the pre-split launcher pin.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCHER_PACKAGE_NAME } from "./constants.js";
import * as pm from "./pm.js";

const TEMPS: string[] = [];

const TRIAD = [
  "@deftai/directive-core",
  "@deftai/directive-content",
  "@deftai/directive-types",
] as const;

/**
 * Expected wave4e strip API: removeLegacyDirectivePackages, or an expanded
 * removeLegacyDirectivePin that also drops the retired triad before PM add.
 */
function removeLegacyDirectivePackages(projectRoot: string): boolean {
  const expanded = (pm as { removeLegacyDirectivePackages?: (r: string) => boolean })
    .removeLegacyDirectivePackages;
  if (typeof expanded === "function") return expanded(projectRoot);
  return pm.removeLegacyDirectivePin(projectRoot);
}

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-legacy-strip-"));
  TEMPS.push(root);
  return root;
}

function writePkg(root: string, pkg: Record<string, unknown>): void {
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function readPkg(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("removeLegacyDirectivePackages / expanded removeLegacyDirectivePin (wave4e)", () => {
  it("strips @deftai/directive and triad core|content|types; preserves unrelated deps", () => {
    const root = tempProject();
    writePkg(root, {
      name: "legacy-triad",
      version: "0.0.0",
      private: true,
      dependencies: {
        lodash: "^4.17.21",
        [LAUNCHER_PACKAGE_NAME]: "0.119.11",
        "@deftai/directive-core": "0.119.11",
      },
      devDependencies: {
        prettier: "^3.0.0",
        "@deftai/directive-content": "0.119.11",
        "@deftai/directive-types": "0.119.11",
      },
    });

    const removed = removeLegacyDirectivePackages(root);
    expect(removed).toBe(true);

    const pkg = readPkg(root);
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const dev = (pkg.devDependencies ?? {}) as Record<string, string>;

    expect(deps[LAUNCHER_PACKAGE_NAME]).toBeUndefined();
    expect(dev[LAUNCHER_PACKAGE_NAME]).toBeUndefined();
    for (const name of TRIAD) {
      expect(deps[name]).toBeUndefined();
      expect(dev[name]).toBeUndefined();
    }
    expect(deps.lodash).toBe("^4.17.21");
    expect(dev.prettier).toBe("^3.0.0");
  });

  it("purges lockfiles that still reference retired triad packages", () => {
    const root = tempProject();
    writePkg(root, {
      name: "lock-triad",
      version: "0.0.0",
      private: true,
      dependencies: { lodash: "^4.17.21" },
    });
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      `lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      '@deftai/directive-core':\n        specifier: 0.121.0\n        version: 0.121.0\n      lodash:\n        specifier: ^4.17.21\n        version: 4.17.21\n`,
    );
    const purged = pm.purgeRetiredDirectiveLockfiles(root);
    expect(purged).toEqual(["pnpm-lock.yaml"]);
    expect(existsSync(join(root, "pnpm-lock.yaml"))).toBe(false);
  });

  it("strips triad-only pins when launcher pin is already absent", () => {
    const root = tempProject();
    writePkg(root, {
      name: "triad-only",
      version: "0.0.0",
      private: true,
      devDependencies: {
        "@deftai/directive-core": "0.119.11",
        "@deftai/directive-content": "0.119.11",
        "@deftai/directive-types": "0.119.11",
        typescript: "^5.0.0",
      },
    });

    const removed = removeLegacyDirectivePackages(root);
    expect(removed).toBe(true);

    const pkg = readPkg(root);
    const dev = (pkg.devDependencies ?? {}) as Record<string, string>;
    for (const name of TRIAD) {
      expect(dev[name]).toBeUndefined();
    }
    expect(dev.typescript).toBe("^5.0.0");
  });
});
