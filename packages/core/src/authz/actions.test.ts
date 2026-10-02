import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mintHumanOriginGrant as mintHumanOriginGrantResult,
  revokeGrant as revokeGrantResult,
  showAuthzSnapshot,
  startUatLease as startUatLeaseResult,
  suspendUatLease as suspendUatLeaseResult,
} from "./actions.js";
import { uatCampaignEndSeal } from "./campaign-end-seal.js";
import { describeScope, shouldConsumeSingleUseGrant } from "./evaluate.js";
import { isHumanOriginGrant } from "./origin.js";
import { authzGrantPath } from "./paths.js";
import { listActiveHumanGrants, loadAuthzState, loadGrant } from "./store.js";

/** Test unwraps for #4233 Result-returning actions (throws free in *.test.ts). */
function mintHumanOriginGrant(
  ...args: Parameters<typeof mintHumanOriginGrantResult>
): import("./types.js").HumanOriginGrant {
  const r = mintHumanOriginGrantResult(...args);
  if (!r.ok) throw new Error(r.reason);
  return r.grant;
}
function startUatLease(...args: Parameters<typeof startUatLeaseResult>): {
  state: import("./types.js").AuthzState;
  lease: import("./types.js").UatLease;
} {
  const r = startUatLeaseResult(...args);
  if (!r.ok) throw new Error(r.reason);
  return { state: r.state, lease: r.lease };
}
function suspendUatLease(
  ...args: Parameters<typeof suspendUatLeaseResult>
): import("./types.js").AuthzState {
  const r = suspendUatLeaseResult(...args);
  if (!r.ok) throw new Error(r.reason);
  return r.state;
}
function revokeGrant(
  ...args: Parameters<typeof revokeGrantResult>
): import("./types.js").HumanOriginGrant | null {
  const r = revokeGrantResult(...args);
  if (!r.ok) throw new Error(r.reason);
  return r.grant;
}

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
  const root = mkdtempSync(join(tmpdir(), "authz-actions-"));
  roots.push(root);
  return root;
}

