import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveCanonicalVerb } from "../dispatch.js";
import { runDispatch } from "./helpers.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function writePendingVbrief(root: string, status = "pending"): string {
  const dir = join(root, "vbrief", "pending");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "2026-06-21-story.vbrief.json");
  writeFileSync(
    path,
    JSON.stringify({
      vBRIEFInfo: { version: "0.6", updated: "2026-06-01T00:00:00Z" },
      plan: { title: "Story", status, items: [] },
    }),
    "utf8",
  );
  return path;
}

describe("deft-ts vbrief lifecycle verbs (#1838 s3)", () => {
  it("resolves task-style vbrief aliases to canonical verbs", () => {
    expect(resolveCanonicalVerb("vbrief:preflight")).toBe("vbrief-preflight");
    expect(resolveCanonicalVerb("vbrief:validate")).toBe("vbrief-validate");
    expect(resolveCanonicalVerb("vbrief:activate")).toBe("vbrief-activate");
  });

  it("vbrief-preflight rejects missing --vbrief-path with exit 2", async () => {
    const result = await runDispatch(["vbrief-preflight"]);
    expect(result.exitCode).toBe(2);
  });

  it("vbrief-preflight alias vbrief:preflight matches canonical exit code", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-lc-pf-"));
    temps.push(root);
    const path = writePendingVbrief(root);
    const canonical = await runDispatch(["vbrief-preflight", "--vbrief-path", path]);
    const alias = await runDispatch(["vbrief:preflight", "--vbrief-path", path]);
    expect(alias.exitCode).toBe(canonical.exitCode);
    expect(canonical.exitCode).toBe(1);
  });

  it("vbrief-activate requires a positional vbrief path", async () => {
    const result = await runDispatch(["vbrief-activate"]);
    expect(result.exitCode).toBe(2);
  });

  it("vbrief-activate promotes pending vBRIEF via dispatcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-lc-act-"));
    temps.push(root);
    const src = writePendingVbrief(root);
    const result = await runDispatch(["vbrief-activate", src]);
    expect(result.exitCode).toBe(0);
    const dest = join(root, "vbrief", "active", "2026-06-21-story.vbrief.json");
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(src)).toBe(false);
  });

  it("vbrief-validate --help exits 0 through dispatcher", async () => {
    const result = await runDispatch(["vbrief-validate", "--help"]);
    expect(result.exitCode).toBe(0);
  });

  it("vbrief-validate skips missing vbrief dir with exit 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "deft-lc-val-"));
    temps.push(root);
    const result = await runDispatch([
      "vbrief-validate",
      "--vbrief-dir",
      join(root, "missing-vbrief"),
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("vbrief-validation rejects unknown flags with exit 2", async () => {
    const result = await runDispatch(["vbrief-validation", "--not-a-flag"]);
    expect(result.exitCode).toBe(2);
  });

  it("vbrief-reconcile requires --project-root", async () => {
    const result = await runDispatch(["vbrief-reconcile"]);
    expect(result.exitCode).toBe(2);
  });
});
