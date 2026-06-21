import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveRepoRoot, runDeftTs } from "./deft-ts-runner.js";

const repoRoot = resolveRepoRoot();
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("deft-ts pack-render", () => {
  it("reports all projections in sync with --check", () => {
    const result = runDeftTs("pack-render", ["--check"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("in sync");
  });

  it("renders legacy source/output pair", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-pack-legacy-"));
    temps.push(root);
    const source = join(repoRoot, "packs", "lessons", "lessons-pack-0.1.json");
    const output = join(root, "lessons.md");
    const result = runDeftTs("pack-render", ["--source", source, "--output", output]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(output, "utf8")).toContain("# Lessons Learned");
  });

  it("exits 1 when --check detects drift", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-pack-drift-"));
    temps.push(root);
    const source = join(repoRoot, "packs", "lessons", "lessons-pack-0.1.json");
    const output = join(root, "lessons.md");
    writeFileSync(output, "stale projection\n", "utf8");
    const result = runDeftTs("pack-render", ["--check", "--source", source, "--output", output]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pack-drift");
  });
});

describe("deft-ts packs-slice", () => {
  it("lists packs in text mode", () => {
    const result = runDeftTs("packs-slice", ["--list-packs"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lessons");
  });

  it("lists slice names for lessons pack", () => {
    const result = runDeftTs("packs-slice", ["lessons", "--list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("recent");
  });

  it("rejects invalid --since on recent slice", () => {
    const result = runDeftTs("packs-slice", ["lessons", "recent", "--since", "not-a-date"]);
    expect(result.exitCode).toBe(2);
  });
});
