import { describe, expect, it } from "vitest";
import { main } from "../../core/src/cache/main.js";

describe("cache CLI wrapper", () => {
  it("main rejects missing subcommand", () => {
    expect(main([])).toBe(2);
  });

  it("invalidate on missing entry exits 0", () => {
    expect(main(["invalidate", "github-issue", "deftai/directive/99999"])).toBe(0);
  });
});

describe("cache.ts entry", () => {
  it("re-exports main", async () => {
    const mod = await import("./cache.js");
    expect(typeof mod.main).toBe("function");
  });
});
