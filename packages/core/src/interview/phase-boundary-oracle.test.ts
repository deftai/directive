import { describe, expect, it } from "vitest";
import {
  evaluatePhaseBoundaryOracle,
  FALSE_PHASE_COMPLETION,
  PHASE_DRIFT_PROPOSAL_GROWTH,
  type PhaseBoundaryState,
  type PhaseBoundaryTranscript,
  RESUME_DEFERRAL_LOSS,
} from "./phase-boundary-oracle.js";

const baseState = (overrides: Partial<PhaseBoundaryState> = {}): PhaseBoundaryState => ({
  phaseId: "planning-full",
  acceptedDecisionIds: ["d-ui", "d-api"],
  declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
  deferredIds: ["defer-evidence"],
  proposalIds: ["prop-summary"],
  ...overrides,
});

describe("phase-boundary-oracle (#5355)", () => {
  describe("P1 PHASE_DRIFT_PROPOSAL_GROWTH", () => {
    it("negative: phase-complete then agent adds another proposal → fail token", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "proposal", refs: ["prop-summary"], text: "consolidated plan" },
          { role: "operator", kind: "confirm", text: "approved" },
          { role: "agent", kind: "summary", refs: ["planning-full"], text: "phase complete" },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-backend-gap"],
            text: "new backend prerequisite",
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-summary", "prop-backend-gap"],
        }),
        assertions: [{ pain: "P1", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === PHASE_DRIFT_PROPOSAL_GROWTH)).toBe(true);
      expect(result.failures.find((f) => f.pain === "P1")?.code).toBe(PHASE_DRIFT_PROPOSAL_GROWTH);
    });

    it("positive: operator introduces a genuine new requirement after phase-complete → pass", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "proposal", refs: ["prop-summary"] },
          { role: "agent", kind: "summary", refs: ["planning-full"], text: "phase complete" },
          {
            role: "operator",
            kind: "answer",
            text: "also need offline sync as a new requirement",
            refs: ["req-offline"],
          },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-offline"],
            text: "adaptive follow-up for offline sync",
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-summary", "prop-offline"],
        }),
        assertions: [{ pain: "P1", expect: "pass" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(true);
      expect(result.failures.filter((f) => f.pain === "P1")).toHaveLength(0);
    });
  });

  describe("P2 FALSE_PHASE_COMPLETION", () => {
    it("negative: schema-shaped unfinished + per-answer confirm as full-phase completion → fail token", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "question", text: "pick auth model?" },
          { role: "operator", kind: "answer", text: "2" },
          { role: "operator", kind: "confirm", text: "2", refs: ["d-ui"] },
          {
            role: "agent",
            kind: "summary",
            text: "phase complete; draft is schema-valid unfinished",
            refs: ["planning-full"],
          },
        ],
        // accepted is a proper subset of declared — unfinished decision set
        state: baseState({
          acceptedDecisionIds: ["d-ui"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-draft"],
        }),
        assertions: [{ pain: "P2", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === FALSE_PHASE_COMPLETION)).toBe(true);
      expect(result.failures.find((f) => f.pain === "P2")?.detail).toMatch(/d-api|d-auth/);
    });

    it("positive: completion claim with acceptedDecisionIds covering declaredDecisionIds → pass", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "operator", kind: "confirm", refs: ["d-ui", "d-api", "d-auth"] },
          {
            role: "agent",
            kind: "summary",
            text: "phase complete with declared-decision coverage",
            refs: ["planning-full"],
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        }),
        assertions: [{ pain: "P2", expect: "pass" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(true);
      expect(result.failures.filter((f) => f.pain === "P2")).toHaveLength(0);
    });
  });

  describe("P3 RESUME_DEFERRAL_LOSS", () => {
    it("negative: resume drops a deferred id → fail token", () => {
      const handoff = baseState({
        deferredIds: ["defer-evidence", "defer-perf"],
        proposalIds: ["prop-summary"],
      });
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "defer", refs: ["defer-evidence", "defer-perf"] },
          { role: "agent", kind: "summary", refs: ["planning-full"] },
          { role: "agent", kind: "resume", text: "planning-full" },
        ],
        handoffState: handoff,
        state: {
          ...handoff,
          deferredIds: ["defer-perf"], // dropped defer-evidence
        },
        assertions: [{ pain: "P3", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === RESUME_DEFERRAL_LOSS)).toBe(true);
      expect(result.failures.find((f) => f.pain === "P3")?.detail).toMatch(/defer-evidence/);
    });

    it("negative: resume rewrites phaseId without operator phase-change → fail token", () => {
      const handoff = baseState({ phaseId: "planning-full" });
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "defer", refs: ["defer-evidence"] },
          { role: "agent", kind: "summary", refs: ["planning-full"] },
          { role: "agent", kind: "resume", text: "planning-full" },
        ],
        handoffState: handoff,
        state: {
          ...handoff,
          phaseId: "implementation", // unauthorized rewrite
        },
        assertions: [{ pain: "P3", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === RESUME_DEFERRAL_LOSS)).toBe(true);
      expect(result.failures.find((f) => f.pain === "P3")?.detail).toMatch(/phaseId changed/);
    });

    it("positive: resume preserves phaseId, accepted, declared, deferred → pass", () => {
      const handoff = baseState({
        acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
        declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        deferredIds: ["defer-evidence"],
      });
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "defer", refs: ["defer-evidence"] },
          { role: "agent", kind: "summary", refs: ["planning-full"] },
          { role: "agent", kind: "resume", text: "planning-full" },
        ],
        handoffState: handoff,
        state: { ...handoff },
        assertions: [{ pain: "P3", expect: "pass" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(true);
      expect(result.failures.filter((f) => f.pain === "P3")).toHaveLength(0);
    });
  });

  describe("targeted revision", () => {
    it("changing one accepted decision leaves unrelated accepted ids intact", () => {
      const before = baseState({
        acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
        declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
      });
      const afterAccepted = before.acceptedDecisionIds.map((id) =>
        id === "d-api" ? "d-api-v2" : id,
      );
      const after: PhaseBoundaryState = {
        ...before,
        acceptedDecisionIds: afterAccepted,
        declaredDecisionIds: ["d-ui", "d-api-v2", "d-auth"],
      };

      expect(after.acceptedDecisionIds).toContain("d-ui");
      expect(after.acceptedDecisionIds).toContain("d-auth");
      expect(after.acceptedDecisionIds).toContain("d-api-v2");
      expect(after.acceptedDecisionIds).not.toContain("d-api");

      const transcript: PhaseBoundaryTranscript = {
        turns: [
          {
            role: "operator",
            kind: "answer",
            text: "revise api decision only",
            refs: ["d-api-v2"],
          },
          {
            role: "agent",
            kind: "summary",
            text: "phase complete after targeted revision",
            refs: ["planning-full"],
          },
        ],
        state: after,
        assertions: [{ pain: "P2", expect: "pass" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(true);
      expect(result.failures).toHaveLength(0);
    });
  });

  describe("assertion matrix / failing-before passing-after", () => {
    it("same P2 shape flips from fail to pass when coverage is completed", () => {
      const turns = [
        { role: "operator" as const, kind: "confirm" as const, text: "1", refs: ["d-ui"] },
        {
          role: "agent" as const,
          kind: "summary" as const,
          text: "claiming phase complete",
          refs: ["planning-full"],
        },
      ];

      const before = evaluatePhaseBoundaryOracle({
        turns,
        state: baseState({
          acceptedDecisionIds: ["d-ui"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        }),
        assertions: [{ pain: "P2", expect: "fail" }],
      });
      expect(before.ok).toBe(false);
      expect(before.failures[0]?.code).toBe(FALSE_PHASE_COMPLETION);

      const after = evaluatePhaseBoundaryOracle({
        turns,
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        }),
        assertions: [{ pain: "P2", expect: "pass" }],
      });
      expect(after.ok).toBe(true);
      expect(after.failures).toHaveLength(0);
    });
  });

  describe("closed fail token literals", () => {
    it("exports the three locked string literals", () => {
      expect(PHASE_DRIFT_PROPOSAL_GROWTH).toBe("PHASE_DRIFT_PROPOSAL_GROWTH");
      expect(FALSE_PHASE_COMPLETION).toBe("FALSE_PHASE_COMPLETION");
      expect(RESUME_DEFERRAL_LOSS).toBe("RESUME_DEFERRAL_LOSS");
    });
  });
});
