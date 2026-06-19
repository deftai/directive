/** Shared platform constants mirroring Python module defaults. */

export const AGENTS_MANAGED_CLOSE = "<!-- /deft:managed-section -->";
export const AGENTS_MANAGED_OPEN_V3_LITERAL = "<!-- deft:managed-section v3 -->";

export const DEV_FALLBACK = "0.0.0-dev";
export const ENV_VAR = "DEFT_RELEASE_VERSION";

export const WINDOWS_RESERVED = new Set<string>([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export const DEFAULT_MAX_LEN = 60;

export const CONTENT_PREFIX_LEN = 60;

export const CONFLICT_HEAD_PREFIX = "<<<<<<< ";
export const CONFLICT_SEP = "=======";
export const CONFLICT_TAIL_PREFIX = ">>>>>>> ";

export const AMBIENT_NONE = "";

export const RUNTIME_MODE_LOCAL_UNSANDBOXED = "local-unsandboxed";
export const RUNTIME_MODE_CURSOR_NATIVE_SANDBOX = "cursor-native-sandbox";
export const RUNTIME_MODE_CLOUD_HEADLESS = "cloud-headless";

export const IDENTITY_REAL_ROOT = "real-root";
export const IDENTITY_SANDBOX_REMAPPED_LOCAL_USER = "sandbox-remapped-local-user";
export const IDENTITY_LOCAL_USER = "local-user";
export const IDENTITY_UNKNOWN = "unknown";
