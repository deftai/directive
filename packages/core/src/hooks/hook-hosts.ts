/**
 * Hook host names (leaf module, no imports). `dispatcher.ts` re-exports them.
 * Kept separate so modules the dispatcher imports, directly or through the
 * ownership API, can name the hosts without importing the dispatcher (#5771).
 */

export const HOOK_HOSTS = ["claude", "grok", "cursor", "codex", "agy"] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];
