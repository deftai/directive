import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorktreeOccupancy } from "@deftai/directive-core/session";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./occupancy-steal.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

describe("occupancy-steal CLI (#3433)", () => {
  it("parses confirm, occupant, and project-root", () => {
    expect(parseArgs(["--confirm", "--occupant", "abc", "--project-root", "/x"])).toEqual({
      projectRoot: "/x",
      confirm: true,
      occupant: "abc",
    });
    expect(parseArgs(["--occupant=abc", "--project-root=/x"])).toEqual({
      projectRoot: "/x",
      confirm: false,
      occupant: "abc",
    });
  });

  it("refuses steal without --confirm", () => {
    expect(parseArgs(["--occupant", "abc"]).error).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), "occ-steal-cli-"));
    temps.push(root);
    applyWorktreeOccupancy(root, { sessionId: "old" });
    expect(run(["--project-root", root, "--occupant", "old"])).toBe(2);
  });

  it("steals when confirm and occupant match", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-steal-cli-"));
    temps.push(root);
    applyWorktreeOccupancy(root, { sessionId: "old" });
    expect(run(["--project-root", root, "--confirm", "--occupant", "old"])).toBe(0);
  });

  it("rejects unrecognized arguments", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
    expect(run(["--nope"])).toBe(2);
  });
});
