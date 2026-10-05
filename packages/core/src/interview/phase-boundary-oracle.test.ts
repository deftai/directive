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
      const beforeTurns = [
        { role: "operator" as const, kind: "confirm" as const, text: "1", refs: ["d-ui"] },
        {
          role: "agent" as const,
          kind: "summary" as const,
          text: "claiming phase complete",
          refs: ["planning-full"],
        },
      ];

      const before = evaluatePhaseBoundaryOracle({
        turns: beforeTurns,
        state: baseState({
          acceptedDecisionIds: ["d-ui"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        }),
        assertions: [{ pain: "P2", expect: "fail" }],
      });
      expect(before.ok).toBe(false);
      expect(before.failures[0]?.code).toBe(FALSE_PHASE_COMPLETION);

      const after = evaluatePhaseBoundaryOracle({
        turns: [
          {
            role: "operator",
            kind: "confirm",
            text: "all",
            refs: ["d-ui", "d-api", "d-auth"],
          },
          {
            role: "agent",
            kind: "summary",
            text: "claiming phase complete",
            refs: ["planning-full"],
          },
        ],
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

  describe("Greptile P1 regression guards", () => {
    it("later summary does not hide proposal drift after first completion claim", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "proposal", refs: ["prop-summary"] },
          { role: "agent", kind: "summary", text: "phase complete", refs: ["planning-full"] },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-backend-gap"],
            text: "unsolicited growth",
          },
          {
            role: "agent",
            kind: "summary",
            text: "phase complete again",
            refs: ["planning-full"],
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
    });

    it("ordinary operator answer without new requirement refs does not disable drift", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "proposal", refs: ["prop-summary"] },
          { role: "agent", kind: "summary", text: "phase complete", refs: ["planning-full"] },
          { role: "operator", kind: "answer", text: "2" },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-invented"],
            text: "unsolicited after ordinary answer",
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-summary", "prop-invented"],
        }),
        assertions: [{ pain: "P1", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === PHASE_DRIFT_PROPOSAL_GROWTH)).toBe(true);
    });

    it("interim progress summary is not a completion claim (no false P2)", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "operator", kind: "confirm", refs: ["d-ui"] },
          {
            role: "agent",
            kind: "summary",
            text: "progress update: still gathering auth choice",
            refs: ["planning-full"],
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        }),
        assertions: [{ pain: "P2", expect: "pass" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(true);
      expect(result.failures.filter((f) => f.pain === "P2")).toHaveLength(0);
    });

    it("later confirms do not erase a premature completion claim", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "operator", kind: "confirm", refs: ["d-ui"] },
          {
            role: "agent",
            kind: "summary",
            text: "phase complete",
            refs: ["planning-full"],
          },
          { role: "operator", kind: "confirm", refs: ["d-api", "d-auth"] },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        }),
        assertions: [{ pain: "P2", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === FALSE_PHASE_COMPLETION)).toBe(true);
    });

    it("resume text does not erase pre-resume summary phase evidence", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "defer", refs: ["defer-evidence"] },
          { role: "agent", kind: "summary", refs: ["planning-full"], text: "phase complete" },
          { role: "agent", kind: "resume", text: "implementation" },
        ],
        // No handoffState — derive from turns; resume text must not rewrite phase.
        state: baseState({
          phaseId: "implementation",
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          deferredIds: ["defer-evidence"],
        }),
        assertions: [{ pain: "P3", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === RESUME_DEFERRAL_LOSS)).toBe(true);
      expect(result.failures.find((f) => f.pain === "P3")?.detail).toMatch(/phaseId changed/);
    });

    it("negated phase-change wording does not authorize a rewrite", () => {
      const handoff = baseState({
        phaseId: "planning-full",
        acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
      });
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "defer", refs: ["defer-evidence"] },
          { role: "agent", kind: "summary", refs: ["planning-full"], text: "phase complete" },
          { role: "agent", kind: "resume", text: "planning-full" },
          { role: "operator", kind: "answer", text: "no phase change needed" },
        ],
        handoffState: handoff,
        state: {
          ...handoff,
          phaseId: "implementation",
        },
        assertions: [{ pain: "P3", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === RESUME_DEFERRAL_LOSS)).toBe(true);
      expect(result.failures.find((f) => f.pain === "P3")?.detail).toMatch(/phaseId changed/);
    });

    it("decision-id refs on ordinary answers do not disable drift detection", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "proposal", refs: ["prop-summary"] },
          { role: "agent", kind: "summary", text: "phase complete", refs: ["planning-full"] },
          { role: "operator", kind: "answer", text: "keep auth", refs: ["d-auth"] },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-invented"],
            text: "unsolicited after decision ref",
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-summary", "prop-invented"],
        }),
        assertions: [{ pain: "P1", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === PHASE_DRIFT_PROPOSAL_GROWTH)).toBe(true);
    });

    it("partial confirms do not override a covered accepted state", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "operator", kind: "confirm", refs: ["d-ui"] },
          {
            role: "agent",
            kind: "summary",
            text: "phase complete",
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

    it("agent confirm refs do not rescue uncovered accepted state", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          {
            role: "agent",
            kind: "confirm",
            refs: ["d-ui", "d-api", "d-auth"],
            text: "agent self-confirm",
          },
          {
            role: "agent",
            kind: "summary",
            text: "phase complete",
            refs: ["planning-full"],
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        }),
        assertions: [{ pain: "P2", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === FALSE_PHASE_COMPLETION)).toBe(true);
    });

    it("alternate completion wording still establishes boundary and claim", () => {
      const drift: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "proposal", refs: ["prop-summary"] },
          {
            role: "agent",
            kind: "summary",
            text: "planning is complete",
            refs: ["planning-full"],
          },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-backend-gap"],
            text: "unsolicited",
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-summary", "prop-backend-gap"],
        }),
        assertions: [{ pain: "P1", expect: "fail" }],
      };
      expect(
        evaluatePhaseBoundaryOracle(drift).failures.some(
          (f) => f.code === PHASE_DRIFT_PROPOSAL_GROWTH,
        ),
      ).toBe(true);

      const unfinished: PhaseBoundaryTranscript = {
        turns: [
          { role: "operator", kind: "confirm", refs: ["d-ui"] },
          {
            role: "agent",
            kind: "summary",
            text: "phase finished",
            refs: ["planning-full"],
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        }),
        assertions: [{ pain: "P2", expect: "fail" }],
      };
      expect(
        evaluatePhaseBoundaryOracle(unfinished).failures.some(
          (f) => f.code === FALSE_PHASE_COMPLETION,
        ),
      ).toBe(true);
    });

    it("wrong destination text does not authorize a different resulting phase", () => {
      const handoff = baseState({
        phaseId: "planning-full",
        acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
      });
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "defer", refs: ["defer-evidence"] },
          { role: "agent", kind: "summary", refs: ["planning-full"], text: "phase complete" },
          { role: "agent", kind: "resume", text: "planning-full" },
          { role: "operator", kind: "answer", text: "move to testing" },
        ],
        handoffState: handoff,
        state: {
          ...handoff,
          phaseId: "implementation",
        },
        assertions: [{ pain: "P3", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === RESUME_DEFERRAL_LOSS)).toBe(true);
    });

    it("negated completion wording is not a claim or boundary", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          { role: "operator", kind: "confirm", refs: ["d-ui"] },
          {
            role: "agent",
            kind: "summary",
            text: "phase not complete — still open",
            refs: ["planning-full"],
          },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-next"],
            text: "legitimate next proposal while unfinished",
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-summary", "prop-next"],
        }),
        assertions: [
          { pain: "P1", expect: "pass" },
          { pain: "P2", expect: "pass" },
        ],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it("operator new-requirement id clears drift; citing existing proposal does not", () => {
      const requested: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "proposal", refs: ["prop-summary"] },
          { role: "agent", kind: "summary", text: "phase complete", refs: ["planning-full"] },
          {
            role: "operator",
            kind: "answer",
            text: "please add offline as a new requirement",
            refs: ["req-offline"],
          },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-offline"],
            text: "adaptive follow-up for offline",
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-summary", "prop-offline"],
        }),
        assertions: [{ pain: "P1", expect: "pass" }],
      };
      expect(evaluatePhaseBoundaryOracle(requested).ok).toBe(true);

      const citesExisting: PhaseBoundaryTranscript = {
        turns: [
          { role: "agent", kind: "proposal", refs: ["prop-summary"] },
          { role: "agent", kind: "summary", text: "phase complete", refs: ["planning-full"] },
          {
            role: "operator",
            kind: "answer",
            text: "looks fine",
            // existing proposal id present in resulting state but not a new requirement
            refs: ["prop-summary"],
          },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-invented"],
            text: "unsolicited after citing existing proposal",
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-summary", "prop-invented"],
        }),
        assertions: [{ pain: "P1", expect: "fail" }],
      };
      expect(
        evaluatePhaseBoundaryOracle(citesExisting).failures.some(
          (f) => f.code === PHASE_DRIFT_PROPOSAL_GROWTH,
        ),
      ).toBe(true);
    });

    it("reconfirmation after covered completion does not invalidate P2", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          {
            role: "operator",
            kind: "confirm",
            refs: ["d-ui", "d-api", "d-auth"],
          },
          {
            role: "agent",
            kind: "summary",
            text: "phase complete",
            refs: ["planning-full"],
          },
          { role: "operator", kind: "confirm", refs: ["d-ui"], text: "reconfirm ui" },
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

    it("no-blockers wording still counts as a completion claim", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          {
            role: "agent",
            kind: "summary",
            text: "no blockers — phase complete",
            refs: ["planning-full"],
          },
          {
            role: "agent",
            kind: "proposal",
            refs: ["prop-invented"],
            text: "unsolicited after no-blockers claim",
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          proposalIds: ["prop-summary", "prop-invented"],
        }),
        assertions: [{ pain: "P1", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === PHASE_DRIFT_PROPOSAL_GROWTH)).toBe(true);
    });

    it("early claim before any operator confirm fails when later confirms arrive", () => {
      const transcript: PhaseBoundaryTranscript = {
        turns: [
          {
            role: "agent",
            kind: "summary",
            text: "phase complete",
            refs: ["planning-full"],
          },
          {
            role: "operator",
            kind: "confirm",
            refs: ["d-ui", "d-api", "d-auth"],
          },
        ],
        state: baseState({
          acceptedDecisionIds: ["d-ui", "d-api", "d-auth"],
          declaredDecisionIds: ["d-ui", "d-api", "d-auth"],
        }),
        assertions: [{ pain: "P2", expect: "fail" }],
      };

      const result = evaluatePhaseBoundaryOracle(transcript);
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.code === FALSE_PHASE_COMPLETION)).toBe(true);
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
