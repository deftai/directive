/**
 * Incident-sequence regression for #2944 Wave 1.
 *
 * Reproduce: active UAT → agent treats triage/swarm language as implement authority
 * → first unauthorized product edit is blocked.
 */

import { describe, expect, it } from "vitest";
import { decideHook, type HookPolicySeams } from "../hooks/dispatcher.js";
import type { VerifyResult } from "../session/verify-session-ritual.js";
import { evaluateAuthzMutation } from "./evaluate.js";
import { evidenceSatisfiesImplementationApproval } from "./origin.js";
import type { AuthzState, HumanOriginGrant, UatLease } from "./types.js";

const readyRitual: VerifyResult = {
  code: 0,
  message: "OK session ritual gated tier is fresh.",
  tier: "gated",
  statePath: "/project/.deft/ritual-state.json",
  bypassed: false,
  wouldFailCode: null,
  posture: "mutation",
  ritualStateRequired: true,
};

function readySeams(overrides: Partial<HookPolicySeams> = {}): HookPolicySeams {
  return {
    inspectRitual: () => readyRitual,
    inspectScope: () => ({
      ready: true,
      path: "xbrief/active/story.xbrief.json",
      message: "active scope ready",
    }),
    authzAudit: false,
    ...overrides,
  };
}

function activeUatState(): AuthzState {
  const lease: UatLease = {
    active: true,
    campaignId: "uat-incident-2026",
    startedAt: "2026-07-30T00:00:00Z",
    startedBy: {
      kind: "operator-cli",
      actor: "operator",
      mintedAt: "2026-07-30T00:00:00Z",
      mintedVia: "deft authz:uat-start",
      eventRef: null,
    },
    suspendedAt: null,
    note: "full UAT + defect capture",
  };
  return { schemaVersion: 1, uat: lease, activeGrantIds: [] };
}

const selfMintedFromDispatch: HumanOriginGrant = {
  schemaVersion: 1,
  id: "agent-minted",
  origin: {
    kind: "dispatch-envelope",
    actor: "agent",
    mintedAt: "2026-07-30T01:00:00Z",
    mintedVia: "allocation_context free-text",
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
    cohortId: "swarmed-defects",
  },
  semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
};

describe("incident sequence regression (#2944)", () => {
  it("1–3: operator UAT + swarm language does not mint implement approval", () => {
    // Agent-advanced lifecycle / allocation_context is not human-origin approval.
    expect(
      evidenceSatisfiesImplementationApproval({
        xbriefStatus: "running",
        allocationContext: {
          dispatch_kind: "swarm-cohort",
          allocation_plan_id: "plan-x",
          batching_rationale: "operator said swarm these defects",
        },
        lifecycleAdvancedBy: "agent",
      }),
    ).toBe(false);
    expect(evidenceSatisfiesImplementationApproval({ grant: selfMintedFromDispatch })).toBe(false);
  });

  it("4: first unauthorized product/UI edit is blocked under active UAT", () => {
    const state = activeUatState();
    // Pure evaluate path
    const pure = evaluateAuthzMutation({
      state,
      grants: [selfMintedFromDispatch],
      op: "edit",
      path: "apps/web/src/components/Header.tsx",
    });
    expect(pure.allowed).toBe(false);
    expect(pure.reason).toMatch(/Human action required|self-authored|origin/i);

    // PreToolUse decideHook path (enforcement before execution)
    const decision = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Write",
          tool_input: {
            file_path: "/project/apps/web/src/components/Header.tsx",
            content: "/* unauthorized UI change */",
          },
        },
      },
      readySeams({
        loadAuthzState: () => state,
        // Even if the agent wrote a self-minted grant file, filter like production store:
        loadAuthzGrants: () => [],
      }),
    );
    expect(decision.verdict).toBe("deny");
    expect(decision.code).toMatch(/^authz-/);
    expect(decision.message).toMatch(/UAT|Human action required|authz:grant/i);
  });

  it("5: continuation language does not unlock push/PR/merge under UAT", () => {
    const state = activeUatState();
    const seams = readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: true, merge: true },
      }),
    });

    for (const command of ["git push origin HEAD", "gh pr create --title t", "gh pr merge 1"]) {
      const decision = decideHook(
        {
          host: "claude",
          event: "tool.before",
          projectRoot: "/project",
          payload: { tool_name: "Bash", tool_input: { command } },
        },
        seams,
      );
      expect(decision.verdict, command).toBe("deny");
      expect(decision.code, command).toMatch(/^authz-/);
    }
  });

  it("still allows test execution and issue filing during UAT", () => {
    const state = activeUatState();
    const seams = readySeams({
      loadAuthzState: () => state,
      loadAuthzGrants: () => [],
      loadRuntimeAuthority: () => ({
        enabled: false,
        allowPaths: [],
        denyPaths: [],
        scopes: { edits: true, push: false, merge: false },
      }),
    });

    const testRun = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: { tool_name: "Bash", tool_input: { command: "pnpm test" } },
      },
      seams,
    );
    expect(testRun.verdict).toBe("allow");

    const issue = decideHook(
      {
        host: "claude",
        event: "tool.before",
        projectRoot: "/project",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "gh issue create --title 'UAT defect' --body 'repro'" },
        },
      },
      seams,
    );
    expect(issue.verdict).toBe("allow");
  });
});
