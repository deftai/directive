import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runDeftTs } from "./deft-ts-runner.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeProjectRoot(capacity?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cli-cap-"));
  temps.push(root);
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "vbrief", folder), { recursive: true });
  }
  const plan: Record<string, unknown> = { title: "Capacity test", status: "running", items: [] };
  if (capacity !== undefined) {
    plan.policy = { capacityAllocation: capacity };
  }
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan }),
    "utf8",
  );
  return root;
}

function writeCompleted(root: string, name: string, metadata: Record<string, unknown>): void {
  writeFileSync(
    join(root, "vbrief", "completed", `${name}.vbrief.json`),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: name, status: "completed", items: [], metadata },
    }),
    "utf8",
  );
}

describe("deft-ts capacity-show", () => {
  it("exits 0 and reports advisory when unconfigured", () => {
    const root = makeProjectRoot();
    const result = runDeftTs("capacity-show", ["--project-root", root]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ADVISORY");
    expect(result.stdout).toContain("not configured");
  });

  it("exits 0 with advisory mode below minSampleSize", () => {
    const root = makeProjectRoot({
      unit: "vbrief-count",
      window: 30,
      enforcement: "advise",
      minSampleSize: 5,
      defaultBucket: "feature",
      buckets: [
        { id: "debt", target: 0.4 },
        { id: "feature", target: 0.6 },
      ],
    });
    writeCompleted(root, "done-0", {
      capacityBucket: "feature",
      completedAt: "2026-06-03T12:00:00Z",
    });
    const result = runDeftTs("capacity-show", ["--project-root", root]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ADVISORY");
  });

  it("exits 2 for missing --project-root value", () => {
    const result = runDeftTs("capacity-show", ["--project-root"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--project-root");
  });

  it("exits 2 for invalid project root path", () => {
    const result = runDeftTs("capacity-show", [
      "--project-root",
      join(tmpdir(), "missing-capacity-root-xyz"),
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not a directory");
  });
});

describe("deft-ts capacity-backfill", () => {
  it("exits 2 when capacityAllocation is not configured", () => {
    const root = makeProjectRoot();
    const result = runDeftTs("capacity-backfill", ["--project-root", root]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not configured");
  });

  it("honours --dry-run without mutating completed vBRIEF metadata", () => {
    const root = makeProjectRoot({
      unit: "vbrief-count",
      window: 30,
      enforcement: "advise",
      minSampleSize: 1,
      defaultBucket: "feature",
      buckets: [{ id: "feature", target: 1.0 }],
      matchers: [{ bucket: "feature", matchLabels: ["feature"] }],
    });
    const path = join(root, "vbrief", "completed", "story-a.vbrief.json");
    writeCompleted(root, "story-a", { completedAt: "2026-06-03T12:00:00Z" });
    const before = readFileSync(path, "utf8");
    const result = runDeftTs("capacity-backfill", ["--dry-run", "--project-root", root]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
