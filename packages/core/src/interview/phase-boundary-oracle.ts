/**
 * Interview phase-boundary behavioral oracle (#5355).
 *
 * Closed multi-turn transcript evaluator for:
 * - P1 phase-drift proposal growth after an agreed phase-complete boundary
 * - P2 false phase completion without declared-decision coverage
 * - P3 resume/handoff that drops deferred ids or rewrites phase
 *
 * Detection boundary: in-process transcript/state fixtures only. Host chat
 * logs are out of band unless an adapter maps them into this I/O.
 *
 * Companions #5351–#5354 own normative workflow / completion / handoff prose.
 * This module pins oracle I/O + closed fail codes only — it does not invent
 * conflicting decision-boundary MUST text. validateSpec stays schema-only;
 * requirements write gates stay occupancy/path/auth.
 */

/** Closed fail token: post-boundary proposal/prerequisite growth (P1). */
export const PHASE_DRIFT_PROPOSAL_GROWTH = "PHASE_DRIFT_PROPOSAL_GROWTH" as const;

/** Closed fail token: completion claim without declared-decision coverage (P2). */
export const FALSE_PHASE_COMPLETION = "FALSE_PHASE_COMPLETION" as const;

/** Closed fail token: resume drops deferrals or rewrites phase (P3). */
export const RESUME_DEFERRAL_LOSS = "RESUME_DEFERRAL_LOSS" as const;

export type PhaseBoundaryPain = "P1" | "P2" | "P3";
export type PhaseBoundaryExpect = "fail" | "pass";
export type PhaseBoundaryRole = "operator" | "agent";
export type PhaseBoundaryTurnKind =
  | "question"
  | "answer"
  | "confirm"
  | "proposal"
  | "defer"
  | "resume"
  | "summary";

export interface PhaseBoundaryTurn {
  readonly role: PhaseBoundaryRole;
  readonly kind: PhaseBoundaryTurnKind;
  readonly text?: string;
  readonly refs?: readonly string[];
}

/**
 * Carrier fields required for P2/P3 (and proposal growth checks for P1).
 * `declaredDecisionIds` is the closed declared decision set for the current
 * phase — required for mechanical P2 false-completion.
 */
export interface PhaseBoundaryState {
  readonly phaseId: string;
  readonly acceptedDecisionIds: readonly string[];
  readonly declaredDecisionIds: readonly string[];
  readonly deferredIds: readonly string[];
  readonly proposalIds: readonly string[];
}

export interface PhaseBoundaryAssertion {
  readonly pain: PhaseBoundaryPain;
  readonly expect: PhaseBoundaryExpect;
}

/**
 * Closed multi-turn transcript object (not a live chat scrape).
 *
 * Optional `handoffState` is the carrier snapshot at handoff (immediately
 * before the first `resume` turn). When omitted, handoff deferred ids are
 * derived from pre-resume `defer` turns' refs and handoff `phaseId` from the
 * last pre-resume `summary` refs[0] when present, else from resulting `state`.
 */
export interface PhaseBoundaryTranscript {
  readonly turns: readonly PhaseBoundaryTurn[];
  /** Resulting state after the transcript (post-resume when a resume exists). */
  readonly state: PhaseBoundaryState;
  readonly assertions: readonly PhaseBoundaryAssertion[];
  readonly handoffState?: PhaseBoundaryState;
}

export interface PhaseBoundaryFailure {
  readonly pain: PhaseBoundaryPain;
  readonly code: string;
  readonly detail: string;
}

export interface PhaseBoundaryResult {
  readonly ok: boolean;
  readonly failures: readonly PhaseBoundaryFailure[];
}

function covers(accepted: readonly string[], declared: readonly string[]): boolean {
  const set = new Set(accepted);
  return declared.every((id) => set.has(id));
}

/** Agent summary that asserts phase completion (not a progress-only interim). */
function isCompletionClaim(turn: PhaseBoundaryTurn | undefined): boolean {
  if (!turn || turn.role !== "agent" || turn.kind !== "summary") return false;
  return /phase\s*complete|completed?\s+phase|all\s+decisions|declared-decision\s+coverage|claiming\s+phase\s+complete/i.test(
    turn.text ?? "",
  );
}

/** Affirmative operator text authorizing a phase change (negations do not count). */
function isAffirmativePhaseChangeText(text: string | undefined): boolean {
  const body = text ?? "";
  if (
    /\b(no|not|don't|do\s+not|without|skip|avoid|decline)\b.{0,40}\bphase\s*change\b/i.test(
      body,
    ) ||
    /\bphase\s*change\b.{0,40}\b(not\s+needed|unnecessary|declined)\b/i.test(body)
  ) {
    return false;
  }
  return /\b(new|switch|change)\s+phase\b|\bphase\s*change\b|\bmove\s+to\s+\w[\w-]*/i.test(body);
}

