/** Default slices log path relative to project root. */
export const DEFAULT_SLICES_LOG_REL_PATH = "vbrief/.eval/slices.jsonl";

export const ENV_PROJECT_ROOT = "DEFT_PROJECT_ROOT";
export const ENV_PROJECT_REPO = "DEFT_PROJECT_REPO";

export const DEFAULT_ACTOR = "manual:operator";
export const DEFAULT_EXPECTED_CLOSE_SIGNAL = "all-children-merged";
export const DEFAULT_ROLE = "manual";

export const VALID_EXPECTED_CLOSE_SIGNALS = new Set([
  "all-children-merged",
  "wave-1-merged",
  "manual",
]);

export const REQUIRED_FIELDS = [
  "slice_id",
  "umbrella",
  "umbrella_url",
  "sliced_at",
  "actor",
  "children",
  "expected_close_signal",
] as const;

export const OPTIONAL_FIELDS = ["notes"] as const;

export const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

export const CHILD_REQUIRED_FIELDS = ["n", "url", "wave", "role"] as const;

export const CHILD_ALLOWED_FIELDS = new Set(CHILD_REQUIRED_FIELDS);

export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const WAVE_FLAG_RE = /^--wave-(\d+)(?:=(.*))?$/;

export const PROJECT_ROOT_SENTINELS = ["vbrief", ".git"] as const;
