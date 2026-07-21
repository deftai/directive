/** Headless / non-interactive detection (#2693 D16). */

export interface HeadlessDetectionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdinIsTTY?: boolean;
}

const CI_MARKERS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "JENKINS_URL",
  "TF_BUILD",
  "CURSOR_CLOUD_AGENT",
  "DEFT_CLOUD_AGENT",
] as const;

/** True when the session should fail-open without interactive prompts (#2693 D16). */
export function isHeadlessSession(options: HeadlessDetectionOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (env.DEFT_HEADLESS === "1" || env.DEFT_HEADLESS === "true") {
    return true;
  }
  for (const key of CI_MARKERS) {
    const val = env[key];
    if (val !== undefined && val !== "" && val !== "0" && val !== "false") {
      return true;
    }
  }
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
  if (stdinIsTTY === false) {
    return true;
  }
  return false;
}