describe("authz actions + helpers (#2944)", () => {
  it("start requires campaign id", () => {
    const root = tempRoot();
    expect(() => startUatLease({ projectRoot: root, campaignId: "  " })).toThrow(/campaignId/);
  });

  it("mint requires operations and rejects unknown ops", () => {
    const root = tempRoot();
    expect(() => mintHumanOriginGrant({ projectRoot: root, operations: [] })).toThrow(/operations/);
    expect(() =>
      mintHumanOriginGrant({
        projectRoot: root,
        // @ts-expect-error intentional bad op
        operations: ["nope"],
      }),
    ).toThrow(/unknown operation/);
  });

  it("mint with pinActive + revoke + show snapshot", () => {
    const root = tempRoot();
    // #4233: mint/pin outside UAT; store hard-refuses grant create under active UAT.
    const g = mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit", "push"],
      surfaces: ["src/**"],
      cohortId: "fix-1",
      pinActive: true,
      grantId: "grant-fixed",
      planRef: "plan-1",
      repo: "org/repo",
      branch: "feat/x",
    });
    expect(g.id).toBe("grant-fixed");
    expect(authzGrantPath(root, g.id)).toContain("grant-fixed");
    startUatLease({ projectRoot: root, campaignId: "c", actor: "op" });
    const snap = showAuthzSnapshot(root);
    expect(snap.activeGrants.some((x) => x.id === g.id)).toBe(true);
    expect(snap.state.activeGrantIds).toContain(g.id);

    // Revoke under UAT is authority-field mutate — store refuse.
    expect(() => revokeGrant({ projectRoot: root, grantId: g.id })).toThrow(
      /active UAT|authority/i,
    );
    expect(revokeGrant({ projectRoot: root, grantId: "missing" })).toBeNull();

    suspendUatLease({ projectRoot: root, campaignEndSeal: uatCampaignEndSeal() });
    expect(showAuthzSnapshot(root).state.uat?.active).toBe(false);
    // second suspend is no-op
    suspendUatLease({ projectRoot: root });

    const revoked = revokeGrant({ projectRoot: root, grantId: g.id });
    expect(revoked?.semantics.revokedAt).toBeTruthy();
  });

  it("first pinActive mint seeds older empty-pin grants (#4233)", () => {
    const root = tempRoot();
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "older",
      grantId: "grant-older",
      pinActive: false,
    });
    expect(loadAuthzState(root).activeGrantIds).toEqual([]);
    expect(listActiveHumanGrants(root).some((g) => g.id === "grant-older")).toBe(true);

    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["push"],
      cohortId: "newer",
      grantId: "grant-newer",
      pinActive: true,
    });
    const pin = loadAuthzState(root).activeGrantIds;
    expect(pin).toContain("grant-older");
    expect(pin).toContain("grant-newer");
    const activeIds = listActiveHumanGrants(root).map((g) => g.id);
    expect(activeIds).toContain("grant-older");
    expect(activeIds).toContain("grant-newer");
  });

  it("failed pinActive mint under UAT leaves no grant on disk (#4233)", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "op" });
    const minted = mintHumanOriginGrantResult({
      projectRoot: root,
      operations: ["edit"],
      cohortId: "c1",
      grantId: "grant-orphan",
      pinActive: true,
    });
    expect(minted.ok).toBe(false);
    expect(loadGrant(root, "grant-orphan")).toBeNull();
    expect(existsSync(authzGrantPath(root, "grant-orphan"))).toBe(false);
    expect(loadAuthzState(root).activeGrantIds).not.toContain("grant-orphan");
  });

  it("startUatLease keeps a pin committed before the lease write (#4233)", () => {
    const root = tempRoot();
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      grantId: "grant-pinned",
      pinActive: true,
    });
    expect(loadAuthzState(root).activeGrantIds).toEqual(["grant-pinned"]);
    const started = startUatLease({ projectRoot: root, campaignId: "uat-keep-pin", actor: "op" });
    expect(started.state.activeGrantIds).toEqual(["grant-pinned"]);
    expect(loadAuthzState(root).activeGrantIds).toEqual(["grant-pinned"]);
    expect(showAuthzSnapshot(root).activeGrants.map((g) => g.id)).toEqual(["grant-pinned"]);
  });

  it("saveAuthzState UAT activate carries locked pin over a stale caller snapshot (#4233)", async () => {
    const root = tempRoot();
    const { saveAuthzState, mintOperatorOrigin } = await import("./store.js");
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      grantId: "grant-concurrent",
      pinActive: true,
    });
    const origin = mintOperatorOrigin("op", "deft authz:uat-start");
    // Stale pre-lock snapshot with empty pin — must not drop the concurrent pin.
    const wrote = saveAuthzState(root, {
      schemaVersion: 1,
      uat: {
        active: true,
        campaignId: "uat-stale-pin",
        startedAt: origin.mintedAt,
        startedBy: origin,
        suspendedAt: null,
        note: null,
      },
      activeGrantIds: [],
    });
    expect(wrote.ok).toBe(true);
    expect(loadAuthzState(root).activeGrantIds).toEqual(["grant-concurrent"]);
    expect(loadAuthzState(root).uat?.active).toBe(true);
  });

  it("describeScope and grantSatisfies helpers", () => {
    expect(describeScope(null)).toBe("(none)");
    expect(
      describeScope({
        planRef: "p",
        repo: null,
        branch: null,
        worktree: null,
        surfaces: ["a/**"],
        operations: ["edit"],
        storyIds: [],
        issueIds: [],
        cohortId: "c",
      }),
    ).toMatch(/ops=\[edit\]/);
    expect(isHumanOriginGrant(null)).toBe(false);
    expect(
      shouldConsumeSingleUseGrant({
        allowed: true,
        code: "authz-allow",
        reason: "ok",
        humanApprovalRef: "g1",
        approvedScope: null,
        attemptedOp: "edit",
        path: null,
      }),
    ).toBe(true);
    expect(
      shouldConsumeSingleUseGrant({
        allowed: false,
        code: "authz-uat-deny",
        reason: "no",
        humanApprovalRef: null,
        approvedScope: null,
        attemptedOp: "edit",
        path: null,
      }),
    ).toBe(false);
  });
});
