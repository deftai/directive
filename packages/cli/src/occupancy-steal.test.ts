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

  it("parses an explicit host session id in both CLI forms (#3611)", () => {
    const sessionId = "host:codex:v1:c2Vzc2lvbi1h";
    expect(parseArgs(["--session-id", sessionId])).toMatchObject({ sessionId });
    expect(parseArgs([`--session-id=${sessionId}`])).toMatchObject({ sessionId });
  });

  it("refuses steal without --confirm", () => {
    expect(parseArgs(["--occupant", "abc"]).error).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), "occ-steal-cli-"));
    temps.push(root);
    applyWorktreeOccupancy(root, { sessionId: "old" });
    // Subject is --confirm, not host detection: explicit --session-id keeps
    // ambient declared-host markers from refuse-minting (#4636).
    expect(run(["--project-root", root, "--occupant", "old", "--session-id=new-owner"])).toBe(2);
  });

  it("steals when confirm and occupant match", () => {
    const root = mkdtempSync(join(tmpdir(), "occ-steal-cli-"));
    temps.push(root);
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
