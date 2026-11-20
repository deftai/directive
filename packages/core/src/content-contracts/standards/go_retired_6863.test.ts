/**
 * #6863: Go is retired from master. The frozen Go installer bridge stays on its
 * published v0.58.0 release; master carries no Go source, toolchain probe, Go CI
 * step, Go release workflow or bridge freeze/drift gate.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAINTAINER_TOOLS } from "../../verify-env/toolchain-check.js";
import { repoRoot } from "./_helpers.js";

function repoPath(rel: string): string {
  return join(repoRoot(), rel);
}

function repoText(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}

describe("Go retired from master (#6863)", () => {
  it("has no go.mod and no Go sources under content/templates", () => {
    expect(existsSync(repoPath("go.mod"))).toBe(false);
    const goFiles = readdirSync(repoPath("content/templates")).filter((name) =>
      name.endsWith(".go"),
    );
    expect(goFiles).toEqual([]);
  });

  it("does not probe go in the maintainer toolchain check", () => {
    expect(MAINTAINER_TOOLS.map((tool) => tool.name)).not.toContain("go");
  });

  it("has no setup-go step in ci.yml and no Go release workflow", () => {
    expect(repoText(".github/workflows/ci.yml")).not.toContain("actions/setup-go");
    expect(existsSync(repoPath(".github/workflows/release.yml"))).toBe(false);
  });

  it("has no gomod Dependabot entry", () => {
    expect(repoText(".github/dependabot.yml")).not.toMatch(/package-ecosystem:\s*gomod/);
  });

  it("has no legacy-bridge module or bridge freeze/drift gates", () => {
    expect(existsSync(repoPath("packages/core/src/legacy-bridge"))).toBe(false);
    const verifyTasks = repoText("tasks/verify.yml");
    expect(verifyTasks).not.toMatch(/^ {2}go-freeze:/m);
    expect(verifyTasks).not.toMatch(/^ {2}bridge-drift:/m);
  });
});
