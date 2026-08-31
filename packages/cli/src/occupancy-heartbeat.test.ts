import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorktreeOccupancy,
  canonicalHostSessionId,
  HOST_ENV_IDENTITY_VARIABLES,
  readOccupancy,
} from "@deftai/directive-core/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs, run } from "./occupancy-heartbeat.js";

const temps: string[] = [];
let previousSession: string | undefined;
// This CLI reads `process.env`, and the actor chain now ends at the ambient host
// owner, so the whole ambient surface is scrubbed per test (#3954 item 6). Left
// in place, a developer host's own variable makes these outcomes machine-local.
const previousHostEnv = new Map<string, string | undefined>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "occ-heartbeat-cli-"));
  temps.push(root);
  return root;
}

beforeEach(() => {
  previousSession = process.env.DEFT_SESSION_ID;
  for (const variable of HOST_ENV_IDENTITY_VARIABLES) {
    previousHostEnv.set(variable, process.env[variable]);
    delete process.env[variable];
  }
});

afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
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

describe("occupancy-heartbeat CLI (#3599)", () => {
  it("parses project-root and an explicit host session id", () => {
    const sessionId = "host:cursor:v1:c2Vzc2lvbi1h";
    expect(parseArgs(["--project-root", "/x"])).toEqual({ projectRoot: "/x" });
    expect(parseArgs([`--project-root=/x`, `--session-id=${sessionId}`])).toEqual({
      projectRoot: "/x",
      sessionId,
    });
  });

  it("refreshes the owner's own live lease", () => {
    const root = tempRoot();
    // Whole seconds: the lease serializes ISO timestamps at second precision.
    const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 10 * 60 * 1000);
    applyWorktreeOccupancy(root, { sessionId: "owner", now: claimedAt });
    delete process.env.DEFT_SESSION_ID;

    expect(run(["--project-root", root, "--session-id", "owner"])).toBe(0);
    const record = readOccupancy(root);
    expect(record?.sessionId).toBe("owner");
    expect(record?.heartbeatAt.getTime()).toBeGreaterThan(claimedAt.getTime());
    expect(record?.claimedAt.getTime()).toBe(claimedAt.getTime());
    // A refresh is not a write: `occupancy:steal` must still report no write.
    expect(record?.lastWriteAt).toBeNull();
  });

  it("refuses to claim when there is no live lease", () => {
    const root = tempRoot();
    process.env.DEFT_SESSION_ID = "nobody";
    expect(run(["--project-root", root])).toBe(1);
    expect(readOccupancy(root)).toBeNull();
  });

  it("refuses to refresh another session's lease", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: "owner" });
    process.env.DEFT_SESSION_ID = "other";
    expect(run(["--project-root", root])).toBe(1);
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("exits 2 without an owner id rather than minting one", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: "owner" });
    delete process.env.DEFT_SESSION_ID;
    expect(run(["--project-root", root])).toBe(2);
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("refreshes under the owner the running host published (#3954)", () => {
    const root = tempRoot();
    process.env.GROK_SESSION_ID = "grok-session-a";
    const owner = canonicalHostSessionId("grok", "grok-session-a");
    const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 10 * 60 * 1000);
    applyWorktreeOccupancy(root, { sessionId: owner, now: claimedAt });
    delete process.env.DEFT_SESSION_ID;

    // No `--session-id`: the claim and the refresh resolve the same host owner,
    // so the occupant can run the command the deny text names.
    expect(run(["--project-root", root])).toBe(0);
    expect(readOccupancy(root)?.heartbeatAt.getTime()).toBeGreaterThan(claimedAt.getTime());
  });

  it("rejects malformed arguments", () => {
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
    expect(parseArgs(["--session-id="]).error).toContain("non-empty");
    expect(parseArgs(["--nope"]).error).toContain("unrecognized");
    expect(run(["--nope"])).toBe(2);
  });
});
