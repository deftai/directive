import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mintHumanOriginGrant,
  revokeGrant,
  showAuthzSnapshot,
  startUatLease,
  suspendUatLease,
} from "./actions.js";
import {
  describeScope,
  grantSatisfiesImplementationApproval,
  shouldConsumeSingleUseGrant,
} from "./evaluate.js";
import { authzGrantPath } from "./paths.js";

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
    startUatLease({ projectRoot: root, campaignId: "c", actor: "op" });
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
    const snap = showAuthzSnapshot(root);
    expect(snap.activeGrants.some((x) => x.id === g.id)).toBe(true);
    expect(snap.state.activeGrantIds).toContain(g.id);

    const revoked = revokeGrant({ projectRoot: root, grantId: g.id });
    expect(revoked?.semantics.revokedAt).toBeTruthy();
    expect(revokeGrant({ projectRoot: root, grantId: "missing" })).toBeNull();

    suspendUatLease({ projectRoot: root });
    expect(showAuthzSnapshot(root).state.uat?.active).toBe(false);
    // second suspend is no-op
    suspendUatLease({ projectRoot: root });
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
    expect(grantSatisfiesImplementationApproval(null)).toBe(false);
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
