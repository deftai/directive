import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorktreeOccupancy } from "@deftai/directive-core/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./occupancy-release.js";

const temps: string[] = [];
let previousSession: string | undefined;

beforeEach(() => {
  previousSession = process.env.DEFT_SESSION_ID;
});

afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
  if (previousSession === undefined) {
    delete process.env.DEFT_SESSION_ID;
  } else {
    process.env.DEFT_SESSION_ID = previousSession;
  }
});

describe("occupancy-release CLI (#3604)", () => {
  it("parses project-root", () => {
    expect(parseArgs(["--project-root", "/x"])).toEqual({ projectRoot: "/x" });
    expect(parseArgs(["--project-root=/x"])).toEqual({ projectRoot: "/x" });
  });

  it("owner live release exits 0", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-release-cli-"));
    temps.push(root);
    applyWorktreeOccupancy(root, { sessionId: "owner" });
    process.env.DEFT_SESSION_ID = "owner";
    expect(run(["--project-root", root])).toBe(0);
  });

  it("non-owner live release exits 1", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-release-cli-"));
    temps.push(root);
    applyWorktreeOccupancy(root, { sessionId: "owner" });
    process.env.DEFT_SESSION_ID = "other";
    expect(run(["--project-root", root])).toBe(1);
  });

  it("requires --project-root value", () => {
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
    expect(run(["--project-root"])).toBe(2);
  });

  it("rejects unrecognized arguments", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
    expect(run(["--nope"])).toBe(2);
  });
});
