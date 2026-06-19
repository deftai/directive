/** Framework default when plan.policy.triageScope is unset (#1131). */
export const DEFAULT_TRIAGE_SCOPE: ReadonlyArray<Record<string, unknown>> = [{ rule: "all-open" }];

export const PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json";
export const CACHE_DIR_NAME = ".deft-cache";
export const COVERAGE_FILENAME = "coverage.json";
export const ENV_COVERAGE_TTL_HOURS = "DEFT_COVERAGE_MAX_AGE_HOURS";
export const DEFAULT_COVERAGE_TTL_HOURS = 24;
export const SUBSCRIPTION_HASH_LEN = 16;

export const VALID_RULE_TYPES = new Set([
  "all-open",
  "labels",
  "milestone",
  "opened-since",
  "updated-since",
  "referenced-by-vbrief",
  "sliced-from",
  "explicit-watch",
]);

export const VALID_IGNORE_KEYS = new Set(["label", "milestone"]);
export const VALID_IGNORE_RULES = new Set(["author"]);

export const REFERENCED_BY_VBRIEF_SCOPES = new Set(["any", "active"]);
export const SLICED_FROM_SCOPES = new Set(["any-umbrella-in-cache"]);

export const SUBSCRIPTION_HISTORY_REL_PATH = "vbrief/.eval/subscription-history.jsonl";
export const SUBSCRIPTION_HISTORY_SCHEMA = "deft.triage.subscription-change.v1";
