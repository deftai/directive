import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";

/**
 * Guard that maintainer `task check` stays aligned with CI's biome lane (#2220).
 *
 * `task check` dispatches through the TS orchestrator to `check:framework-source`
 * in the source checkout; that aggregate must depend on `ts:check-lane` (which runs
 * `pnpm run lint` / biome) so a green local gate matches the CI TypeScript lane.
 * Consumer `check:consumer` intentionally omits the biome lane (#1519).
 */
describe("task check biome lane wiring (#2220)", () => {
  const lines = readFileSync(join(repoRoot(), "Taskfile.yml"), { encoding: "utf8" }).split("\n");

  function depsBlock(taskName: string): string {
    const start = lines.findIndex((l) => l.trimStart().startsWith(`${taskName}:`));
    expect(start).toBeGreaterThan(-1);
    const depsIdx = lines.slice(start).findIndex((l) => l.trim() === "deps:");
    expect(depsIdx).toBeGreaterThan(-1);
    const depLines: string[] = [];
    for (const line of lines.slice(start + depsIdx + 1)) {
      if (/^\s{4}\S/.test(line) && !line.trimStart().startsWith("-")) break;
      if (line.trimStart().startsWith("-")) depLines.push(line);
    }
    return depLines.join("\n");
  }

  it("wires ts:check-lane into check:framework-source", () => {
    expect(depsBlock("check:framework-source")).toContain("ts:check-lane");
  });

  it("does not wire ts:check-lane into check:consumer (#1519)", () => {
    expect(depsBlock("check:consumer")).not.toContain("ts:check-lane");
  });

  it("dispatches task check through the TS orchestrator with framework + project roots", () => {
    const start = lines.findIndex((l) => /^\s+check:\s*$/.test(l) || l.trimStart() === "check:");
    expect(start).toBeGreaterThan(-1);
    const block = lines.slice(start, start + 12).join("\n");
    expect(block).toContain("ENGINE_CMD: 'check --framework-root");
    expect(block).toContain("--project-root");
  });
});
