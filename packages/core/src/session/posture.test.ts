import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPersistedSessionPosture,
  DEFAULT_POSTURE,
  detectMutationIntent,
  isRequirementsPosture,
  overlayTrustedSessionPosture,
  parseSessionPostureToken,
  parseStructuredHandoff,
  persistTrustedSessionPosture,
  readOnlyPostureMessage,
  readPersistedSessionPosture,
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

  it("parses requirements and assist aliases and refuses unknown tokens (#4444)", () => {
    expect(parseSessionPostureToken("requirements").token).toBe("requirements");
    expect(parseSessionPostureToken("docs").token).toBe("assist");
    expect(parseSessionPostureToken("requirement").error).toContain(
      "unknown session posture token",
    );
    expect(parseSessionPostureToken("requirement").error).toContain("closed set");
    expect(isRequirementsPosture({ DEFT_SESSION_POSTURE: "requirements" })).toBe(true);
    expect(isRequirementsPosture({ DEFT_SESSION_POSTURE: "docs" })).toBe(false);
    expect(resolveSessionPosture({ envPosture: "requirements" })).toBe("requirements");
  });
});

describe("trusted session posture file (#4444)", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
    temps.length = 0;
  });
  it("persists requirements and overlays when env is unset", () => {
    const root = mkdtempSync(join(tmpdir(), "posture-file-"));
    temps.push(root);
    persistTrustedSessionPosture(root, "requirements", "owner-a");
    expect(readPersistedSessionPosture(root)).toBe("requirements");
    const over = overlayTrustedSessionPosture(root, {}, "owner-a");
    expect(over.DEFT_SESSION_POSTURE).toBe("requirements");
    expect(overlayTrustedSessionPosture(root, {}, "owner-b").DEFT_SESSION_POSTURE).toBeUndefined();
    expect(overlayTrustedSessionPosture(root, {}).DEFT_SESSION_POSTURE).toBeUndefined();
  });
  it("lets env win over the persisted file", () => {
    const root = mkdtempSync(join(tmpdir(), "posture-env-"));
    temps.push(root);
    persistTrustedSessionPosture(root, "requirements", "owner-a");
    const over = overlayTrustedSessionPosture(root, { DEFT_SESSION_POSTURE: "assist" }, "owner-a");
    expect(over.DEFT_SESSION_POSTURE).toBe("assist");
  });
  it("clears the persisted file", () => {
    const root = mkdtempSync(join(tmpdir(), "posture-clear-"));
    temps.push(root);
    persistTrustedSessionPosture(root, "requirements", "owner-a");
    clearPersistedSessionPosture(root);
    expect(readPersistedSessionPosture(root)).toBeNull();
  });
});
