import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "./dispatch.js";
import { repoRoot } from "./gates-cli/_helpers.js";

describe("coverage:hotspots consumer task surface (#2683)", () => {
  it("routes coverage:hotspots through native handler", () => {
    expect(resolveCanonicalVerb("coverage:hotspots")).toBe("coverage-hotspots");
  });

  it("coverage.yml uses engine:invoke with guarded build dep", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "coverage.yml"), "utf8");
    expect(text).toContain(":engine:invoke");
    expect(text).toContain(":engine:_ts-build");
    expect(text).toContain("coverage:hotspots");
    expect(text).not.toContain("uv run python");
  });
});
