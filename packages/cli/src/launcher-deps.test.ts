/**
 * AC3.1 / AC13.4 / AC4.1: packed launcher has empty deps; runtime carries contract.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function readPkg(packageDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("launcher package collapse (AC3.1 / AC13.4)", () => {
  it("packages/cli (@deftai/directive) has an empty dependency list", () => {
    const pkg = readPkg(join(HERE, ".."));
    expect(pkg.name).toBe("@deftai/directive");
    const deps = pkg.dependencies;
    expect(deps).toEqual({});
    expect(pkg.devDependencies === undefined || Object.keys(pkg.devDependencies as object).length === 0).toBe(
      true,
    );
    // No install script (AC3.5)
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    expect(scripts.postinstall).toBeUndefined();
    expect(scripts.preinstall).toBeUndefined();
  });

  it("packages/runtime (@deftai/directive-runtime) declares directive.contract === 1", () => {
    const pkg = readPkg(join(HERE, "..", "..", "runtime"));
    expect(pkg.name).toBe("@deftai/directive-runtime");
    const directive = pkg.directive as { contract?: unknown };
    expect(directive).toEqual({ contract: 1 });
    expect(pkg.engines).toMatchObject({ node: ">=20" });
  });

  it("core, content, and types are private workspace packages (AC13.4)", () => {
    for (const name of ["core", "content", "types"] as const) {
      const pkg = readPkg(join(HERE, "..", "..", name));
      expect(pkg.private, `${name} should be private`).toBe(true);
    }
  });
});
