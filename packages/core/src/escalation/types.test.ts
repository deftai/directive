import { describe, expect, it } from "vitest";
import {
  BATCH_APPROVABLE_TYPES,
  DEFAULT_SLA_HOURS,
  ESCALATION_TYPES,
  isBatchApprovableType,
  isEscalationDecision,
  isEscalationType,
} from "./types.js";

describe("escalation types (#518)", () => {
  it("exposes six fixed types", () => {
    expect(ESCALATION_TYPES).toHaveLength(6);
    expect(isEscalationType("cmd_approval")).toBe(true);
    expect(isEscalationType("blocked")).toBe(false);
  });

  it("marks only cmd_approval and question batch-approvable", () => {
    expect(BATCH_APPROVABLE_TYPES).toEqual(["cmd_approval", "question"]);
    expect(isBatchApprovableType("cmd_approval")).toBe(true);
    expect(isBatchApprovableType("design_decision")).toBe(false);
  });

  it("validates decisions and default SLA map", () => {
    expect(isEscalationDecision("approved")).toBe(true);
    expect(isEscalationDecision("maybe")).toBe(false);
    expect(DEFAULT_SLA_HOURS.external).toBe(72);
    expect(DEFAULT_SLA_HOURS.cmd_approval).toBe(1);
  });
});
