export const PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json";
export const CACHE_DIR_NAME = ".deft-cache";
export const CACHE_SOURCE = "github-issue";
export const CANDIDATES_RELPATH = ["vbrief", ".eval", "candidates.jsonl"] as const;
export const WIP_LIFECYCLE_DIRS = ["pending", "active"] as const;
export const AUDIT_LOG_REL_PATH = "meta/policy-changes.log";
export const DEFAULT_WIP_CAP = 10;
export const DEFAULT_RELIEF_AGE_DAYS = 30;
export const TRIAGE_SKILL_PATH = "skills/deft-directive-triage/SKILL.md";
export const WELCOME_AUDIT_TAG = "triage-welcome";
export const SUMMARY_HISTORY_REL_PATH = "vbrief/.eval/summary-history.jsonl";
export const SUMMARY_HISTORY_SCHEMA = "deft.triage.summary.v1";
export const EMPTY_CACHE_LINE = "[triage] cache empty -- run task triage:bootstrap";
export const MAX_LINE_CHARS = 120;
export const WIP_WARN_GLYPH = "\u26a0";

export const FIRST_TIME_NUDGE =
  "[welcome] First-time? Run `deft triage:welcome --onboard` to set up triage.";

export const INCOMPLETE_NUDGE_TEMPLATE =
  "[welcome] Onboarding incomplete: {missing}. Run `deft triage:welcome --onboard` to resume.";

export const SUBSCRIPTION_PRESETS: Readonly<
  Record<string, ReadonlyArray<Record<string, unknown>>>
> = {
  small: [{ rule: "all-open" }],
  mid: [
    { rule: "labels", "any-of": ["urgent", "breaking", "security", "p0", "p1"] },
    { rule: "opened-since", duration: "60d" },
  ],
  mega: [
    { rule: "explicit-watch", issues: [] },
    { rule: "referenced-by-vbrief", scope: "active" },
  ],
};

export const BOOTSTRAP_ACTION_RAN = "ran";
export const BOOTSTRAP_ACTION_SKIPPED_ALREADY_BOOTSTRAPPED = "skipped:already-bootstrapped";
export const BOOTSTRAP_ACTION_SKIPPED_DECLINED = "skipped:declined";
export const BOOTSTRAP_ACTION_SKIPPED_DRY_MODE = "skipped:dry-mode";

export const DEFAULT_PENDING_DECISIONS_THRESHOLD = 3;
