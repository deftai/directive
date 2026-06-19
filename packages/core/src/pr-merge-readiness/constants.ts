export const EXIT_OK = 0;
export const EXIT_MERGE_BLOCKED = 1;
export const EXIT_EXTERNAL_ERROR = 2;

export const GREPTILE_LOGIN = "greptile-apps[bot]";

export const GREPTILE_ERRORED_SENTINEL = "Greptile encountered an error while reviewing this PR";

export const LAST_REVIEWED_RE =
  /Last reviewed commit:\s*\[[^\]]*\]\(https?:\/\/github\.com\/[^/]+\/[^/]+\/commit\/(?<sha>[0-9a-f]{7,40})/g;

export const CONFIDENCE_RE = /Confidence Score:\s*(?<score>\d+)\s*\/\s*5/i;

export const P0_BADGE = '<img alt="P0"';
export const P1_BADGE = '<img alt="P1"';

export const SECTION_RE = /###\s+(?<sev>P[012])\s+findings\s*\((?<count>\d+)\)/gi;

export const INFORMAL_CLEAN_SIGNAL_RE =
  /(?:diff is clean|(?:prior |previously flagged )?issues? (?:are )?now resolved|all prior issues resolved|no new issues(?: to flag)?|looks solid|good to proceed)/i;

export const INFORMAL_CLEAN_STATE = "informal-clean missing-canonical-fields";

export const INFORMAL_CLEAN_DIAGNOSTIC =
  `Greptile ${INFORMAL_CLEAN_STATE} state (#1543): the latest Greptile bot ` +
  "comment says the diff is clean / prior issues are resolved, but omits the " +
  "canonical rolling-summary fields `Last reviewed commit:` and " +
  "`Confidence Score: X/5` that merge gates require. Prose alone cannot " +
  "prove review currency or confidence. Recovery: (1) comment " +
  "`@greptileai review` on the PR to retrigger a canonical rolling summary, " +
  "(2) wait for Greptile to edit its primary summary comment with both " +
  "canonical fields on the current HEAD, or (3) document an explicit " +
  "operator override per skills/deft-directive-swarm/SKILL.md Phase 6 " +
  "Step 1. Do NOT keep polling -- this is not 'review still writing'.";

export const VIA_PRIMARY = "primary";
export const VIA_FALLBACK1 = "fallback1";
export const VIA_FALLBACK2 = "fallback2";
export const VIA_ERROR = "error";

export const FALLBACK2_NOT_CLEAN_MSG =
  "fallback2 is a coarse signal, not a CLEAN verdict -- the Greptile " +
  "rolling-summary comment was not reachable on either the primary or " +
  "fallback1 path. PR state / check-runs reported below as a heartbeat " +
  "only; do NOT merge on this verdict alone (#1368).";

export const GH_TIMEOUT_S = 60;
