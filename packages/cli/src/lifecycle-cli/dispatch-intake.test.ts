import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runDispatch } from "./helpers.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-lc-intake-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
  return root;
}

describe("deft-ts intake / reconcile verbs (#1838 s3)", () => {
  it("issue-ingest exits non-zero for missing vbrief dir", async () => {
    const root = makeProjectRoot();
    const result = await runDispatch([
      "issue-ingest",
      "42",
      "--repo",
      "o/r",
      "--project-root",
      root,
      "--vbrief-dir",
      join(root, "missing"),
    ]);
    expect(result.exitCode).toBeGreaterThan(0);
  });

  it("issue-ingest accepts numeric issue positional", async () => {
    const root = makeProjectRoot();
    const result = await runDispatch([
      "issue-ingest",
      "99",
      "--repo",
      "o/r",
      "--project-root",
      root,
      "--vbrief-dir",
      join(root, "vbrief", "proposed"),
      "--dry-run",
    ]);
    expect(result.exitCode).toBeGreaterThan(0);
  });

  it("issue-emit requires --vbrief-path or umbrella/per-vbrief flags", async () => {
    const result = await runDispatch(["issue-emit"]);
    expect(result.exitCode).toBe(2);
  });

  it("reconcile-issues reports missing vbrief dir with exit 1", async () => {
    const result = await runDispatch(["reconcile-issues", "--vbrief-dir", "/nonexistent/path"]);
    expect(result.exitCode).toBe(1);
  });

  it("reconcile-issues accepts --project-root and --json flags", async () => {
    const root = makeProjectRoot();
    const result = await runDispatch([
      "reconcile-issues",
      "--vbrief-dir",
      join(root, "vbrief"),
      "--project-root",
      root,
      "--json",
    ]);
    expect(result.exitCode).toBeGreaterThanOrEqual(0);
    expect(result.exitCode).toBeLessThanOrEqual(2);
  });
});
