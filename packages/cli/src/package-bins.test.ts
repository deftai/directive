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
    };
    expect(pkg.name).toBe("@deftai/directive");
    expect(pkg.bin.directive).toBe("./dist/bin.js");
    expect(pkg.bin.deft).toBe("./dist/bin.js");
  });
});