function proposalIdsThrough(
  turns: readonly PhaseBoundaryTurn[],
  endInclusive: number,
): Set<string> {
  const ids = new Set<string>();
  const last = Math.min(endInclusive, turns.length - 1);
  for (let i = 0; i <= last; i += 1) {
    const turn = turns[i];
    if (turn?.kind === "proposal" && turn.refs) {
      for (const ref of turn.refs) ids.add(ref);
    }
  }
  return ids;
}

/**
 * P1: after a recorded phase-complete / agreed-summary boundary, a later agent
 * turn adds a new proposal or prerequisite refs entry that expands proposalIds
 * without an operator-introduced requirement turn.
 */
function detectPhaseDrift(transcript: PhaseBoundaryTranscript): PhaseBoundaryFailure | null {
  const { turns, state } = transcript;
  // First completion claim is the agreed boundary — later summaries must not
  // swallow post-boundary proposal growth into a new baseline.
  let boundaryIdx = -1;
  for (let i = 0; i < turns.length; i += 1) {
    if (isCompletionClaim(turns[i])) {
      boundaryIdx = i;
      break;
    }
  }
  if (boundaryIdx < 0) return null;

  const atBoundary = proposalIdsThrough(turns, boundaryIdx);
  let operatorRequirementAfter = false;

  for (let i = boundaryIdx + 1; i < turns.length; i += 1) {
    const turn = turns[i];
    if (!turn) continue;

    // Only an operator turn that introduces new requirement refs clears the
    // drift gate — ordinary option selections do not.
    if (turn.role === "operator" && (turn.kind === "answer" || turn.kind === "question")) {
      const newReqs = (turn.refs ?? []).filter((ref) => !atBoundary.has(ref));
      if (newReqs.length > 0) {
        operatorRequirementAfter = true;
      }
      continue;
    }

    if (operatorRequirementAfter || turn.role !== "agent") continue;

    const newRefs = (turn.refs ?? []).filter((ref) => !atBoundary.has(ref));
    const stateGrowth = state.proposalIds.filter((id) => !atBoundary.has(id));
    // Empty-refs proposal counts only when resulting state.proposalIds grew.
    const proposalTurnExpands =
      turn.kind === "proposal" && (newRefs.length > 0 || stateGrowth.length > 0);
    const refsExpandProposals =
      newRefs.length > 0 &&
      (turn.kind === "proposal" || newRefs.some((ref) => state.proposalIds.includes(ref)));

    if (proposalTurnExpands || refsExpandProposals) {
      const detailIds = newRefs.length > 0 ? newRefs : stateGrowth;
      if (detailIds.length > 0) {
        return {
          pain: "P1",
          code: PHASE_DRIFT_PROPOSAL_GROWTH,
          detail:
            `After phase-complete summary at turn ${boundaryIdx}, agent expanded ` +
            `proposals (${detailIds.join(", ")}) without an ` +
            "operator-introduced requirement turn.",
        };
      }
    }
  }

  return null;
}

/**
 * P2: completion claim / phase-complete assertion while acceptedDecisionIds
 * does not cover declaredDecisionIds — even if artifacts would pass schema
 * validation and even if a per-answer confirm turn exists.
 * Explicitly not Rule 8 "number entry alone must not advance".
 *
 * Coverage is checked at each completion-claim turn (confirms accumulated so
 * far when any exist; otherwise the fixture `state` carrier). Later confirms
 * must not erase a premature claim.
 */
function detectFalseCompletion(transcript: PhaseBoundaryTranscript): PhaseBoundaryFailure | null {
  const { turns, state } = transcript;
  const acceptedSoFar: string[] = [];
  let sawConfirm = false;
  let sawClaim = false;
  let prematureMissing: string[] | null = null;

  for (const turn of turns) {
    if (turn.kind === "confirm" && turn.refs && turn.refs.length > 0) {
      sawConfirm = true;
      for (const ref of turn.refs) {
        if (!acceptedSoFar.includes(ref)) acceptedSoFar.push(ref);
      }
    }

    if (!isCompletionClaim(turn)) continue;
    sawClaim = true;
    const acceptedAtClaim = sawConfirm ? acceptedSoFar : state.acceptedDecisionIds;
    if (!covers(acceptedAtClaim, state.declaredDecisionIds)) {
      prematureMissing = state.declaredDecisionIds.filter((id) => !acceptedAtClaim.includes(id));
      break;
    }
  }

  if (!sawClaim) return null;

  if (prematureMissing) {
    return {
      pain: "P2",
      code: FALSE_PHASE_COMPLETION,
      detail:
        "Completion claim recorded while acceptedDecisionIds does not cover " +
        `declaredDecisionIds (missing: ${prematureMissing.join(", ") || "(none listed)"}). ` +
        "Schema validity and per-answer confirm are not phase-completion evidence.",
    };
  }

  if (!covers(state.acceptedDecisionIds, state.declaredDecisionIds)) {
    const missing = state.declaredDecisionIds.filter(
      (id) => !state.acceptedDecisionIds.includes(id),
    );
    return {
      pain: "P2",
      code: FALSE_PHASE_COMPLETION,
      detail:
        "Completion claim recorded while acceptedDecisionIds does not cover " +
        `declaredDecisionIds (missing: ${missing.join(", ") || "(none listed)"}). ` +
        "Schema validity and per-answer confirm are not phase-completion evidence.",
    };
  }

  return null;
}

