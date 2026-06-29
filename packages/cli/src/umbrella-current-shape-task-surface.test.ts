import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "./dispatch.js";
import { repoRoot } from "./gates-cli/_helpers.js";
import { parseArgs, run } from "./umbrella-current-shape.js";

describe("umbrella:current-shape task surface (#2066)", () => {
  it("routes umbrella:current-shape through native handler", () => {
    expect(resolveCanonicalVerb("umbrella:current-shape")).toBe("umbrella-current-shape");
  });

  it("umbrella.yml uses engine:invoke with _ensure-ts rebuild", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "umbrella.yml"), "utf8");
    expect(text).toContain(":engine:invoke");
    expect(text).toContain("_ensure-ts");
    expect(text).toContain("umbrella:current-shape");
    expect(text).not.toContain("uv run python");
    expect(text).not.toContain("run umbrella");
  });

  it("parseArgs rejects missing --project-root value", () => {
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
  });

  it("run returns 2 on parse error", () => {
    expect(run(["--project-root"])).toBe(2);
  });

  it("run returns 2 when issue number missing", () => {
    expect(run([])).toBe(2);
  });
});
