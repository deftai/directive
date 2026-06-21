import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runDeftTs } from "./deft-ts-runner.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makePendingRoadmapFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-roadmap-"));
  temps.push(root);
  const pending = join(root, "vbrief", "pending");
  mkdirSync(pending, { recursive: true });
  writeFileSync(
    join(pending, "2026-01-01-feature.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: {
        title: "Feature A",
        status: "pending",
        metadata: { "x-migrator": { Phase: "Phase 1", PhaseDescription: "Foundation" } },
        references: [{ uri: "https://github.com/deftai/directive/issues/42" }],
      },
    }),
    "utf8",
  );
  return root;
}

describe("deft-ts roadmap-render", () => {
  it("renders ROADMAP.md for pending vBRIEFs", () => {
    const root = makePendingRoadmapFixture();
    const outPath = join(root, "ROADMAP.md");
    const pending = join(root, "vbrief", "pending");
    const result = runDeftTs("roadmap-render", [pending, outPath]);
    expect(result.exitCode).toBe(0);
    const content = readFileSync(outPath, "utf8");
    expect(content).toContain("# Roadmap");
    expect(content).toContain("Phase 1");
    expect(content).toContain("#42");
  });

  it("reports drift with --check when file is stale", () => {
    const root = makePendingRoadmapFixture();
    const outPath = join(root, "ROADMAP.md");
    const pending = join(root, "vbrief", "pending");
    writeFileSync(outPath, "stale roadmap\n", "utf8");
    const result = runDeftTs("roadmap-render", ["--check", pending, outPath]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/drift|out of date/i);
  });

  it("accepts empty pending directory", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cli-roadmap-empty-"));
    temps.push(root);
    const pending = join(root, "vbrief", "pending");
    mkdirSync(pending, { recursive: true });
    const outPath = join(root, "ROADMAP.md");
    const result = runDeftTs("roadmap-render", [pending, outPath]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(outPath, "utf8")).toContain("No pending work items");
  });
});

describe("deft-ts framework-commands", () => {
  it("prints help when invoked without a verb", () => {
    const result = runDeftTs("framework-commands", []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available framework verbs");
    expect(result.stdout).toContain("doctor");
  });

  it("returns exit 2 for unknown framework command", () => {
    const result = runDeftTs("framework-commands", ["__missing__"]);
    expect(result.exitCode).toBe(2);
  });

  it("registers triage:queue in help surface", () => {
    const result = runDeftTs("framework-commands", ["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("triage:queue");
  });
});

describe("deft-ts doctor", () => {
  it("runs doctor --session on the framework root", () => {
    const result = runDeftTs("doctor", ["--session"]);
    expect([0, 1]).toContain(result.exitCode);
    expect(result.stdout + result.stderr).toMatch(/doctor|Deft/i);
  });
});
