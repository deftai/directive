import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main } from "./hook-bin.js";

describe("deft-hook executable", () => {
  it("uses the direct hook dispatcher instead of the general CLI router", () => {
    const source = readFileSync(new URL("./hook-bin.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin: Record<string, string> };

    expect(source).toContain('import { run } from "./hook-dispatch.js"');
    expect(source).toContain("isDirectEntrypoint");
    expect(source).not.toContain("routeAndDispatch");
    expect(manifest.bin["deft-hook"]).toBe("./dist/hook-bin.js");
  });

  it("runs the hook dispatcher without entering the general router", () => {
    expect(main([])).toBe(2);
  });
});
