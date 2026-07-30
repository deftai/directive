import { describe, expect, it } from "vitest";
import {
  evidenceSatisfiesImplementationApproval,
  isHumanOrigin,
  isHumanOriginGrant,
  isRejectedOriginKind,
} from "./origin.js";
import type { HumanOriginGrant } from "./types.js";

function grant(partial: { kind: string; actor?: string }): HumanOriginGrant {
  return {
    schemaVersion: 1,
    id: "g1",
    origin: {
      kind: partial.kind,
      actor: partial.actor ?? "operator",
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
      cohortId: "cohort-1",
    },
    semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
  };
}

describe("human-origin provenance (#2944)", () => {
  it("accepts operator-cli / operator-session / human-event", () => {
    expect(isHumanOriginGrant(grant({ kind: "operator-cli" }))).toBe(true);
    expect(isHumanOriginGrant(grant({ kind: "operator-session" }))).toBe(true);
    expect(isHumanOriginGrant(grant({ kind: "human-event" }))).toBe(true);
  });

  it("rejects agent-lifecycle, xbrief-status, dispatch-envelope, allocation-context", () => {
    for (const kind of [
      "agent-lifecycle",
      "xbrief-status",
      "dispatch-envelope",
      "allocation-context",
      "self-asserted",
      "agent-authored",
    ]) {
      expect(isRejectedOriginKind(kind)).toBe(true);
      expect(isHumanOriginGrant(grant({ kind }))).toBe(false);
    }
  });

  it("rejects agent-shaped actors even with human kind", () => {
    expect(isHumanOriginGrant(grant({ kind: "operator-cli", actor: "agent" }))).toBe(false);
    expect(isHumanOriginGrant(grant({ kind: "operator-cli", actor: "agent:worker" }))).toBe(false);
    expect(isHumanOrigin(grant({ kind: "operator-cli", actor: "self" }).origin)).toBe(false);
  });

  it("self-authored lifecycle / dispatch evidence never satisfies implement gates", () => {
    expect(
      evidenceSatisfiesImplementationApproval({
        xbriefStatus: "running",
        allocationContext: {
          dispatch_kind: "swarm-cohort",
          allocation_plan_id: "plan-1",
          batching_rationale: "operator said proceed",
        },
        dispatchEnvelope: "## Allocation context\ndispatch_kind: swarm-cohort",
        lifecycleAdvancedBy: "agent",
      }),
    ).toBe(false);

    expect(
      evidenceSatisfiesImplementationApproval({
        grant: grant({ kind: "allocation-context" }),
      }),
    ).toBe(false);

    expect(
      evidenceSatisfiesImplementationApproval({
        grant: grant({ kind: "operator-cli" }),
      }),
    ).toBe(true);
  });
});
