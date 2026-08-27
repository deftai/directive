import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultScratchDir } from "../orchestration/subagent-monitor.js";
import { ensureSubagentStatusDir, looksLikeWorktreeDir } from "./subagent-status-dir.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("ensureSubagentStatusDir (#3730)", () => {
  it("creates .deft-scratch/subagent-status under an existing worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-mkdir-"));
    temps.push(root);
    mkdirSync(join(root, "wt"), { recursive: true });
    const wt = join(root, "wt");
    const expected = defaultScratchDir(wt);
    expect(ensureSubagentStatusDir(wt)).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it("returns null when the worktree path does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-missing-"));
    temps.push(root);
    expect(ensureSubagentStatusDir(join(root, "no-such-wt"))).toBeNull();
    expect(existsSync(join(root, "no-such-wt"))).toBe(false);
  });

  it("is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-idemp-"));
    temps.push(root);
    mkdirSync(join(root, "wt"), { recursive: true });
    const wt = join(root, "wt");
    expect(ensureSubagentStatusDir(wt)).toBe(ensureSubagentStatusDir(wt));
  });
});

describe("looksLikeWorktreeDir (#3730)", () => {
  it("accepts a directory carrying a .git entry", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-wt-"));
    temps.push(root);
    const wt = join(root, "b3730");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /repo/.git/worktrees/b3730\n", "utf8");
    expect(looksLikeWorktreeDir(wt)).toBe(true);
  });

  it("rejects a plain source directory a branch name could collide with", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-collide-"));
    temps.push(root);
    const docs = join(root, "docs");
    mkdirSync(docs, { recursive: true });
    expect(looksLikeWorktreeDir(docs)).toBe(false);
  });

  it("rejects a missing path and an empty string", () => {
    const root = mkdtempSync(join(tmpdir(), "hb-none-"));
    temps.push(root);
    expect(looksLikeWorktreeDir(join(root, "absent"))).toBe(false);
    expect(looksLikeWorktreeDir("   ")).toBe(false);
  });
});
