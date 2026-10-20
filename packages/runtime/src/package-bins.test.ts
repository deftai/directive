import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function readPkg(packageDir: string): {
  name: string;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name: string;
    bin: Record<string, string>;
    files: string[];
    scripts: Record<string, string>;
  };
}

describe("OVPR published package bins", () => {
  it("runtime (@deftai/directive-runtime) publishes only directive-runtime", () => {
    const pkg = readPkg(join(HERE, ".."));
    expect(pkg.name).toBe("@deftai/directive-runtime");
    expect(pkg.bin).toEqual({ "directive-runtime": "./dist/bin.js" });
    // Hosts call package-relative dist/hook-bin.js; not an npm bin.
    expect(pkg.bin["deft-hook"]).toBeUndefined();
    expect(pkg.files).toContain("scripts/remove-windows-ps1-shims.mjs");
    expect(pkg.scripts.postinstall).toBe("node ./scripts/remove-windows-ps1-shims.mjs");
  });

  it("launcher (@deftai/directive) maps directive/deft to dist/bin.js and deft-hook to PATH shim", () => {
    const pkg = readPkg(join(HERE, "..", "..", "cli"));
    expect(pkg.name).toBe("@deftai/directive");
    expect(pkg.bin).toEqual({
      directive: "./dist/bin.js",
      deft: "./dist/bin.js",
      "deft-hook": "./bin/deft-hook",
    });
    expect(pkg.files).toEqual(["dist/bin.js", "bin/deft-hook", "bin/deft-hook.cmd"]);
  });
});
