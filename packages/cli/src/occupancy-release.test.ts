import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorktreeOccupancy,
  canonicalHostSessionId,
  HOST_ENV_IDENTITY_VARIABLES,
  readOccupancy,
} from "@deftai/directive-core/session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./occupancy-release.js";

const sharedTemps: string[] = [];
let sharedRoot: string | null = null;
let previousSession: string | undefined;
// This CLI reads `process.env`, and the actor chain now ends at the ambient host
// owner, so the whole ambient surface is scrubbed per test (#3954 item 6). Left
// in place, a developer host's own variable makes these outcomes machine-local.
const previousHostEnv = new Map<string, string | undefined>();

function resetLeaseFiles(root: string): void {
  rmSync(join(root, ".deft", "occupancy.json"), { force: true });
  rmSync(join(root, ".deft", "occupancy.json.lock"), { force: true });
  rmSync(join(root, ".deft", "child-occupancy"), { recursive: true, force: true });
}

function fixtureRoot(): string {
  if (sharedRoot === null) {
    sharedRoot = mkdtempSync(join(tmpdir(), "occ-release-cli-"));
    sharedTemps.push(sharedRoot);
  }
  return sharedRoot;
}

beforeAll(() => {
  fixtureRoot();
});

beforeEach(() => {
  previousSession = process.env.DEFT_SESSION_ID;
  for (const variable of HOST_ENV_IDENTITY_VARIABLES) {
    previousHostEnv.set(variable, process.env[variable]);
    delete process.env[variable];
  }
});

afterEach(() => {
  if (sharedRoot !== null) resetLeaseFiles(sharedRoot);
  if (previousSession === undefined) {
    delete process.env.DEFT_SESSION_ID;
  } else {
    process.env.DEFT_SESSION_ID = previousSession;
  }
  for (const [variable, value] of previousHostEnv) {
    if (value === undefined) delete process.env[variable];
    else process.env[variable] = value;
  }
  previousHostEnv.clear();
});

afterAll(() => {
  for (const t of sharedTemps.splice(0)) rmSync(t, { recursive: true, force: true });
  sharedRoot = null;
});

describe("occupancy-release CLI (#3604)", () => {
  it("parses project-root", () => {
    expect(parseArgs(["--project-root", "/x"])).toEqual({ projectRoot: "/x" });
    expect(parseArgs(["--project-root=/x"])).toEqual({ projectRoot: "/x" });
  });

  it("parses and uses an explicit host session id ahead of every ambient source (#3611)", () => {
    const sessionId = "host:claude:v1:c2Vzc2lvbi1h";
    expect(parseArgs(["--project-root=/x", `--session-id=${sessionId}`])).toEqual({
      projectRoot: "/x",
      sessionId,
    });
    const root = fixtureRoot();
    applyWorktreeOccupancy(root, { sessionId });
    delete process.env.DEFT_SESSION_ID;
    // Both ambient sources name someone else, so the explicit id is observably
    // first in the chain rather than merely uncontested (#3954 item 6: the
    // pre-existing title claimed this and the body never set a host variable).
    process.env.GROK_SESSION_ID = "grok-session-a";

    expect(run(["--project-root", root, "--session-id", sessionId])).toBe(0);
    expect(readOccupancy(root)).toBeNull();
  });

  it("releases the occupant the running host published, with no explicit id (#3954)", () => {
    const root = fixtureRoot();
    process.env.GROK_SESSION_ID = "grok-session-a";
    delete process.env.DEFT_SESSION_ID;
    // Claim through the same chain the hook write gate presents on this host.
    applyWorktreeOccupancy(root, {});
    expect(readOccupancy(root)?.sessionId).toBe(canonicalHostSessionId("grok", "grok-session-a"));

    // The printed recovery is `occupancy:release`, run by the occupant. Before
    // the shared chain this resolved an empty caller and denied the owner its
    // own lease, so the only working form was to copy the id out of the deny.
    expect(run(["--project-root", root])).toBe(0);
    expect(readOccupancy(root)).toBeNull();
  });

  it("names the host owner when DEFT_SESSION_ID disagrees with it (#3954)", () => {
    const root = fixtureRoot();
    const hostOwner = canonicalHostSessionId("grok", "grok-session-a");
    applyWorktreeOccupancy(root, { sessionId: hostOwner });
    // The deployed shape: a stale inherited id from another host's session sits
    // ahead of the owner this host actually published.
    process.env.DEFT_SESSION_ID = "host:claude:v1:c2Vzc2lvbi1h";
    process.env.GROK_SESSION_ID = "grok-session-a";

    expect(run(["--project-root", root])).toBe(1);
    expect(readOccupancy(root)?.sessionId).toBe(hostOwner);
  });

  it("owner live release exits 0", () => {
    const root = fixtureRoot();
    applyWorktreeOccupancy(root, { sessionId: "owner" });
    process.env.DEFT_SESSION_ID = "owner";
    expect(run(["--project-root", root])).toBe(0);
  });

  it("non-owner live release exits 1", () => {
    const root = fixtureRoot();
    applyWorktreeOccupancy(root, { sessionId: "owner" });
    process.env.DEFT_SESSION_ID = "other";
    expect(run(["--project-root", root])).toBe(1);
  });

  it("requires --project-root value", () => {
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
    expect(run(["--project-root"])).toBe(2);
  });

  it("rejects a missing or blank explicit session identity (#3611)", () => {
    expect(parseArgs(["--session-id"]).error).toContain("expected one argument");
    expect(parseArgs(["--session-id", "--project-root"]).error).toContain("expected one argument");
    expect(parseArgs(["--session-id="]).error).toContain("non-empty");
    expect(parseArgs(["--session-id=--project-root"]).error).toContain("non-empty");
    expect(parseArgs(["--session-id", "   "]).error).toContain("non-empty");
  });

  it("does not let project-root swallow the explicit session ID", () => {
    expect(
      parseArgs(["--project-root", "--session-id=host:codex:v1:c2Vzc2lvbi1h"]).error,
    ).toContain("--project-root: expected one argument");
  });

  it("rejects unrecognized arguments", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
    expect(run(["--nope"])).toBe(2);
  });
});
