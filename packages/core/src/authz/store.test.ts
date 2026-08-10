import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintHumanOriginGrant, startUatLease, suspendUatLease } from "./actions.js";
import { authzStatePath } from "./paths.js";
import {
  appendAuthzAudit,
  claimSingleUseGrantForApply,
  listActiveHumanGrants,
  loadAuthzState,
  loadAuthzStateResult,
  loadGrant,
  markGrantUsed,
  parseGrant,
  saveAuthzState,
  saveGrant,
} from "./store.js";
import type { HumanOriginGrant } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "authz-store-"));
  roots.push(root);
  return root;
}

describe("authz store (#2944)", () => {
  it("missing state is inactive ok", () => {
    const root = tempRoot();
    const loaded = loadAuthzStateResult(root);
    expect(loaded.ok).toBe(true);
    expect(loaded.corrupt).toBe(false);
    expect(loaded.state.uat).toBeNull();
  });

  it("corrupt state fails closed (active synthetic UAT)", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "authz"), { recursive: true });
    writeFileSync(authzStatePath(root), "{not-json", "utf8");
    const loaded = loadAuthzStateResult(root);
    expect(loaded.ok).toBe(false);
    expect(loaded.corrupt).toBe(true);
    expect(loaded.state.uat?.active).toBe(true);
  });

  it("uat start/suspend round-trip", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "c1", actor: "op" });
    expect(loadAuthzState(root).uat?.active).toBe(true);
    suspendUatLease({ projectRoot: root });
    expect(loadAuthzState(root).uat?.active).toBe(false);
  });

  it("markGrantUsed sets usedAt for single-use grants", () => {
    const root = tempRoot();
    const grant = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      surfaces: ["src/**"],
      cohortId: "c",
      singleUse: true,
    });
    expect(grant.semantics.usedAt).toBeNull();
    const used = markGrantUsed(root, grant.id);
    expect(used?.semantics.usedAt).toBeTruthy();
    expect(listActiveHumanGrants(root).find((g) => g.id === grant.id)).toBeUndefined();
  });

  it("listActiveHumanGrants filters rejected origins", () => {
    const root = tempRoot();
    const bad: HumanOriginGrant = {
      schemaVersion: 1,
      id: "bad",
      origin: {
        kind: "dispatch-envelope",
        actor: "agent",
        mintedAt: "2026-07-30T00:00:00Z",
        mintedVia: "self",
        eventRef: null,
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: null,
        surfaces: [],
        operations: ["edit"],
        storyIds: [],
        issueIds: [],
        cohortId: "x",
      },
      semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
    };
    saveGrant(root, bad);
    expect(listActiveHumanGrants(root)).toHaveLength(0);
  });

  it("parseGrant rejects incomplete records", () => {
    expect(parseGrant(null)).toBeNull();
    expect(parseGrant({})).toBeNull();
    expect(parseGrant({ id: "x" })).toBeNull();
  });

  it("markGrantUsed is no-op for multi-use", () => {
    const root = tempRoot();
    const grant = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c",
      singleUse: false,
    });
    const again = markGrantUsed(root, grant.id);
    expect(again?.semantics.usedAt).toBeNull();
  });

  it("listActiveHumanGrants honors pin set, expiry, and corrupt grant files", () => {
    const root = tempRoot();
    const a = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c",
      grantId: "grant-a",
      pinActive: true,
    });
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c",
      grantId: "grant-b",
    });
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c",
      grantId: "grant-expired",
      expiresAt: "2000-01-01T00:00:00Z",
    });
    // Corrupt grant file is skipped
    const gdir = join(root, ".deft", "authz", "grants");
    writeFileSync(join(gdir, "bad.json"), "{nope", "utf8");
    writeFileSync(join(gdir, "not-json.txt"), "x", "utf8");
    const state = loadAuthzState(root);
    // pin only grant-a
    const pinned = listActiveHumanGrants(root, {
      ...state,
      activeGrantIds: [a.id],
    });
    expect(pinned.map((g) => g.id)).toEqual([a.id]);
    const allActive = listActiveHumanGrants(root, { ...state, activeGrantIds: [] });
    expect(allActive.some((g) => g.id === "grant-expired")).toBe(false);
    expect(markGrantUsed(root, "missing-id")).toBeNull();
  });

  it("loadGrant null paths and parseUat incomplete", () => {
    const root = tempRoot();
    expect(loadGrant(root, "nope")).toBeNull();
    mkdirSync(join(root, ".deft", "authz", "grants"), { recursive: true });
    writeFileSync(join(root, ".deft", "authz", "grants", "broken.json"), "{", "utf8");
    expect(loadGrant(root, "broken")).toBeNull();
  });

  it("grant id path sanitization and append audit", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c",
      grantId: "grant/with:weird*chars",
    });
    expect(g.id).toContain("grant");
    appendAuthzAudit(root, {
      schemaVersion: 1,
      ts: "2026-07-30T00:00:00Z",
      humanApprovalRef: g.id,
      approvedScope: g.scope,
      attemptedOp: "edit",
      path: "src/a.ts",
      result: "deny",
      code: "authz-uat-deny",
      message: "test",
      campaignId: "c",
    });
    // second markGrantUsed on already-used single-use is no-op path
    const su = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c2",
      singleUse: true,
      grantId: "su-1",
    });
    markGrantUsed(root, su.id);
    markGrantUsed(root, su.id);
  });

  it("refuses symlink leaf on grant write (#2980 wave B)", () => {
    const root = tempRoot();
    const outside = tempRoot();
    const victim = join(outside, "victim.json");
    writeFileSync(victim, '{"stolen":true}\n', "utf8");
    const grantsDir = join(root, ".deft", "authz", "grants");
    mkdirSync(grantsDir, { recursive: true });
    const linkPath = join(grantsDir, "linked.json");
    try {
      symlinkSync(victim, linkPath);
    } catch {
      // Platform may forbid symlink without elevation — skip.
      return;
    }
    const grant: HumanOriginGrant = {
      schemaVersion: 1,
      id: "linked",
      origin: {
        kind: "operator-cli",
        actor: "op",
        mintedAt: "2026-07-30T00:00:00Z",
        mintedVia: "test",
        eventRef: null,
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: null,
        surfaces: [],
        operations: ["edit"],
        storyIds: [],
        issueIds: [],
        cohortId: "c",
      },
      semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
    };
    // Leaf symlink refused by assertWriteTargetSafe (ProjectionContainmentError) before publish.
    expect(() => saveGrant(root, grant)).toThrow();
    expect(readFileSync(victim, "utf8")).toBe('{"stolen":true}\n');
  });

  it("saveAuthzState round-trips via containedWrite (#2980 wave B)", () => {
    const root = tempRoot();
    saveAuthzState(root, { schemaVersion: 1, uat: null, activeGrantIds: ["g1"] });
    expect(loadAuthzState(root).activeGrantIds).toEqual(["g1"]);
    // Replace path exercises atomic temp+rename publish twice.
    saveAuthzState(root, { schemaVersion: 1, uat: null, activeGrantIds: ["g1", "g2"] });
    expect(loadAuthzState(root).activeGrantIds).toEqual(["g1", "g2"]);
  });

  it("refuses grant write when grants dir parent is a symlink escape (#2980)", () => {
    const root = tempRoot();
    const outside = tempRoot();
    const authz = join(root, ".deft", "authz");
    mkdirSync(join(root, ".deft"), { recursive: true });
    try {
      symlinkSync(outside, authz);
    } catch {
      return;
    }
    const grant: HumanOriginGrant = {
      schemaVersion: 1,
      id: "escape",
      origin: {
        kind: "operator-cli",
        actor: "op",
        mintedAt: "2026-07-30T00:00:00Z",
        mintedVia: "test",
        eventRef: null,
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: null,
        surfaces: [],
        operations: ["edit"],
        storyIds: [],
        issueIds: [],
        cohortId: "c",
      },
      semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
    };
    expect(() => saveGrant(root, grant)).toThrow();
  });
});

