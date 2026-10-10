import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("@deftai/directive package bins", () => {
  it("declares directive and deft aliases to the same entrypoint", () => {
    const pkgDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(pkgDir, "../package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
      files: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.name).toBe("@deftai/directive");
    expect(pkg.bin.directive).toBe("./dist/bin.js");
    expect(pkg.bin.deft).toBe("./dist/bin.js");
    expect(pkg.bin["deft-ts"]).toBe("./dist/bin.js");
    expect(pkg.bin["deft-hook"]).toBe("./dist/hook-bin.js");
    expect(pkg.bin["deft-verify-encoding"]).toBe("./dist/verify-encoding.js");
    expect(Object.keys(pkg.bin)).toEqual([
      "directive",
      "deft",
      "deft-ts",
      "deft-hook",
      "deft-verify-encoding",
    ]);
    expect(pkg.files).toContain("scripts/remove-windows-ps1-shims.mjs");
    expect(pkg.scripts.postinstall).toBe("node ./scripts/remove-windows-ps1-shims.mjs");
  });
});
