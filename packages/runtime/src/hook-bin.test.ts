import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "./hook-bin.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("deft-hook executable", () => {
  it("uses the direct hook dispatcher instead of the general CLI router", () => {
    const source = readFileSync(new URL("./hook-bin.ts", import.meta.url), "utf8");
    const runtimeManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin: Record<string, string> };
    const launcherManifest = JSON.parse(
      readFileSync(join(HERE, "..", "..", "cli", "package.json"), "utf8"),
    ) as { bin: Record<string, string> };

    expect(source).toContain('import { run } from "./hook-dispatch.js"');
    expect(source).toContain("isDirectEntrypoint");
    expect(source).not.toContain("routeAndDispatch");
    // Runtime ships hook-bin.js for package-relative host configs, not as an npm bin.
    expect(runtimeManifest.bin["deft-hook"]).toBeUndefined();
    expect(runtimeManifest.bin["directive-runtime"]).toBe("./dist/bin.js");
    // Global PATH name is the launcher shim (AC3.5 / Greptile).
    expect(launcherManifest.bin["deft-hook"]).toBe("./bin/deft-hook");
  });

  it("runs the hook dispatcher without entering the general router", () => {
    expect(main([])).toBe(2);
  });
});
