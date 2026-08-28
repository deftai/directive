import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorktreeOccupancy,
  evaluateOccupancyWriteGate,
  readOccupancy,
} from "@deftai/directive-core/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./occupancy-grant.js";

const temps: string[] = [];
let previousSession: string | undefined;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "occ-grant-cli-"));
  temps.push(root);
  return root;
}

function leased(sessionId = "owner"): string {
  const root = tempRoot();
  applyWorktreeOccupancy(root, { sessionId });
  return root;
}

beforeEach(() => {
  previousSession = process.env.DEFT_SESSION_ID;
  delete process.env.DEFT_SESSION_ID;
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

describe("occupancy-grant CLI (#3755)", () => {
  it("parses the grant surface in both spaced and inline spellings", () => {
    expect(parseArgs(["--project-root", "/x"])).toEqual({ projectRoot: "/x", revoke: false });
    expect(
      parseArgs([
        "--project-root=/x",
        "--session-id=owner",
        "--child-session-id=child",
        "--role=leaf-implementation",
        "--worktree=/x/tree",
        "--ttl-minutes=90",
        "--host=agent-7",
        "--address=cohort-a",
        "--join-protocol=heartbeat-file",
        "--revoke",
      ]),
    ).toEqual({
      projectRoot: "/x",
      sessionId: "owner",
      childSessionId: "child",
      role: "leaf-implementation",
      worktree: "/x/tree",
      ttlMinutes: 90,
      host: "agent-7",
      address: "cohort-a",
      joinProtocol: "heartbeat-file",
      revoke: true,
    });
  });

  it("admits a dispatched child and then refuses its administration", () => {
    const root = leased();

    expect(
      run([
        "--project-root",
        root,
        "--session-id",
        "owner",
        "--child-session-id",
        "child",
        "--role",
        "review-monitor",
        "--ttl-minutes",
        "30",
      ]),
    ).toBe(0);

    const grant = readOccupancy(root)?.grants[0];
    expect(grant?.ownerSessionId).toBe("owner");
    expect(grant?.childSessionId).toBe("child");
    expect(grant?.role).toBe("review-monitor");
    expect(evaluateOccupancyWriteGate(root, { sessionId: "child" }).admitted).toBe("member");
    // The child holds a write grant, so the same verb run under its id is refused.
    expect(
      run([
        "--project-root",
        root,
        "--session-id",
        "child",
        "--child-session-id",
        "grandchild",
        "--role",
        "leaf-implementation",
      ]),
    ).toBe(1);
  });

  it("revokes a grant it previously issued", () => {
    const root = leased();
    const issue = ["--project-root", root, "--child-session-id", "child"];
    process.env.DEFT_SESSION_ID = "owner";
    expect(run([...issue, "--role", "leaf-implementation"])).toBe(0);

    expect(run([...issue, "--revoke"])).toBe(0);

    expect(readOccupancy(root)?.grants).toHaveLength(0);
    expect(evaluateOccupancyWriteGate(root, { sessionId: "child" }).allow).toBe(false);
  });

  it("rejects malformed arguments", () => {
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
    expect(parseArgs(["--child-session-id="]).error).toContain("non-empty");
    expect(parseArgs(["--ttl-minutes", "0"]).error).toContain("positive number");
    expect(parseArgs(["--join-protocol", "telepathy"]).error).toContain("expected one of");
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
    expect(run(["--nope"])).toBe(2);
  });

  it("exits 2 without an owner id rather than guessing one", () => {
    const root = leased();
    expect(
      run(["--project-root", root, "--child-session-id", "child", "--role", "leaf-implementation"]),
    ).toBe(2);
    expect(readOccupancy(root)?.grants).toHaveLength(0);
  });
});
