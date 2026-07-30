import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContainedWriteError } from "../fs/contained-write.js";
import {
  append,
  canonicalLogPath,
  findByPath,
  latestForPath,
  newDecisionId,
  readAll,
  ScopeAuditLogError,
} from "./audit-log.js";

function validDemoteEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_id: newDecisionId(),
    timestamp: "2026-05-17T21:05:00Z",
    action: "demote",
    vbrief_path: "xbrief/proposed/foo.xbrief.json",
    from_status: "pending",
    to_status: "proposed",
    actor: "operator",
    demote_meta: {
      was_promoted: true,
      original_promotion_decision_id: null,
      days_in_pending: 3,
      demote_reason: "operator-requested",
      demoted_from: "pending",
    },
    ...overrides,
  };
}

describe("audit-log", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends and reads demote entries", () => {
    root = mkdtempSync(join(tmpdir(), "audit-"));
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    const logPath = canonicalLogPath(root);
    const entry = validDemoteEntry();
    append(entry, logPath);
    const rows = readAll(logPath);
    expect(rows).toHaveLength(1);
    expect(findByPath(String(entry.vbrief_path), logPath)).toHaveLength(1);
    expect(latestForPath(String(entry.vbrief_path), "demote", logPath)?.decision_id).toBe(
      entry.decision_id,
    );
  });

  it("rejects non-object entries and demote field types", () => {
    root = mkdtempSync(join(tmpdir(), "audit-"));
    const logPath = canonicalLogPath(root);
    expect(() => append(null as unknown as Record<string, unknown>, logPath)).toThrow(
      ScopeAuditLogError,
    );
    expect(() => append([] as unknown as Record<string, unknown>, logPath)).toThrow(
      ScopeAuditLogError,
    );
    const base = validDemoteEntry();
    expect(() =>
      append(
        {
          ...base,
          demote_meta: {
            was_promoted: true,
            original_promotion_decision_id: newDecisionId(),
            days_in_pending: 1.5,
            demote_reason: "x",
            demoted_from: "pending",
          },
        },
        logPath,
      ),
    ).toThrow(ScopeAuditLogError);
  });

  it("returns empty list for missing log", () => {
    root = mkdtempSync(join(tmpdir(), "audit-"));
    expect(readAll(canonicalLogPath(root))).toEqual([]);
  });

  it("skips malformed lines", () => {
    root = mkdtempSync(join(tmpdir(), "audit-"));
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    const logPath = canonicalLogPath(root);
    writeFileSync(logPath, "not-json\n", "utf8");
    append(validDemoteEntry(), logPath);
    expect(readAll(logPath)).toHaveLength(1);
  });

  it("refuses symlink leaf on append (#2980 wave B)", () => {
    root = mkdtempSync(join(tmpdir(), "audit-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "audit-out-"));
    const victim = join(outside, "victim.jsonl");
    writeFileSync(victim, "keep\n", "utf8");
    const cacheDir = join(root, "xbrief", ".triage-cache");
    mkdirSync(cacheDir, { recursive: true });
    const logPath = canonicalLogPath(root);
    try {
      symlinkSync(victim, logPath);
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    expect(() => append(validDemoteEntry(), logPath)).toThrow(ContainedWriteError);
    expect(readAll(logPath)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });
});
