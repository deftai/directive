/**
 * #6274 Prefer-A Bound: a Claude Code SessionEnd hook releases the occupancy
 * lease only when the ending session owns it, and touches no other file.
 *
 * Fixture matrix (Bound limb 4): own live, own expired, foreign live, foreign
 * expired, no lease with a foreign applying-host record, own lease with a
 * foreign applying-host record, own lease with failing header enforcement,
 * duplicate end, delayed end, pin mismatch, launch-root mismatch and a thrown
 * release.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runSessionEndHook, SESSION_END_HOOK_HOSTS } from "../hooks/dispatcher.js";
import type { CheapInSyncResult } from "../install-health/types.js";
import { CONSUMER_HEADER_PLACEHOLDER_ONELINER } from "../platform/agents-consumer-header.js";
import { canonicalHostSessionId } from "./host-session-owner.js";
import {
  applyingHostPath,
  applyWorktreeOccupancy,
  occupancyPath,
  publishApplyingHost,
  readOccupancy,
  releaseOccupancy,
  releaseOwnedOccupancyOnSessionEnd,
} from "./occupancy.js";

const RAW_S = "11111111-aaaa-4bbb-8ccc-000000000001";
const RAW_T = "22222222-aaaa-4bbb-8ccc-000000000002";
const OWNER_S = canonicalHostSessionId("claude", RAW_S);
const OWNER_T = canonicalHostSessionId("claude", RAW_T);
const LONG_AGO = new Date("2020-01-01T00:00:00Z");

const okCheap = (): CheapInSyncResult => ({
  ok: true,
  pinVersion: null,
  installedVersion: null,
  identityMatch: true,
  readinessValid: true,
  failClosed: false,
  allowSetup: false,
  recoveryGuidance: null,
});

const pinMismatchCheap = (): CheapInSyncResult => ({
  ok: false,
  pinVersion: "9.9.9",
  installedVersion: "1.0.0",
  identityMatch: false,
  readinessValid: false,
  failClosed: true,
  allowSetup: false,
  recoveryGuidance: "reinstall",
});

const temps: string[] = [];
let shared: string | null = null;

function tempRoot(): string {
  if (shared === null) {
    shared = mkdtempSync(join(tmpdir(), "occupancy-session-end-"));
    temps.push(shared);
    execFileSync("git", ["init", "-q"], { cwd: shared });
  }
  mkdirSync(join(shared, ".deft"), { recursive: true });
  return shared;
}

afterEach(() => {
  if (shared === null) return;
  rmSync(join(shared, ".deft"), { recursive: true, force: true });
  rmSync(join(shared, "AGENTS.md"), { force: true });
});

afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  shared = null;
});

/** Every file under root (except .git) with its bytes, for byte-identical checks. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(root, full).replace(/\\/g, "/"), readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return out;
}

function payloadFor(raw: string | null, root: string): Record<string, unknown> {
  return {
    hook_event_name: "SessionEnd",
    reason: "clear",
    cwd: root,
    ...(raw === null ? {} : { session_id: raw }),
  };
}

function endHook(
  root: string,
  raw: string | null,
  extra: {
    launchRoot?: string | null;
    cheapInSync?: (root: string) => CheapInSyncResult;
    release?: typeof releaseOwnedOccupancyOnSessionEnd;
    environ?: NodeJS.ProcessEnv;
  } = {},
) {
  return runSessionEndHook(
    {
      host: "claude",
      projectRoot: root,
      payload: payloadFor(raw, root),
      environ: extra.environ ?? {},
      launchRoot: extra.launchRoot ?? null,
    },
    {
      cheapInSync: extra.cheapInSync ?? okCheap,
      ...(extra.release !== undefined ? { release: extra.release } : {}),
    },
  );
}

function expectOneBoundedLine(diagnostic: string): void {
  expect(diagnostic.length).toBeGreaterThan(0);
  expect(diagnostic.includes("\n")).toBe(false);
  expect(diagnostic.length).toBeLessThanOrEqual(400);
}

describe("session.end host support (#6274)", () => {
  it("is Claude Code only in this cut", () => {
    expect([...SESSION_END_HOOK_HOSTS]).toEqual(["claude"]);
  });
});

describe("releaseOwnedOccupancyOnSessionEnd (#6274 strict owner release)", () => {
  it("own live lease is released and the next session claims without a steal", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    expect(readOccupancy(root)?.sessionId).toBe(OWNER_S);

    const result = endHook(root, RAW_S);
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("released");
    expect(existsSync(occupancyPath(root))).toBe(false);

    const next = applyWorktreeOccupancy(root, { sessionId: OWNER_T, now: new Date() });
    expect(next.action).toBe("claimed");
    expect(next.code).toBe(0);
    expect(readOccupancy(root)?.sessionId).toBe(OWNER_T);
  });

  it("own expired lease is released", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: LONG_AGO });
    const result = endHook(root, RAW_S);
    expect(result.outcome).toBe("released");
    expect(existsSync(occupancyPath(root))).toBe(false);
  });

  it("foreign live lease is left byte-identical", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_T, now: new Date() });
    const before = snapshot(root);
    const result = endHook(root, RAW_S);
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("foreign-owner");
    expect(snapshot(root)).toEqual(before);
  });

  it("foreign expired lease is left byte-identical", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_T, now: LONG_AGO });
    const before = snapshot(root);
    const result = endHook(root, RAW_S);
    expect(result.outcome).toBe("foreign-owner");
    expect(snapshot(root)).toEqual(before);
  });

  it("no lease leaves a foreign applying-host record byte-identical", () => {
    const root = tempRoot();
    const published = publishApplyingHost(root, { provider: "claude", rawSessionId: RAW_T });
    expect(published.status).toBe("published");
    const before = snapshot(root);
    const result = endHook(root, RAW_S);
    expect(result.outcome).toBe("no-lease");
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(applyingHostPath(root))).toBe(true);
  });

  it("own lease plus a foreign applying-host record keeps that record", () => {
    const root = tempRoot();
    expect(publishApplyingHost(root, { provider: "claude", rawSessionId: RAW_T }).status).toBe(
      "published",
    );
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    expect(existsSync(applyingHostPath(root))).toBe(true);
    const applyingBefore = readFileSync(applyingHostPath(root), "utf8");

    const result = endHook(root, RAW_S);
    expect(result.outcome).toBe("released");
    expect(existsSync(occupancyPath(root))).toBe(false);
    expect(readFileSync(applyingHostPath(root), "utf8")).toBe(applyingBefore);
  });

  it("own lease plus own applying-host record removes both", () => {
    const root = tempRoot();
    expect(publishApplyingHost(root, { provider: "claude", rawSessionId: RAW_S }).status).toBe(
      "published",
    );
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    const result = endHook(root, RAW_S);
    expect(result.outcome).toBe("released");
    expect(existsSync(occupancyPath(root))).toBe(false);
    expect(existsSync(applyingHostPath(root))).toBe(false);
  });

  it("own lease with failing header enforcement is still released and no other file is edited", () => {
    const root = tempRoot();
    const claimedAt = new Date();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: claimedAt });
    // Product evidence marker, then a scaffold header: manual release refuses.
    applyWorktreeOccupancy(root, {
      sessionId: OWNER_S,
      now: new Date(claimedAt.getTime() + 1000),
      markWrite: true,
    });
    writeFileSync(
      join(root, "AGENTS.md"),
      `# Project\n\n${CONSUMER_HEADER_PLACEHOLDER_ONELINER}\n`,
      "utf8",
    );
    const manual = releaseOccupancy(root, { sessionId: OWNER_S });
    expect(manual.code).toBe(1);
    expect(manual.action).toBe("denied");
    expect(readOccupancy(root)?.sessionId).toBe(OWNER_S);

    const before = snapshot(root);
    const result = endHook(root, RAW_S);
    expect(result.outcome).toBe("released");
    const after = snapshot(root);
    before.delete(".deft/occupancy.json");
    expect(after).toEqual(before);
  });

  it("duplicate end is a no-op", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    expect(endHook(root, RAW_S).outcome).toBe("released");
    const before = snapshot(root);
    const second = endHook(root, RAW_S);
    expect(second.exitCode).toBe(0);
    expect(second.outcome).toBe("no-lease");
    expect(snapshot(root)).toEqual(before);
  });

  it("delayed end after the next session claimed is a no-op", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    expect(endHook(root, RAW_S).outcome).toBe("released");
    applyWorktreeOccupancy(root, { sessionId: OWNER_T, now: new Date() });
    const before = snapshot(root);
    const delayed = endHook(root, RAW_S);
    expect(delayed.outcome).toBe("foreign-owner");
    expect(snapshot(root)).toEqual(before);
    expect(readOccupancy(root)?.sessionId).toBe(OWNER_T);
  });

  it("missing payload session_id touches nothing, even when ambient identity names the owner", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    const before = snapshot(root);
    const result = endHook(root, null, {
      environ: { DEFT_SESSION_ID: OWNER_S, CLAUDE_CODE_SESSION_ID: RAW_S },
    });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("no-identity");
    expect(snapshot(root)).toEqual(before);
  });

  it("the strict operation itself refuses an empty owner id without touching files", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    const before = snapshot(root);
    expect(releaseOwnedOccupancyOnSessionEnd(root, { ownerSessionId: "" }).outcome).toBe(
      "no-identity",
    );
    expect(snapshot(root)).toEqual(before);
  });
});

describe("runSessionEndHook runtime path (#6274)", () => {
  it("pin mismatch releases nothing, prints one bounded diagnostic and exits 0", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    const before = snapshot(root);
    const result = endHook(root, RAW_S, { cheapInSync: pinMismatchCheap });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("pin-mismatch");
    expectOneBoundedLine(result.diagnostic);
    expect(snapshot(root)).toEqual(before);
  });

  it("launch-root mismatch releases nothing, prints one bounded diagnostic and exits 0", () => {
    const root = tempRoot();
    const elsewhere = mkdtempSync(join(tmpdir(), "occupancy-session-end-launch-"));
    temps.push(elsewhere);
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    const before = snapshot(root);
    const result = endHook(root, RAW_S, { launchRoot: elsewhere });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("launch-root-mismatch");
    expectOneBoundedLine(result.diagnostic);
    expect(snapshot(root)).toEqual(before);
  });

  it("a thrown release exits 0 with one bounded diagnostic", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    const result = endHook(root, RAW_S, {
      release: () => {
        throw new Error(`boom ${"x".repeat(2000)}`);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("release-failed");
    expectOneBoundedLine(result.diagnostic);
    expect(readOccupancy(root)?.sessionId).toBe(OWNER_S);
  });

  it("a host without session-end support releases nothing", () => {
    const root = tempRoot();
    applyWorktreeOccupancy(root, { sessionId: OWNER_S, now: new Date() });
    const before = snapshot(root);
    const result = runSessionEndHook(
      {
        host: "codex",
        projectRoot: root,
        payload: payloadFor(RAW_S, root),
        environ: {},
        launchRoot: null,
      },
      { cheapInSync: okCheap },
    );
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("unsupported-host");
    expect(snapshot(root)).toEqual(before);
  });
});
