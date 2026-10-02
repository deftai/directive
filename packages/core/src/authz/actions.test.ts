import { mkdtempSync, rmSync } from "node:fs";
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
import { describeScope, shouldConsumeSingleUseGrant } from "./evaluate.js";
import { isHumanOriginGrant } from "./origin.js";
import { authzGrantPath } from "./paths.js";
import { uatCampaignEndSeal } from "./uat-write-guard.js";

/** Test unwraps for #4233 Result-returning actions (throws free in *.test.ts). */
function mintHumanOriginGrant(
  ...args: Parameters<typeof mintHumanOriginGrantResult>
): import("./types.js").HumanOriginGrant {
  const r = mintHumanOriginGrantResult(...args);
  if (!r.ok) throw new Error(r.reason);
  return r.grant;
}
function startUatLease(
  ...args: Parameters<typeof startUatLeaseResult>
): { state: import("./types.js").AuthzState; lease: import("./types.js").UatLease } {
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
    expect(() => revokeGrant({ projectRoot: root, grantId: g.id })).toThrow(/active UAT|authority/i);
    expect(revokeGrant({ projectRoot: root, grantId: "missing" })).toBeNull();

    suspendUatLease({ projectRoot: root, campaignEndSeal: uatCampaignEndSeal() });
    expect(showAuthzSnapshot(root).state.uat?.active).toBe(false);
    // second suspend is no-op
    suspendUatLease({ projectRoot: root });

    const revoked = revokeGrant({ projectRoot: root, grantId: g.id });
    expect(revoked?.semantics.revokedAt).toBeTruthy();
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
