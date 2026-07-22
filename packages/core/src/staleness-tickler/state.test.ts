import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStalenessTicklerState, saveStalenessTicklerState } from "./state.js";

const itSymlink = it.skipIf(process.platform === "win32");

describe("staleness tickler state containment (#2710)", () => {
  let root: string;
  const temps: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deft-staleness-state-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "s.xbrief.json"),
      JSON.stringify({ plan: { id: "s", status: "running", items: [] } }),
      "utf8",
    );
  });

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshEscape(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  }

  itSymlink("save refuses without out-of-tree write when .triage-cache is a symlink", () => {
    const escapeDir = freshEscape("deft-staleness-escape-");
    const victim = join(escapeDir, "staleness-tickler-state.json");
    writeFileSync(victim, "untouched\n", "utf8");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    symlinkSync(victim, join(root, "xbrief", ".triage-cache"));

    saveStalenessTicklerState(root, { lastPromptAt: "2026-01-01T00:00:00.000Z" });

    expect(readFileSync(victim, "utf8")).toBe("untouched\n");
    expect(existsSync(join(root, "xbrief", ".triage-cache", "staleness-tickler-state.json"))).toBe(
      false,
    );
  });

  itSymlink("load returns empty state when .triage-cache is a symlink escape", () => {
    const escapeDir = freshEscape("deft-staleness-load-escape-");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    symlinkSync(escapeDir, join(root, "xbrief", ".triage-cache"), "dir");

    expect(loadStalenessTicklerState(root)).toEqual({});
  });
});
