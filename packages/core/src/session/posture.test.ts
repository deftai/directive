import { describe, expect, it } from "vitest";
import {
  DEFAULT_POSTURE,
  detectMutationIntent,
  parseStructuredHandoff,
  readOnlyPostureMessage,
  resolveSessionPosture,
  ritualStateIsPostureAuthority,
} from "./posture.js";

describe("session posture (#2180)", () => {
  it("defaults to read-only for cleared context", () => {
    expect(resolveSessionPosture({})).toBe(DEFAULT_POSTURE);
    expect(DEFAULT_POSTURE).toBe("read-only");
  });

  it("ritual-state is never posture authority", () => {
    expect(ritualStateIsPostureAuthority()).toBe(false);
  });

  it("detects mutation intent verbs", () => {
    expect(detectMutationIntent("please implement #2180")).toBe(true);
    expect(detectMutationIntent("operator: ship this through merge")).toBe(true);
    expect(detectMutationIntent("drive-to: merge-ready")).toBe(true);
    expect(detectMutationIntent("what is the triage queue?")).toBe(false);
    expect(detectMutationIntent("discuss the design in plan mode")).toBe(false);
  });

  it("parses swarm allocation-context handoff with mutation intent", () => {
    const text = `
## Allocation context
- dispatch_kind: swarm-cohort
- operator_approval_evidence: task swarm:launch
Authorization: implement / ship #2180
`;
    const handoff = parseStructuredHandoff(text);
    expect(handoff?.posture).toBe("mutation");
    expect(handoff?.source).toBe("allocation-context");
    expect(handoff?.mutationIntent).toBe(true);
  });

  it("parses structured plan handoff as read-only", () => {
    const text = `
## Structured handoff
posture: read-only
Next: discuss issue #2180 acceptance criteria only.
`;
    const handoff = parseStructuredHandoff(text);
    expect(handoff?.posture).toBe("read-only");
    expect(handoff?.source).toBe("plan");
    expect(handoff?.mutationIntent).toBe(false);
  });

  it("explicit read-only handoff is not overridden by mutation verbs in prose", () => {
    const text = `
## Structured handoff
posture: read-only
mutation_intent: false
Next: discuss whether we should build or edit later — do not implement yet.
`;
    const handoff = parseStructuredHandoff(text);
    expect(handoff?.posture).toBe("read-only");
    expect(handoff?.mutationIntent).toBe(false);
  });

  it("parses compaction handoff with mutation intent", () => {
    const text = `
handoff_kind: compaction
posture: mutation
mutation_intent: true
Next: commit the staged fix and open PR.
`;
    const handoff = parseStructuredHandoff(text);
    expect(handoff?.posture).toBe("mutation");
    expect(handoff?.source).toBe("compaction");
  });

  it("respects env posture override", () => {
    expect(resolveSessionPosture({ envPosture: "mutation" })).toBe("mutation");
    expect(resolveSessionPosture({ envPosture: "mutating" })).toBe("mutation");
    expect(resolveSessionPosture({ envPosture: "read-only" })).toBe("read-only");
  });

  it("explicit posture wins over env and handoff", () => {
    expect(
      resolveSessionPosture({
        explicitPosture: "read-only",
        envPosture: "mutation",
        handoffText: "implement everything",
      }),
    ).toBe("read-only");
  });

  it("gated tier defaults to mutation posture at mutation boundary", () => {
    expect(resolveSessionPosture({ tier: "gated" })).toBe("mutation");
    expect(resolveSessionPosture({ tier: "quick" })).toBe("read-only");
  });

  it("readOnlyPostureMessage documents diagnostic-only contract", () => {
    expect(readOnlyPostureMessage("gated")).toContain("read-only posture");
    expect(readOnlyPostureMessage("gated")).toContain("diagnostic-only");
  });
});
