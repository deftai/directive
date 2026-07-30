import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintHumanOriginGrant, startUatLease } from "./actions.js";
import { evaluateAuthzMutation } from "./evaluate.js";
import { listActiveHumanGrants, loadAuthzState, saveGrant } from "./store.js";
import type { AuthzState, HumanOriginGrant } from "./types.js";

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
  const root = mkdtempSync(join(tmpdir(), "authz-2944-"));
  roots.push(root);
  return root;
}

function inactiveState(): AuthzState {
  return { schemaVersion: 1, uat: null, activeGrantIds: [] };
}

function selfAuthoredGrant(): HumanOriginGrant {
  return {
    schemaVersion: 1,
    id: "self-grant",
    origin: {
      kind: "allocation-context",
      actor: "agent",
      mintedAt: "2026-07-30T00:00:00Z",
      mintedVia: "agent dispatch",
      eventRef: null,
    },
    scope: {
      planRef: null,
      repo: null,
      branch: null,
      worktree: null,
      surfaces: ["**/*"],
      operations: ["edit", "push", "pr", "merge"],
      storyIds: [],
      issueIds: [],
      cohortId: "fake-cohort",
    },
    semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
  };
}

describe("evaluateAuthzMutation UAT lease (#2944)", () => {
  it("allows product edits when UAT inactive (Wave 1 gate off)", () => {
    const d = evaluateAuthzMutation({
      state: inactiveState(),
      grants: [],
      op: "edit",
      path: "src/ui/App.tsx",
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("authz-inactive");
  });

  it("denies product edit under active UAT without fix cohort grant", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-incident", actor: "operator" });
    const state = loadAuthzState(root);
    const d = evaluateAuthzMutation({
      state,
      grants: listActiveHumanGrants(root, state),
      op: "edit",
      path: "src/ui/App.tsx",
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toMatch(/authz-grant-missing|authz-uat-deny|authz-grant-scope/);
    expect(d.reason).toMatch(/Human action required|authz:grant|UAT/i);
  });

  it("allows defect capture writes under xbrief/proposed during UAT", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "operator" });
    const state = loadAuthzState(root);
    const d = evaluateAuthzMutation({
      state,
      grants: [],
      op: "edit",
      path: "xbrief/proposed/defect-123.xbrief.json",
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("authz-allow");
  });

  it("allows test and issue_mutation under UAT without grant", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "operator" });
    const state = loadAuthzState(root);
    expect(evaluateAuthzMutation({ state, grants: [], op: "test", path: null }).allowed).toBe(true);
    expect(
      evaluateAuthzMutation({ state, grants: [], op: "issue_mutation", path: null }).allowed,
    ).toBe(true);
  });

  it("denies push/pr/merge under UAT without cohort grant", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "operator" });
    const state = loadAuthzState(root);
    for (const op of ["push", "pr", "merge"] as const) {
      const d = evaluateAuthzMutation({ state, grants: [], op, path: null });
      expect(d.allowed, op).toBe(false);
    }
  });

  it("self-authored grant does not authorize product edit under UAT", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "operator" });
    saveGrant(root, selfAuthoredGrant());
    const state = loadAuthzState(root);
    // listActiveHumanGrants filters non-human; pass the self-authored grant explicitly
    // to prove evaluate still rejects origin.
    const d = evaluateAuthzMutation({
      state,
      grants: [selfAuthoredGrant()],
      op: "edit",
      path: "packages/app/src/ui/Button.tsx",
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-grant-origin-reject");
    expect(d.reason).toMatch(/agent\/self-authored|Human action required/i);
  });

  it("named fix cohort human-origin grant allows covered edit only", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "operator" });
    mintHumanOriginGrant({
      projectRoot: root,
      actor: "operator",
      operations: ["edit"],
      surfaces: ["packages/app/src/fix/**"],
      cohortId: "fix-defect-42",
      storyIds: ["2944"],
    });
    const state = loadAuthzState(root);
    const grants = listActiveHumanGrants(root, state);

    const allowed = evaluateAuthzMutation({
      state,
      grants,
      op: "edit",
      path: "packages/app/src/fix/bug.ts",
      storyIds: ["2944"],
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.humanApprovalRef).toBeTruthy();

    // Bound story id required when grant pins storyIds (fail closed).
    const missingStory = evaluateAuthzMutation({
      state,
      grants,
      op: "edit",
      path: "packages/app/src/fix/bug.ts",
    });
    expect(missingStory.allowed).toBe(false);

    const adjacent = evaluateAuthzMutation({
      state,
      grants,
      op: "edit",
      path: "packages/app/src/ui/Header.tsx",
      storyIds: ["2944"],
    });
    expect(adjacent.allowed).toBe(false);
    expect(adjacent.code).toBe("authz-grant-scope-deny");

    // Approving edit cohort does not authorize push.
    const push = evaluateAuthzMutation({
      state,
      grants,
      op: "push",
      path: null,
      storyIds: ["2944"],
    });
    expect(push.allowed).toBe(false);
  });

  it("one cohort grant does not clear UAT lock", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-campaign", actor: "operator" });
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      surfaces: ["src/a.ts"],
      cohortId: "cohort-a",
    });
    const state = loadAuthzState(root);
    expect(state.uat?.active).toBe(true);
    const grants = listActiveHumanGrants(root, state);
    const other = evaluateAuthzMutation({
      state,
      grants,
      op: "edit",
      path: "src/b.ts",
    });
    expect(other.allowed).toBe(false);
    expect(loadAuthzState(root).uat?.active).toBe(true);
  });
});
