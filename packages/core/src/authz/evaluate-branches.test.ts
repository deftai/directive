import { describe, expect, it } from "vitest";
import { evaluateAuthzMutation, shouldConsumeSingleUseGrant } from "./evaluate.js";
import type { AuthzState, HumanOriginGrant } from "./types.js";

function uatState(active = true): AuthzState {
  return {
    schemaVersion: 1,
    uat: {
      active,
      campaignId: "c",
      startedAt: "2026-07-30T00:00:00Z",
      startedBy: {
        kind: "operator-cli",
        actor: "op",
        mintedAt: "2026-07-30T00:00:00Z",
        mintedVia: "cli",
        eventRef: null,
      },
      suspendedAt: active ? null : "2026-07-30T01:00:00Z",
      note: null,
    },
    activeGrantIds: [],
  };
}

function grant(overrides: Partial<HumanOriginGrant> & { kind?: string } = {}): HumanOriginGrant {
  const kind = overrides.kind ?? "operator-cli";
  return {
    schemaVersion: 1,
    id: overrides.id ?? "g1",
    origin: overrides.origin ?? {
      kind,
      actor: "operator",
      mintedAt: "2026-07-30T00:00:00Z",
      mintedVia: "cli",
      eventRef: null,
    },
    scope: overrides.scope ?? {
      planRef: null,
      repo: null,
      branch: null,
      worktree: null,
      surfaces: [],
      operations: ["edit", "push", "pr", "merge", "settings", "deployment"],
      storyIds: [],
      issueIds: [],
      cohortId: "cohort-1",
    },
    semantics: overrides.semantics ?? {
      expiresAt: null,
      singleUse: false,
      usedAt: null,
      revokedAt: null,
    },
  };
}

describe("evaluateAuthzMutation branch coverage (#2944)", () => {
  it("agent-minted UAT start is ignored (inactive path)", () => {
    const state: AuthzState = {
      schemaVersion: 1,
      uat: {
        active: true,
        campaignId: "c",
        startedAt: "2026-07-30T00:00:00Z",
        startedBy: {
          kind: "agent-lifecycle",
          actor: "agent",
          mintedAt: "2026-07-30T00:00:00Z",
          mintedVia: "self",
          eventRef: null,
        },
        suspendedAt: null,
        note: null,
      },
      activeGrantIds: [],
    };
    const d = evaluateAuthzMutation({
      state,
      grants: [],
      op: "edit",
      path: "src/a.ts",
    });
    expect(d.code).toBe("authz-inactive");
    expect(d.allowed).toBe(true);
  });

  it("unknown op under UAT is fail-closed deny", () => {
    const d = evaluateAuthzMutation({
      state: uatState(),
      grants: [],
      op: "unknown",
      path: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("authz-uat-deny");
  });

  it("evidence op allowed under UAT", () => {
    const d = evaluateAuthzMutation({
      state: uatState(),
      grants: [],
      op: "evidence",
      path: null,
    });
    expect(d.allowed).toBe(true);
  });

  it("settings and deployment denied without grant under UAT", () => {
    for (const op of ["settings", "deployment"] as const) {
      const d = evaluateAuthzMutation({ state: uatState(), grants: [], op, path: null });
      expect(d.allowed, op).toBe(false);
    }
  });

  it("revoked grant is rejected", () => {
    const d = evaluateAuthzMutation({
      state: uatState(),
      grants: [
        grant({
          semantics: {
            expiresAt: null,
            singleUse: false,
            usedAt: null,
            revokedAt: "2026-07-30T02:00:00Z",
          },
        }),
      ],
      op: "edit",
      path: "src/a.ts",
    });
    expect(d.code).toBe("authz-grant-revoked");
  });

  it("expired grant is rejected", () => {
    const d = evaluateAuthzMutation({
      state: uatState(),
      grants: [
        grant({
          semantics: {
            expiresAt: "2020-01-01T00:00:00Z",
            singleUse: false,
            usedAt: null,
            revokedAt: null,
          },
        }),
      ],
      op: "edit",
      path: "src/a.ts",
      now: new Date("2026-07-30T00:00:00Z"),
    });
    expect(d.code).toBe("authz-grant-expired");
  });

  it("single-use spent grant is rejected", () => {
    const d = evaluateAuthzMutation({
      state: uatState(),
      grants: [
        grant({
          semantics: {
            expiresAt: null,
            singleUse: true,
            usedAt: "2026-07-30T01:00:00Z",
            revokedAt: null,
          },
        }),
      ],
      op: "edit",
      path: "src/a.ts",
    });
    expect(d.code).toBe("authz-grant-single-use-spent");
  });

  it("unknown origin kind is rejected", () => {
    const d = evaluateAuthzMutation({
      state: uatState(),
      grants: [grant({ kind: "mystery-origin" })],
      op: "edit",
      path: "src/a.ts",
    });
    expect(d.code).toBe("authz-grant-origin-reject");
  });

  it("bound repo/branch mismatch and missing context fail closed", () => {
    const g = grant({
      scope: {
        planRef: "plan-1",
        repo: "org/repo",
        branch: "feat/x",
        worktree: "/wt",
        surfaces: [],
        operations: ["edit"],
        storyIds: ["1"],
        issueIds: [1],
        cohortId: "c1",
      },
    });
    expect(
      evaluateAuthzMutation({
        state: uatState(),
        grants: [g],
        op: "edit",
        path: "a.ts",
      }).allowed,
    ).toBe(false);
    expect(
      evaluateAuthzMutation({
        state: uatState(),
        grants: [g],
        op: "edit",
        path: "a.ts",
        repo: "other/repo",
        branch: "feat/x",
        worktree: "/wt",
        planRef: "plan-1",
        storyIds: ["1"],
        issueIds: [1],
      }).allowed,
    ).toBe(false);
    expect(
      evaluateAuthzMutation({
        state: uatState(),
        grants: [g],
        op: "edit",
        path: "a.ts",
        repo: "org/repo",
        branch: "feat/x",
        worktree: "/wt",
        planRef: "plan-1",
        storyIds: ["1"],
        issueIds: [1],
      }).allowed,
    ).toBe(true);
  });

  it("surface allowlist empty allows any path; non-empty filters", () => {
    const open = grant({
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
    });
    expect(
      evaluateAuthzMutation({
        state: uatState(),
        grants: [open],
        op: "edit",
        path: null,
      }).allowed,
    ).toBe(true);

    const limited = grant({
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: null,
        surfaces: ["only/**"],
        operations: ["edit"],
        storyIds: [],
        issueIds: [],
        cohortId: "c",
      },
    });
    expect(
      evaluateAuthzMutation({
        state: uatState(),
        grants: [limited],
        op: "edit",
        path: null,
      }).allowed,
    ).toBe(false);
  });

  it("shouldConsumeSingleUseGrant matrix", () => {
    expect(
      shouldConsumeSingleUseGrant({
        allowed: true,
        code: "authz-allow",
        reason: "x",
        humanApprovalRef: "g",
        approvedScope: null,
        attemptedOp: "edit",
        path: null,
      }),
    ).toBe(true);
    expect(
      shouldConsumeSingleUseGrant({
        allowed: true,
        code: "authz-inactive",
        reason: "x",
        humanApprovalRef: "g",
        approvedScope: null,
        attemptedOp: "edit",
        path: null,
      }),
    ).toBe(false);
  });

  it("incidents path is UAT-safe write", () => {
    const d = evaluateAuthzMutation({
      state: uatState(),
      grants: [],
      op: "edit",
      path: "incidents/2026-uat.md",
    });
    expect(d.allowed).toBe(true);
  });
});
