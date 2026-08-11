import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractIssueRef } from "./parse-uri.js";
import { reconcile } from "./reconcile.js";

function scopeVbrief(folder: string, slug: string, issue: number): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, `${slug}.xbrief.json`),
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
    scopeVbrief(join(root, "xbrief", "proposed"), "x", 12);
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".triage-cache", "candidates.jsonl"), "", "utf8");
    const auditPath = join(root, "xbrief", ".triage-cache", "candidates.jsonl");
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
    scopeVbrief(join(root, "xbrief", "proposed"), "d", 20);
    const result = reconcile(root, { repo: "deftai/directive", dryRun: true });
    expect(result.restored).toBe(1);
    expect(() =>
      readFileSync(join(root, "xbrief", ".triage-cache", "candidates.jsonl"), "utf8"),
    ).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses leaf symlink audit log diverting append into tracked file (#3288)", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-symlink-"));
    scopeVbrief(join(root, "xbrief", "proposed"), "s", 33);
    const victim = join(root, "package.json");
    writeFileSync(victim, '{"name":"keep"}\n', "utf8");
    const cacheDir = join(root, "xbrief", ".triage-cache");
    mkdirSync(cacheDir, { recursive: true });
    const auditPath = join(cacheDir, "candidates.jsonl");
    try {
      symlinkSync(victim, auditPath);
    } catch {
      rmSync(root, { recursive: true, force: true });
      return;
    }
    const result = reconcile(root, { repo: "deftai/directive", auditLogPath: auditPath });
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeTruthy();
    expect(result.error ?? "").toMatch(/ContainedWriteError|symlink|refused/i);
    expect(readFileSync(victim, "utf8")).toBe('{"name":"keep"}\n');
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses leaf symlink when audit path is outside project root (#3288)", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-outroot-"));
    const outside = mkdtempSync(join(tmpdir(), "reconcile-audit-out-"));
    scopeVbrief(join(root, "xbrief", "proposed"), "o", 44);
    const victim = join(outside, "tracked.txt");
    writeFileSync(victim, "keep-out\n", "utf8");
    const auditPath = join(outside, "candidates.jsonl");
    try {
      symlinkSync(victim, auditPath);
    } catch {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    const result = reconcile(root, { repo: "deftai/directive", auditLogPath: auditPath });
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeTruthy();
    expect(readFileSync(victim, "utf8")).toBe("keep-out\n");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("appends when audit path is outside project root via parent containment (#3288)", () => {
    const root = mkdtempSync(join(tmpdir(), "reconcile-outwrite-"));
    const outside = mkdtempSync(join(tmpdir(), "reconcile-audit-write-"));
    scopeVbrief(join(root, "xbrief", "proposed"), "w", 55);
    const auditPath = join(outside, "candidates.jsonl");
    const result = reconcile(root, { repo: "deftai/directive", auditLogPath: auditPath });
    expect(result.exitCode).toBe(0);
    expect(result.restored).toBe(1);
    expect(readFileSync(auditPath, "utf8")).toMatch(/issue_number.:55/);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
