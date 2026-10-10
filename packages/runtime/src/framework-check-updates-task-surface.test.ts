import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "./dispatch.js";
import { parseArgs, run } from "./framework-check-updates.js";
import { repoRoot } from "./gates-cli/_helpers.js";

describe("framework:check-updates task surface (#2069)", () => {
  it("routes framework:check-updates through native handler", () => {
    expect(resolveCanonicalVerb("framework:check-updates")).toBe("framework-check-updates");
  });

  it("framework.yml uses engine:invoke with no uv run python or run shim", () => {
    const text = readFileSync(join(repoRoot(), "tasks", "framework.yml"), "utf8");
    expect(text).toContain(":engine:invoke");
    expect(text).toContain("framework:check-updates");
    expect(text).not.toContain("uv run python");
    expect(text).not.toContain('run" check-updates');
    expect(text).not.toContain("run check-updates");
  });

  it("parseArgs rejects missing --project-root value", () => {
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
  });

  it("run returns 2 on parse error", () => {
    expect(run(["--project-root"])).toBe(2);
  });
});
