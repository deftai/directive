import { describe, expect, it } from "vitest";
import { formatDecision, REJECTED_LABEL } from "./index.js";
import type { AuditEntry } from "./types.js";

describe("formatDecision", () => {
  it("formats optional fields", () => {
    const entry: AuditEntry = {
      decision_id: "11111111-1111-1111-1111-111111111111",
      timestamp: "2026-06-18T12:00:00Z",
      repo: "deftai/directive",
      issue_number: 1,
      decision: "reject",
      actor: "agent:test",
      reason: "obsolete",
      linked_to: 2,
      prior_decision_id: "22222222-2222-2222-2222-222222222222",
    };
    const text = formatDecision(entry);
    expect(text).toContain("decision=reject");
    expect(text).toContain("reason='obsolete'");
    expect(text).toContain("linked_to=#2");
    expect(text).toContain("prior_decision_id=22222222-2222-2222-2222-222222222222");
  });

  it("returns placeholder when entry is null", () => {
    expect(formatDecision(null)).toBe("(no decision recorded)");
  });
});

describe("REJECTED_LABEL", () => {
  it("matches Python constant", () => {
    expect(REJECTED_LABEL).toBe("triage-rejected");
  });
});
