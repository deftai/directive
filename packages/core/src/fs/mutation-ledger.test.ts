import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeMutationLedger,
  formatMutationSummary,
  isAtomicWriteTemp,
  mutationSummaryJson,
  recordActiveMutation,
  runWithMutationLedger,
  snapshotMutationSummary,
  toLedgerPath,
} from "./mutation-ledger.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe("toLedgerPath / isAtomicWriteTemp (#3392)", () => {
  it("normalizes a nested path to posix relative", () => {
    const root = freshDir("ml-path-");
    expect(toLedgerPath(root, join(root, "a", "b.txt"))).toBe("a/b.txt");
  });

  it("returns empty for an out-of-root target", () => {
    const root = freshDir("ml-out-");
    const outside = freshDir("ml-out-side-");
    expect(toLedgerPath(root, join(outside, "x.txt"))).toBe("");
  });

  it("detects atomic replace temps", () => {
    expect(isAtomicWriteTemp("hooks.json.deft-12.tmp")).toBe(true);
    expect(isAtomicWriteTemp("hooks.json")).toBe(false);
  });
});

describe("MutationLedger (#3392)", () => {
  it("records wrote, stripped, and deleted; last kind per path wins in the summary", () => {
    const root = freshDir("ml-sum-");
    const summary = runWithMutationLedger(root, () => {
      recordActiveMutation("wrote", join(root, "a.txt"));
      recordActiveMutation("wrote", join(root, "b.txt"));
      recordActiveMutation("stripped", join(root, "b.txt"));
      recordActiveMutation("deleted", join(root, "c.txt"));
      return snapshotMutationSummary();
    });
    expect(summary.wrote).toEqual(["a.txt"]);
    expect(summary.stripped).toEqual(["b.txt"]);
    expect(summary.deleted).toEqual(["c.txt"]);
    expect(summary.chmod).toEqual([]);
    expect(summary.exec).toEqual([]);
    expect(summary.mutations).toEqual([
      { kind: "wrote", path: "a.txt" },
      { kind: "stripped", path: "b.txt" },
      { kind: "deleted", path: "c.txt" },
    ]);
  });

  it("formats Removed / wrote / stripped from the same summary as JSON", () => {
    const summary = {
      wrote: ["AGENTS.md"],
      stripped: [".claude/settings.json"],
      deleted: [".cursor/hooks/deft-cursor-hook-adapter.mjs"],
      chmod: [],
      exec: [],
      mutations: [
        { kind: "wrote" as const, path: "AGENTS.md" },
        { kind: "stripped" as const, path: ".claude/settings.json" },
        { kind: "deleted" as const, path: ".cursor/hooks/deft-cursor-hook-adapter.mjs" },
      ],
    };
    const text = formatMutationSummary(summary);
    const json = mutationSummaryJson(summary);
    expect(text).toBe(
      "Removed: .cursor/hooks/deft-cursor-hook-adapter.mjs\nwrote: AGENTS.md\nstripped: .claude/settings.json\n",
    );
    expect(json.wrote).toEqual(summary.wrote);
    expect(json.stripped).toEqual(summary.stripped);
    expect(json.deleted).toEqual(summary.deleted);
    expect(text).toContain(`Removed: ${json.deleted.join(", ")}`);
    expect(text).toContain(`wrote: ${json.wrote.join(", ")}`);
    expect(text).toContain(`stripped: ${json.stripped.join(", ")}`);
  });

  it("isolates nested and unbound ledgers", () => {
    expect(activeMutationLedger()).toBeUndefined();
    expect(snapshotMutationSummary().mutations).toEqual([]);
    const root = freshDir("ml-als-");
    runWithMutationLedger(root, () => {
      recordActiveMutation("wrote", "outer.txt");
      runWithMutationLedger(root, () => {
        recordActiveMutation("deleted", "inner.txt");
        expect(snapshotMutationSummary().deleted).toEqual(["inner.txt"]);
        expect(snapshotMutationSummary().wrote).toEqual([]);
      });
      expect(snapshotMutationSummary().wrote).toEqual(["outer.txt"]);
      expect(snapshotMutationSummary().deleted).toEqual([]);
    });
    expect(activeMutationLedger()).toBeUndefined();
  });
});
