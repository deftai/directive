import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultScratchDir } from "../orchestration/subagent-monitor.js";
import { ensureSubagentStatusDir } from "./subagent-status-dir.js";

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
