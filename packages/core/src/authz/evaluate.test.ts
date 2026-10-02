import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mintHumanOriginGrant as mintHumanOriginGrantResult,
  startUatLease as startUatLeaseResult,
} from "./actions.js";

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

  it("denies nested product evidence paths under UAT (#4199)", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "operator" });
    const state = loadAuthzState(root);
    const nested = evaluateAuthzMutation({
      state,
      grants: [],
      op: "edit",
      path: "src/evidence/backdoor.ts",
    });
    expect(nested.allowed).toBe(false);
    const pkg = evaluateAuthzMutation({
      state,
      grants: [],
      op: "edit",
      path: "pkg/uat-evidence/note.md",
    });
    expect(pkg.allowed).toBe(false);
  });

  it("allows repo-root evidence capture under UAT (#4199)", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "operator" });
    const state = loadAuthzState(root);
    const d = evaluateAuthzMutation({
      state,
      grants: [],
      op: "edit",
      path: "evidence/capture.md",
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("authz-allow");
    const uat = evaluateAuthzMutation({
      state,
      grants: [],
      op: "edit",
      path: "uat-evidence/note.md",
    });
    expect(uat.allowed).toBe(true);
    expect(uat.code).toBe("authz-allow");
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
    // #4233: store refuses grant-create under UAT; plant via saveGrant before lease.
    saveGrant(root, selfAuthoredGrant());
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "operator" });
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
    // #4233: mint+pin before UAT; empty pin under UAT activates none.
    mintHumanOriginGrant({
      projectRoot: root,
      actor: "operator",
      operations: ["edit"],
      surfaces: ["packages/app/src/fix/**"],
      cohortId: "fix-defect-42",
      storyIds: ["2944"],
      pinActive: true,
    });
    startUatLease({ projectRoot: root, campaignId: "uat-1", actor: "operator" });
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
    mintHumanOriginGrant({
      projectRoot: root,
      operations: ["edit"],
      surfaces: ["src/a.ts"],
      cohortId: "cohort-a",
      pinActive: true,
    });
    startUatLease({ projectRoot: root, campaignId: "uat-campaign", actor: "operator" });
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

describe("inactive grant-store deny (#4709)", () => {
  function coveringGrant(): HumanOriginGrant {
    return {
      schemaVersion: 1,
      id: "covering-store-write",
      origin: {
        kind: "operator-cli",
        actor: "operator",
        mintedAt: "2026-10-01T00:00:00Z",
        mintedVia: "deft authz:grant",
        eventRef: null,
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: null,
        surfaces: ["**/*", ".deft/authz/grants/**"],
        operations: ["edit", "settings"],
        storyIds: [],
        issueIds: [],
        cohortId: "fix-4709",
      },
      semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
    };
  }

  it("denies Write of the inventoried store on the inactive path after realpath", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "authz", "grants"), { recursive: true });
    const d = evaluateAuthzMutation({
      state: inactiveState(),
      grants: [],
      op: "edit",
      path: ".deft/authz/grants/evil.json",
      projectRoot: root,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-uat-deny");
    expect(d.reason).toMatch(/covering-grant escape|inventoried authz store/i);
  });

  it("recuts the covering-grant-allows test", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "authz", "grants"), { recursive: true });
    const grant = coveringGrant();
    const inactive = evaluateAuthzMutation({
      state: inactiveState(),
      grants: [grant],
      op: "edit",
      path: ".deft/authz/grants/planted.json",
      projectRoot: root,
    });
    expect(inactive.allowed).toBe(false);
    expect(inactive.humanApprovalRef).toBeNull();

    startUatLease({ projectRoot: root, campaignId: "uat-4709", actor: "operator" });
    const state = loadAuthzState(root);
    const active = evaluateAuthzMutation({
      state,
      grants: [grant],
      op: "edit",
      path: ".deft/authz/grants/planted.json",
      projectRoot: root,
    });
    expect(active.allowed).toBe(false);
    expect(active.humanApprovalRef).toBeNull();
  });

  it("adds the Shell-equivalent deny on the inactive path", () => {
    const d = evaluateAuthzMutation({
      state: inactiveState(),
      grants: [coveringGrant()],
      op: "settings",
      path: null,
      protectedStoreShellWrite: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-uat-deny");
  });

  it("denies dest-of-write unknown targeting the protected set when inactive", () => {
    const d = evaluateAuthzMutation({
      state: inactiveState(),
      grants: [],
      op: "unknown",
      path: null,
      protectedStoreShellWrite: true,
    });
    expect(d.allowed).toBe(false);
  });

  it("keeps dest-of-write unknown grant-immune under active UAT", () => {
    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-4709", actor: "operator" });
    const d = evaluateAuthzMutation({
      state: loadAuthzState(root),
      grants: [coveringGrant()],
      op: "unknown",
      path: null,
      protectedStoreShellWrite: true,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/classifiable form/i);
    expect(d.reason).toMatch(/suspend UAT/i);
  });

  it("denies classified protected_store with no covering-grant escape", () => {
    const inactive = evaluateAuthzMutation({
      state: inactiveState(),
      grants: [coveringGrant()],
      op: "protected_store",
      path: null,
    });
    expect(inactive.allowed).toBe(false);
    expect(inactive.code).toBe("authz-uat-deny");
    expect(inactive.humanApprovalRef).toBeNull();

    const root = tempRoot();
    startUatLease({ projectRoot: root, campaignId: "uat-4709", actor: "operator" });
    const active = evaluateAuthzMutation({
      state: loadAuthzState(root),
      grants: [coveringGrant()],
      op: "protected_store",
      path: null,
    });
    expect(active.allowed).toBe(false);
    expect(active.humanApprovalRef).toBeNull();
  });

  it("Write HOW uses worktree when projectRoot is omitted", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "authz", "grants"), { recursive: true });
    const d = evaluateAuthzMutation({
      state: inactiveState(),
      grants: [],
      op: "edit",
      path: ".deft/authz/grants/evil.json",
      worktree: root,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-uat-deny");
  });

  it("still allows ordinary product edits when UAT is inactive", () => {
    const root = tempRoot();
    const d = evaluateAuthzMutation({
      state: inactiveState(),
      grants: [],
      op: "edit",
      path: "packages/core/src/authz/evaluate.ts",
      projectRoot: root,
    });
    expect(d.allowed).toBe(true);
    expect(d.code).toBe("authz-inactive");
  });

  it.skipIf(process.platform === "win32")(
    "Write HOW realpaths the tool dest and does not use harvestDestsOfWriteForRealpath",
    () => {
      const root = tempRoot();
      mkdirSync(join(root, ".deft", "authz", "grants"), { recursive: true });
      writeFileSync(join(root, ".deft", "authz", "grants", "g.json"), "{}\n");
      symlinkSync(join(root, ".deft", "authz"), join(root, "build-cache"));
      const d = evaluateAuthzMutation({
        state: inactiveState(),
        grants: [],
        op: "edit",
        path: "build-cache/grants/g.json",
        projectRoot: root,
      });
      expect(d.allowed).toBe(false);
      expect(d.code).toBe("authz-uat-deny");
    },
  );
});
