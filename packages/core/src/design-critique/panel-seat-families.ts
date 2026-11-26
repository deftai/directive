/**
 * Fail-closed seat composition for N≥3 design-critique panels (#4067).
 *
 * Input is parent-claimed families plus a PATH probe. This does not classify
 * model slugs, and it does not observe live GitHub comments (#3850).
 * It does not observe launchability (#4432).
 * It does not select spend (#4705). evaluateN3LaunchProbe skips when spendN < 3;
 * that skip is not a spend front door.
 * Critic-spawn progress / termination live in critic-spawn-progress.ts (#5478);
 * do not grow evaluateN3LaunchProbe into a watchdog.
 */

export type SeatLauncher = "spawn_subagent" | "grok" | "claude" | "codex" | "agy" | "paste-ready";

export type ClaimedSeat = {
  /** Parent-claimed family at dispatch. Not inferred from a model slug. */
  family: string;
  launcher: SeatLauncher;
};

export type PathProbe = {
  claude: boolean;
  codex: boolean;
  /** Optional so pre-#7245 callers stay valid; refuse paste-ready only when true. */
  agy?: boolean;
};

export type PanelSeatFailureCode = "missing-families" | "same-family" | "paste-ready-first";

export type PanelSeatVerdict =
  | { ok: true }
  | { ok: false; code: PanelSeatFailureCode; remediation: string };

export const SAME_FAMILY_REMEDIATION = "re-seat; do not wait for Stop 5";

export const PASTE_READY_FIRST_REMEDIATION =
  "CLI-spawn the named family's CLI; paste-ready is not the default recovery when the CLI resolves";

function normalizeFamily(family: string): string {
  return family.trim().toLowerCase();
}

export function evaluatePanelSeatComposition(input: {
  claimedSeats: readonly ClaimedSeat[];
  path: PathProbe;
}): PanelSeatVerdict {
  const seats = input.claimedSeats;
  if (seats.length >= 3) {
    const families = seats
      .map((seat) => normalizeFamily(seat.family))
      .filter((name) => name.length > 0);
    if (families.length < 3) {
      return {
        ok: false,
        code: "missing-families",
        remediation: SAME_FAMILY_REMEDIATION,
      };
    }
    if (new Set(families).size < 3) {
      return {
        ok: false,
        code: "same-family",
        remediation: SAME_FAMILY_REMEDIATION,
      };
    }
  }

  for (const seat of seats) {
    if (seat.launcher !== "paste-ready") continue;
    const family = normalizeFamily(seat.family);
    if (
      (family === "claude" && input.path.claude) ||
      (family === "codex" && input.path.codex) ||
      (family === "agy" && input.path.agy === true)
    ) {
      return {
        ok: false,
        code: "paste-ready-first",
        remediation: PASTE_READY_FIRST_REMEDIATION,
      };
    }
  }

  return { ok: true };
}

/** Existing Verification pong prompt. Launch probe reuses it with critic bypass flags. */
export const BENIGN_PONG_PROMPT = "Do not use tools. Reply with the single word: pong";

/** Prefer-A #7245: published agy critic model. Claude / GPT / other Gemini slugs (including retiring gemini-3.8-flash-high) do not discharge. */
export const AGY_CRITIC_MODEL = "gemini-4-hydrogen-high";

/** Published agy launch-probe argv (stdin closed; cwd = arc dest). */
export const AGY_PONG_ARGV = `agy -p "${BENIGN_PONG_PROMPT}" --model gemini-4-hydrogen-high --output-format json --print-timeout 2m --sandbox`;

/** Published agy short-pointer critic argv (stdin closed; cwd = arc dest). */
export const AGY_SHORT_POINTER_ARGV =
  'agy -p "Read and follow <envelope-path>" --model gemini-4-hydrogen-high --output-format json --print-timeout 2m --sandbox';

export function agyModelDischargesSeat(model: string): boolean {
  return model.trim().toLowerCase() === AGY_CRITIC_MODEL;
}

export type AgySeatCompletionInput = {
  /** Recorded pointer-envelope issue-comment URL under AGY_CRITIC_MODEL. */
  commentUrl: string | null;
  model: string;
};

export type AgySeatCompletionVerdict =
  | { ok: true }
  | { ok: false; reason: "model-miss" | "missing-comment-url" };

/** Seat completion requires the pinned model plus one recorded comment URL. */
export function evaluateAgySeatCompletion(input: AgySeatCompletionInput): AgySeatCompletionVerdict {
  if (!agyModelDischargesSeat(input.model)) {
    return { ok: false, reason: "model-miss" };
  }
  const url = input.commentUrl?.trim() ?? "";
  if (url.length === 0) {
    return { ok: false, reason: "missing-comment-url" };
  }
  return { ok: true };
}

export type LaunchProbeArgvClass = "critic-bypass" | "auth-pong" | "envelope";

export type LaunchProbeRecovery = "amend-spend" | "dispatch-fail";

export type LaunchProbeFailureCode = "probe-invalid" | "not-launchable";

export type LaunchProbeHaltToken = "dispatch-fail";

export type LaunchProbeVerdict =
  | { ok: true }
  | {
      ok: false;
      code: LaunchProbeFailureCode;
      recovery: LaunchProbeRecovery;
      haltToken: LaunchProbeHaltToken | null;
    };

export type N3LaunchProbeInput = {
  spendN: number;
  argvClass: LaunchProbeArgvClass;
  prompt: string;
  envelopePath: string | null;
  threadAccess: boolean;
  launchableFamilies: readonly string[];
  onFail: LaunchProbeRecovery;
};

function failLaunchProbe(
  onFail: LaunchProbeRecovery,
  code: LaunchProbeFailureCode,
): LaunchProbeVerdict {
  return {
    ok: false,
    code,
    recovery: onFail,
    haltToken: onFail === "dispatch-fail" ? "dispatch-fail" : null,
  };
}

/**
 * N≥3 launchability is a parent-claimed posture probe (#4432).
 * It does not spawn. evaluatePanelSeatComposition does not call this.
 */
export function evaluateN3LaunchProbe(input: N3LaunchProbeInput): LaunchProbeVerdict {
  if (input.spendN < 3) {
    return { ok: true };
  }

  const prompt = input.prompt.trim();
  const envelopeLike = input.envelopePath !== null || /read and follow/i.test(prompt);
  const probeValid =
    input.argvClass === "critic-bypass" &&
    prompt === BENIGN_PONG_PROMPT &&
    !envelopeLike &&
    input.threadAccess === false;

  if (!probeValid) {
    return failLaunchProbe("dispatch-fail", "probe-invalid");
  }

  const families = input.launchableFamilies
    .map((name) => normalizeFamily(name))
    .filter((name) => name.length > 0);
  if (new Set(families).size < 3) {
    return failLaunchProbe(input.onFail, "not-launchable");
  }

  return { ok: true };
}
