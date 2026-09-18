import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWorktreeOccupancy } from "@deftai/directive-core/session";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseArgs, run } from "./occupancy-steal.js";

const sharedTemps: string[] = [];
let sharedRoot: string | null = null;

function resetLeaseFiles(root: string): void {
  rmSync(join(root, ".deft", "occupancy.json"), { force: true });
  rmSync(join(root, ".deft", "occupancy.json.lock"), { force: true });
  rmSync(join(root, ".deft", "child-occupancy"), { recursive: true, force: true });
}

function tempRoot(): string {
  if (sharedRoot === null) {
    sharedRoot = mkdtempSync(join(tmpdir(), "occ-steal-cli-"));
    sharedTemps.push(sharedRoot);
  }
  return sharedRoot;
}

beforeAll(() => {
  tempRoot();
});

afterEach(() => {
  if (sharedRoot !== null) resetLeaseFiles(sharedRoot);
});

afterAll(() => {
  for (const t of sharedTemps.splice(0)) rmSync(t, { recursive: true, force: true });
  sharedRoot = null;
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

  it("parses an explicit host session id in both CLI forms (#3611)", () => {
    const sessionId = "host:codex:v1:c2Vzc2lvbi1h";
    expect(parseArgs(["--session-id", sessionId])).toMatchObject({ sessionId });
    expect(parseArgs([`--session-id=${sessionId}`])).toMatchObject({ sessionId });
  });

  it("refuses steal without --confirm", () => {
    expect(parseArgs(["--occupant", "abc"]).error).toBeUndefined();
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: "old" });
    // Subject is --confirm, not host detection: explicit --session-id keeps
    // ambient declared-host markers from refuse-minting (#4636).
    expect(run(["--project-root", root, "--occupant", "old", "--session-id=new-owner"])).toBe(2);
  });

  it("steals when confirm and occupant match", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: "old" });
    expect(
      run([
        "--project-root",
        root,
        "--confirm",
        "--occupant",
        "old",
        "--session-id=host:codex:v1:c2Vzc2lvbi1h",
      ]),
    ).toBe(0);
  });

  it("rejects unrecognized arguments", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
    expect(run(["--nope"])).toBe(2);
  });

  it("rejects a missing or blank explicit session identity (#3611)", () => {
    expect(parseArgs(["--session-id"]).error).toContain("expected one argument");
    expect(parseArgs(["--session-id", "--confirm"]).error).toContain("expected one argument");
    expect(parseArgs(["--session-id="]).error).toContain("non-empty");
    expect(parseArgs(["--session-id=--confirm"]).error).toContain("non-empty");
    expect(parseArgs(["--session-id", "   "]).error).toContain("non-empty");
  });

  it("does not let occupant or project-root swallow the explicit session ID", () => {
    const sessionId = "--session-id=host:codex:v1:c2Vzc2lvbi1h";
    expect(parseArgs(["--occupant", sessionId]).error).toContain(
      "--occupant: expected one argument",
    );
    expect(parseArgs(["--project-root", sessionId]).error).toContain(
      "--project-root: expected one argument",
    );
  });
});
