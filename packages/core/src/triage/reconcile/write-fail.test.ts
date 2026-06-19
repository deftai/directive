import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractIssueRef } from "./parse-uri.js";
import { reconcile } from "./reconcile.js";

function scopeVbrief(folder: string, slug: string, issue: number): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${slug}.vbrief.json`),
    JSON.stringify({
      plan: {
        references: [
          {
            type: "x-vbrief/github-issue",
            uri: `https://github.com/deftai/directive/issues/${issue}`,
          },
        ],
      },
    }),
    "utf8",
  );
}

describe("reconcile write failures", () => {
  it("returns exit 1 when audit append fails", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-fail-"));
    scopeVbrief(join(root, "vbrief", "proposed"), "x", 12);
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(join(root, "vbrief", ".eval", "candidates.jsonl"), "", "utf8");
    const auditPath = join(root, "vbrief", ".eval", "candidates.jsonl");
    chmodSync(auditPath, 0o444);
    const result = reconcile(root, { repo: "deftai/directive", auditLogPath: auditPath });
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeTruthy();
    chmodSync(auditPath, 0o644);
    rmSync(root, { recursive: true, force: true });
  });

  it("extractIssueRef skips bad refs", () => {
    expect(extractIssueRef({ plan: { references: [{ type: "other", uri: "x" }] } })).toEqual([
      null,
      null,
    ]);
    expect(extractIssueRef({})).toEqual([null, null]);
  });

  it("dry-run does not write audit log", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-dry-"));
    scopeVbrief(join(root, "vbrief", "proposed"), "d", 20);
    const result = reconcile(root, { repo: "deftai/directive", dryRun: true });
    expect(result.restored).toBe(1);
    expect(() => readFileSync(join(root, "vbrief", ".eval", "candidates.jsonl"), "utf8")).toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});
