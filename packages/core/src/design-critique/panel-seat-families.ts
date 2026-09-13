/**
 * Fail-closed seat composition for N≥3 design-critique panels (#4067).
 *
 * Input is parent-claimed families plus a PATH probe. This does not classify
 * model slugs, and it does not observe live GitHub comments (#3850).
 * It does not observe launchability (#4432).
 */

export type SeatLauncher = "spawn_subagent" | "grok" | "claude" | "codex" | "paste-ready";

export type ClaimedSeat = {
  /** Parent-claimed family at dispatch. Not inferred from a model slug. */
  family: string;
  launcher: SeatLauncher;
};

export type PathProbe = {
  claude: boolean;
  codex: boolean;
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
    if ((family === "claude" && input.path.claude) || (family === "codex" && input.path.codex)) {
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