function deriveHandoffState(
  transcript: PhaseBoundaryTranscript,
  resumeIdx: number,
): PhaseBoundaryState {
  if (transcript.handoffState) {
    return transcript.handoffState;
  }

  const deferred = new Set<string>();
  const accepted: string[] = [];
  const declared: string[] = [];
  const proposals: string[] = [];
  // Prefer last pre-resume summary refs[0]; do not let resume text rewrite phase.
  let phaseId = transcript.state.phaseId;
  let sawSummaryPhase = false;

  for (let i = 0; i < resumeIdx; i += 1) {
    const turn = transcript.turns[i];
    if (!turn) continue;
    if (turn.kind === "defer" && turn.refs) {
      for (const ref of turn.refs) deferred.add(ref);
    }
    if (turn.kind === "confirm" && turn.refs) {
      for (const ref of turn.refs) accepted.push(ref);
    }
    if (turn.kind === "proposal" && turn.refs) {
      for (const ref of turn.refs) proposals.push(ref);
    }
    if (turn.kind === "summary" && turn.refs?.[0]) {
      phaseId = turn.refs[0];
      sawSummaryPhase = true;
    }
  }

  const resumeTurn = transcript.turns[resumeIdx];
  if (deferred.size === 0 && resumeTurn?.refs?.length) {
    for (const ref of resumeTurn.refs) deferred.add(ref);
  }
  // Resume text is not a phaseId carrier — keep summary/handoff evidence.
  if (!sawSummaryPhase && !transcript.handoffState) {
    // phaseId stays transcript.state.phaseId when no pre-resume summary refs.
  }

  return {
    phaseId,
    acceptedDecisionIds: accepted.length > 0 ? accepted : [...transcript.state.acceptedDecisionIds],
    declaredDecisionIds: declared.length > 0 ? declared : [...transcript.state.declaredDecisionIds],
    deferredIds: [...deferred],
    proposalIds: proposals,
  };
}

/**
 * P3: resume resulting state drops any id that was in deferredIds at handoff,
 * or changes phaseId away from the handoff phase without an operator
 * phase-change turn.
 */
function detectResumeLoss(transcript: PhaseBoundaryTranscript): PhaseBoundaryFailure | null {
  const { turns, state } = transcript;
  const resumeIdx = turns.findIndex((turn) => turn.kind === "resume");
  if (resumeIdx < 0) return null;

  const handoff = deriveHandoffState(transcript, resumeIdx);

  let operatorPhaseChange = false;
  for (let i = resumeIdx + 1; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn?.role !== "operator") continue;
    if (turn.kind !== "answer" && turn.kind !== "confirm" && turn.kind !== "question") {
      continue;
    }
    // Destination phase ref or affirmative phase-change text — not negations
    // and not ordinary decision confirm refs.
    if (
      (turn.refs ?? []).includes(state.phaseId) ||
      isAffirmativePhaseChangeText(turn.text)
    ) {
      operatorPhaseChange = true;
    }
  }

  const deferredDropped = handoff.deferredIds.filter((id) => !state.deferredIds.includes(id));
  const phaseRewritten = state.phaseId !== handoff.phaseId && !operatorPhaseChange;

  if (deferredDropped.length === 0 && !phaseRewritten) {
    return null;
  }

  const parts: string[] = [];
  if (deferredDropped.length > 0) {
    parts.push(`dropped deferred ids: ${deferredDropped.join(", ")}`);
  }
  if (phaseRewritten) {
    parts.push(
      `phaseId changed ${handoff.phaseId} → ${state.phaseId} without operator phase-change turn`,
    );
  }

  return {
    pain: "P3",
    code: RESUME_DEFERRAL_LOSS,
    detail: `Resume mutated handoff carrier (${parts.join("; ")}).`,
  };
}

const DETECTORS: Record<
  PhaseBoundaryPain,
  (transcript: PhaseBoundaryTranscript) => PhaseBoundaryFailure | null
> = {
  P1: detectPhaseDrift,
  P2: detectFalseCompletion,
  P3: detectResumeLoss,
};

/**
 * Evaluate a closed phase-boundary transcript against its assertion matrix.
 *
 * `assertions` select which pains to evaluate (`expect` documents fixture
 * intent for callers/tests). `failures` lists detected pain violations
 * (closed fail tokens). `ok` is false when any selected pain fires — matching
 * Bound negative fixtures (`ok:false` + fail token) and positive controls
 * (`ok:true`).
 */
export function evaluatePhaseBoundaryOracle(
  transcript: PhaseBoundaryTranscript,
): PhaseBoundaryResult {
  const pains = new Set(transcript.assertions.map((assertion) => assertion.pain));
  const detected: PhaseBoundaryFailure[] = [];

  for (const pain of pains) {
    const failure = DETECTORS[pain](transcript);
    if (failure) detected.push(failure);
  }

  return { ok: detected.length === 0, failures: detected };
}
