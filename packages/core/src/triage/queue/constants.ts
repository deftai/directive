/** Filesystem-relative location of the unified cache root (#883 Story 2). */
export const CACHE_DIR_NAME = ".deft-cache";

/** Cache source layer for upstream GitHub issues. */
export const CACHE_SOURCE_GITHUB_ISSUE = "github-issue";

/** Env var honoured for repo inference when `--repo` is absent (#1238). */
export const ENV_TRIAGE_REPO = "DEFT_TRIAGE_REPO";

/** PROJECT-DEFINITION vBRIEF location for typed-policy lookup. */
export const PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json";

/** Default queue limit when `--limit` is omitted on the CLI surface. */
export const DEFAULT_QUEUE_LIMIT = 25;

/** Default audit log path relative to the deft framework root (candidates_log.REPO_ROOT). */
export const DEFAULT_AUDIT_LOG_REL_PATH = "vbrief/.eval/candidates.jsonl";

/** Default slices log path relative to project root. */
export const DEFAULT_SLICES_LOG_REL_PATH = "vbrief/.eval/slices.jsonl";

/** Group display order (#1128 / D13 / #1286). */
export const GROUP_ORDER = ["ORPHAN", "RESUME", "URGENT", "untriaged", "other", "BLOCKED"] as const;

export type QueueGroup = (typeof GROUP_ORDER)[number];

/** Display labels per group (left-of-issue marker). */
export const GROUP_DISPLAY: Readonly<Record<QueueGroup, string>> = {
  ORPHAN: "[ORPHAN]    ",
  RESUME: "[RESUME]    ",
  URGENT: "[URGENT]    ",
  untriaged: "[untriaged] ",
  other: "[other]     ",
  BLOCKED: "[BLOCKED]   ",
};

/** Framework default for plan.policy.triageRankingLabels[] (empty). */
export const DEFAULT_TRIAGE_RANKING_LABELS: readonly string[] = [];
