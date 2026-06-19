/** Allowed `<namespace>` argv[0] -- the v1 stub only exposes `issue`. */
export const ALLOWED_NAMESPACES = ["issue"] as const;

/** Source-aware shim (#1145 / N5) supported sources. */
export const SUPPORTED_CALL_SOURCES = ["github-issue"] as const;

/** Allowed `<verb>` argv[1] for the `issue` namespace. */
export const ALLOWED_ISSUE_VERBS = ["list", "view", "close", "edit"] as const;

/** Binary preference order (#884). */
export const BINARY_PREFERENCE = ["ghx", "gh"] as const;

/** Verbs that support the `--rest` opt-in. */
export const REST_OPT_IN_VERBS = ["view", "list"] as const;
