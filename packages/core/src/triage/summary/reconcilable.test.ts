import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { countReconcilable } from "./reconcilable.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-reconcile-test-"));
  temps.push(root);
  return root;
}

function writeVbrief(root: string, folder: string, name: string, uri: string): void {
  const dir = join(root, "vbrief", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.vbrief.json`),
    JSON.stringify({
      "x-vbrief": [{ type: "x-vbrief/github-issue", uri }],
    }),
    "utf8",
  );
}

describe("countReconcilable", () => {
  it("returns 0 when no vbrief refs exist", () => {
    expect(countReconcilable(mkRoot())).toBe(0);
  });

  it("counts proposed vbrief without audit entry", () => {
    const root = mkRoot();
    writeVbrief(root, "proposed", "story", "https://github.com/deftai/directive/issues/42");
    expect(
      countReconcilable(root, {
        restrictTo: [["deftai/directive", 42]],
      }),
    ).toBe(1);
  });

  it("excludes issues with existing audit entries", () => {
    const root = mkRoot();
    writeVbrief(root, "pending", "story", "https://github.com/deftai/directive/issues/99");
    const logDir = join(root, "vbrief", ".eval");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "candidates.jsonl"),
      `${JSON.stringify({
        repo: "deftai/directive",
        issue_number: 99,
        decision: "accept",
        timestamp: "2026-05-17T20:00:00Z",
      })}\n`,
      "utf8",
    );
    expect(countReconcilable(root)).toBe(0);
  });

  it("uses defaultRepo for bare-uri vbriefs", () => {
    const root = mkRoot();
    writeVbrief(root, "active", "bare", "https://github.com/issues/77");
    expect(
      countReconcilable(root, {
        defaultRepo: "deftai/directive",
        restrictTo: [["deftai/directive", 77]],
      }),
    ).toBe(1);
  });

  it("returns 0 when restrict_to excludes reconcilable keys", () => {
    const root = mkRoot();
    writeVbrief(root, "proposed", "story", "https://github.com/deftai/directive/issues/42");
    expect(
      countReconcilable(root, {
        restrictTo: [["deftai/other", 42]],
      }),
    ).toBe(0);
  });
});