describe("claimSingleUseGrantForApply (#3239)", () => {
  it("multi-use grant claims without marking usedAt", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      singleUse: false,
      grantId: "multi",
    });
    const claim = claimSingleUseGrantForApply(root, g.id);
    expect(claim.ok).toBe(true);
    expect(loadGrant(root, g.id)?.semantics.usedAt).toBeNull();
  });

  it("single-use grant marks usedAt under lock", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      singleUse: true,
      grantId: "once",
    });
    const claim = claimSingleUseGrantForApply(root, g.id);
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.grant.semantics.usedAt).toBeTruthy();
    expect(loadGrant(root, g.id)?.semantics.usedAt).toBeTruthy();
    const again = claimSingleUseGrantForApply(root, g.id);
    expect(again.ok).toBe(false);
  });

  it("revalidate can deny after lock and before mark", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      singleUse: true,
      grantId: "rev",
    });
    const claim = claimSingleUseGrantForApply(root, g.id, {
      revalidate: () => ({ ok: false, reason: "revoked mid-flight" }),
    });
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.reason).toMatch(/revoked mid-flight/);
    expect(loadGrant(root, g.id)?.semantics.usedAt).toBeNull();
  });

  it("missing grant id fails closed", () => {
    const root = tempRoot();
    const claim = claimSingleUseGrantForApply(root, "no-such-grant");
    expect(claim.ok).toBe(false);
  });

  it("Date overload for now still works", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      singleUse: true,
      grantId: "dated",
    });
    const claim = claimSingleUseGrantForApply(root, g.id, new Date("2026-08-10T12:00:00Z"));
    expect(claim.ok).toBe(true);
    expect(loadGrant(root, g.id)?.semantics.usedAt).toBe("2026-08-10T12:00:00Z");
  });

  it("stale lock is recovered so claim can proceed", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      singleUse: true,
      grantId: "stale-lock",
    });
    const lockDir = join(root, ".deft", "authz", "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "stale-lock.lock");
    writeFileSync(lockPath, "dead-pid\n", "utf8");
    // Age the lock past the stale threshold.
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    const claim = claimSingleUseGrantForApply(root, g.id);
    expect(claim.ok).toBe(true);
  });

  it("fresh lock fails closed without stale recovery", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      singleUse: true,
      grantId: "fresh-lock",
    });
    const lockDir = join(root, ".deft", "authz", "locks");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, "fresh-lock.lock");
    writeFileSync(lockPath, "live-pid\n", "utf8");
    // Keep mtime current — not stale.
    const claim = claimSingleUseGrantForApply(root, g.id);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.reason).toMatch(/reserved|concurrent/i);
    expect(loadGrant(root, g.id)?.semantics.usedAt).toBeNull();
  });

  it("revalidate success allows single-use claim", () => {
    const root = tempRoot();
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      singleUse: true,
      grantId: "reval-ok",
    });
    let seen = false;
    const claim = claimSingleUseGrantForApply(root, g.id, {
      revalidate: (grant) => {
        seen = grant.id === "reval-ok";
        return { ok: true };
      },
    });
    expect(seen).toBe(true);
    expect(claim.ok).toBe(true);
    expect(loadGrant(root, g.id)?.semantics.usedAt).toBeTruthy();
  });
});
