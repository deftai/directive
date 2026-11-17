export const EXIT_OK = 0;
export const EXIT_HITS_FOUND = 1;
export const EXIT_CONFIG_ERROR = 2;

/**
 * The command that writes the story line into a PR body file (#6316). It lives here,
 * not in main.ts: main.ts -> story-issue.ts -> plan-id-adopter.ts reads it at module
 * load, before main.ts's own body runs (#6468). main.ts re-exports it.
 */
export const WRITE_STORY_LINE_COMMAND =
  "task pr:check-closing-keywords -- --body-file <path> --write-story-line [--part]";

export const GH_TIMEOUT_S = 30;
export const WINDOW_RADIUS = 20;
