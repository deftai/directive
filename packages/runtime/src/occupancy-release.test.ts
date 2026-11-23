import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordProductMutationCompletion } from "@deftai/directive-core/check";
import { CONSUMER_HEADER_PLACEHOLDER_ONELINER } from "@deftai/directive-core/platform";
import {
  applyWorktreeOccupancy,
  canonicalHostSessionId,
  HOST_ENV_IDENTITY_VARIABLES,
  readOccupancy,
  resolveOccupancyLeaseRoot,
} from "@deftai/directive-core/session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VERB_ALIASES } from "./dispatch.js";
import {
  ABANDONED_OCCUPANCY_LEASE_RECOVERY,
  formatOccupancyReleaseHelp,
  parseArgs,
  run,
} from "./occupancy-release.js";

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

// #6679: a bare release uses the Grok owner only when Grok is the only declared
// host, so the host markers a developer's own agent sets are scrubbed too.
const DECLARED_HOST_MARKERS = [
  "GROK_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_SESSION_ID",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "OPENAI_CODEX",
] as const;

function captureStderr(fn: () => number): { code: number; stderr: string } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    return { code: fn(), stderr: chunks.join("") };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  previousSession = process.env.DEFT_SESSION_ID;
  for (const variable of [...HOST_ENV_IDENTITY_VARIABLES, ...DECLARED_HOST_MARKERS]) {
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

  it("a bare release ignores an inherited DEFT_SESSION_ID and acts as the Grok owner (#6679)", () => {
    const root = fixtureRoot();
    const hostOwner = canonicalHostSessionId("grok", "grok-session-a");
    applyWorktreeOccupancy(root, { sessionId: hostOwner });
    // An inherited id from another host's session no longer sits ahead of the
    // owner this host published: a bare release does not read DEFT_SESSION_ID.
    process.env.DEFT_SESSION_ID = "host:claude:v1:c2Vzc2lvbi1h";
    process.env.GROK_SESSION_ID = "grok-session-a";

    expect(run(["--project-root", root])).toBe(0);
    expect(readOccupancy(root)).toBeNull();
  });

  it("bare session:end runs this module and releases the Grok-only owner (#6679)", () => {
    expect(VERB_ALIASES["session:end"]).toBe("occupancy-release");
    expect(VERB_ALIASES["occupancy:release"]).toBe("occupancy-release");
    const root = fixtureRoot();
    process.env.GROK_SESSION_ID = "grok-session-a";
    applyWorktreeOccupancy(root, {});
    expect(run(["--project-root", root])).toBe(0);
    expect(readOccupancy(root)).toBeNull();
  });

  it("refuses a bare Grok release when a Claude Code marker is also declared (#6679)", () => {
    const root = fixtureRoot();
    const hostOwner = canonicalHostSessionId("grok", "grok-session-a");
    process.env.GROK_SESSION_ID = "grok-session-a";
    applyWorktreeOccupancy(root, {});
    process.env.CLAUDECODE = "1";

    const denied = captureStderr(() => run(["--project-root", root]));
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("(claude, grok)");
    expect(readOccupancy(root)?.sessionId).toBe(hostOwner);

    expect(run(["--project-root", root, `--session-id=${hostOwner}`])).toBe(0);
    expect(readOccupancy(root)).toBeNull();
  });

  it("owner live release with its own --session-id exits 0", () => {
    const root = fixtureRoot();
    applyWorktreeOccupancy(root, { sessionId: "owner" });
    expect(run(["--project-root", root, "--session-id=owner"])).toBe(0);
    expect(readOccupancy(root)).toBeNull();
  });

  it("refuses a bare release that only DEFT_SESSION_ID identifies (#6679)", () => {
    const root = fixtureRoot();
    applyWorktreeOccupancy(root, { sessionId: "owner" });
    process.env.DEFT_SESSION_ID = "owner";

    const denied = captureStderr(() => run(["--project-root", root]));
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("A bare release does not use DEFT_SESSION_ID");
    expect(denied.stderr).toContain("deft occupancy:release --session-id=<your-session-id>");
    expect(readOccupancy(root)?.sessionId).toBe("owner");
  });

  it("non-owner live release exits 1", () => {
    const root = fixtureRoot();
    applyWorktreeOccupancy(root, { sessionId: "owner" });
    expect(run(["--project-root", root, "--session-id=other"])).toBe(1);
    expect(readOccupancy(root)?.sessionId).toBe("owner");
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

  it("names owner-only abandoned-lease recovery on --help (#4667 / #6679)", () => {
    expect(parseArgs(["--help"])).toEqual({ projectRoot: ".", help: true });
    expect(parseArgs(["-h"]).help).toBe(true);
    const help = formatOccupancyReleaseHelp();
    for (const text of [help, ABANDONED_OCCUPANCY_LEASE_RECOVERY]) {
      expect(text).not.toContain("<id from .deft/occupancy.json>");
      expect(text).not.toContain("occupancy:steal");
      expect(text).toContain("only the session that owns a lease releases it");
      expect(text).toContain("blocks no write");
      expect(text).toContain("subject to the existing claim rules");
      expect(text).toContain("Never copy a lease's session_id into a release command");
    }
    expect(help).toContain("A lease owned by another session is refused");
    expect(help).toContain("presented");
    expect(help).toContain("TTL");
    expect(help).toContain("host:none");
    expect(run(["--help"])).toBe(0);
  });

  it("locks README cold-start abandoned-lease recovery (#4667 / #6679)", () => {
    const readmePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "README.md");
    const readme = readFileSync(readmePath, "utf8");
    const line = readme.split("\n").find((l) => l.includes("Abandoned occupancy lease")) ?? "";
    expect(line).toContain("Only the session that owns a lease releases it");
    expect(line).toContain("blocks no write");
    expect(line).toContain("subject to the existing claim rules");
    expect(line).not.toContain("<id from .deft/occupancy.json>");
    expect(line).not.toContain("occupancy:steal");
  });

  it("preserves supplied project-root for consumer header check (#5544 P1)", () => {
    // Dedicated git tree: nested consumer has placeholder + Prefer-A marker;
    // git toplevel has neither. Remapping --project-root to the lease root
    // before releaseOccupancy would skip the header gate.
    const root = mkdtempSync(join(tmpdir(), "occ-release-subdir-"));
    sharedTemps.push(root);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const leaseRoot = resolveOccupancyLeaseRoot(nested);
    expect(leaseRoot).toBe(resolve(root));
    expect(leaseRoot).not.toBe(resolve(nested));
    applyWorktreeOccupancy(nested, { sessionId: "owner-subdir" });
    writeFileSync(
      join(nested, "AGENTS.md"),
      `# App\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    expect(recordProductMutationCompletion(nested).ok).toBe(true);
    // The owner presents its own id, so the refusal is the header gate (#6679).
    const denied = captureStderr(() =>
      run(["--project-root", nested, "--session-id=owner-subdir"]),
    );
    expect(denied.code).toBe(1);
    expect(denied.stderr).not.toContain("occupancy:release refused");
    expect(readOccupancy(leaseRoot)?.sessionId).toBe("owner-subdir");
  });
});
