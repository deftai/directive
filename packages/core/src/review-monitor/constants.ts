/** Deterministic review-monitor gate (#2655 / #2814). Three-state exit contract. */

export const EXIT_READY = 0;
export const EXIT_NOT_READY = 1;
export const EXIT_CONFIG_ERROR = 2;
export const EXIT_CONFLICT = 1;

export const SCHEMA_VERSION = 1;
/** @deprecated Obsolete local ledger (#2814); retained for migration references only. */
export const REVIEW_MONITOR_FILENAME = "review-monitor.json";
/** @deprecated Obsolete local ledger (#2814). */
export const REVIEW_MONITOR_RELPATH = [".deft", REVIEW_MONITOR_FILENAME] as const;

export const REVIEW_OWNER_MARKER_START = "<!-- deft:review-owner -->";
export const REVIEW_OWNER_MARKER_END = "<!-- /deft:review-owner -->";

export const MONITORING_TIER_1 = 1;
export const MONITORING_TIER_2 = 2;
export const MONITORING_TIER_3 = 3;

export const DEFAULT_STALE_MINUTES = 30;

/** `kind:` value marking an advisory pass-open mark rather than an ownership lease (#3607). */
export const PASS_MARKER_KIND = "pass";

/**
 * Advisory pass marks expire on read (#3607). Passes run in minutes, so an hour
 * bounds an abandoned mark without needing a heartbeat.
 */
export const DEFAULT_PASS_STALE_MINUTES = 60;

export const REVIEW_MONITOR_HELP =
  "usage: task verify:review-monitor -- --pr <N> [options]\n" +
  "\n" +
  "Fail-closed gate: when Tier 1 (sub-agent primitive available), require an\n" +
  "unexpired GitHub review-owner lease (`<!-- deft:review-owner -->` sticky\n" +
  "PR comment) before the parent may yield, Approach-3 sleep-poll, or claim\n" +
  "review ownership (#2655 / #2814). Legacy `.deft/review-monitor.json` is\n" +
  "ignored and must not satisfy this gate.\n" +
  "\n" +
  "options:\n" +
  "  -h, --help                 Show this help and exit 0\n" +
  "  --pr N                     Pull request number (required unless --help)\n" +
  "  --repo OWNER/REPO          Repository (optional; inferred from origin)\n" +
  "  --head-sha SHA             Expected HEAD SHA (optional freshness check)\n" +
  "  --project-root PATH        Project root (default: cwd)\n" +
  "  --call-site SITE           solo | swarm-phase5-6 | swarm-phase6-cascade\n" +
  "  --approach3                Assert Approach 3 (blocking poll) intent\n" +
  "  --approach3-warned         User acknowledged Approach 3 warning (Tier 3 only)\n" +
  "  --json                     Emit structured JSON on stdout\n" +
  "\n" +
  "exit codes:\n" +
  "  0  READY       Tier 1 GitHub lease active, or Tier 3 Approach 3 with warning ack\n" +
  "  1  NOT READY   Tier 1 without GitHub lease, or Approach 3 blocked on Tier 1\n" +
  "  2  CONFIG      Usage / path / GitHub fetch error\n" +
  "\n" +
  "Claim a lease after spawning Approach 1:\n" +
  "  task review-monitor:register -- --pr <N> --monitor-agent-id <id> \\\n" +
  "    --platform-primitive cursor-task|claude-agent|spawn_subagent|start_agent|sessions_spawn \\\n" +
  "    [--head-sha SHA] [--repo OWNER/REPO] [--force]\n" +
  "\n" +
  "Release when done:\n" +
  "  task review-monitor:release -- --pr <N> [--monitor-agent-id <id>]\n";

export const REGISTER_HELP =
  "usage: task review-monitor:register -- --pr <N> --monitor-agent-id <id> \\\n" +
  "       --platform-primitive <primitive> [options]\n" +
  "\n" +
  "Claim the PR-anchored review-owner lease via a sticky GitHub PR comment\n" +
  "(`<!-- deft:review-owner -->`). Does not write `.deft/review-monitor.json` (#2814).\n" +
  "\n" +
  "required:\n" +
  "  --pr N                     Pull request number\n" +
  "  --monitor-agent-id ID      Stable poller agent id / Task handle\n" +
  "  --platform-primitive P     start_agent | spawn_subagent | cursor-task |\n" +
  "                             claude-agent (#3134) | sessions_spawn |\n" +
  "                             openclaw-sessions-spawn (#2876)\n" +
  "\n" +
  "options:\n" +
  "  --repo OWNER/REPO          Repository (default: origin / DEFT_TRIAGE_REPO)\n" +
  "  --owner LOGIN              GitHub login for claim (default: gh api user)\n" +
  "  --head-sha SHA             HEAD SHA at monitor start\n" +
  "  --project-root PATH        Project root (default: cwd)\n" +
  "  --parent-session-id ID     Optional parent ritual / session id (audit only)\n" +
  "  --force                    Take over a non-expired foreign lease (loud)\n" +
  "\n" +
  "exit codes: 0 claimed / 1 conflict / 2 config error\n";

export const RELEASE_HELP =
  "usage: task review-monitor:release -- --pr <N> [options]\n" +
  "\n" +
  "End the PR-anchored review-owner lease by editing the sticky GitHub comment\n" +
  "in place (#2814).\n" +
  "\n" +
  "options:\n" +
  "  --pr N                     Pull request number (required)\n" +
  "  --repo OWNER/REPO          Repository (default: origin / DEFT_TRIAGE_REPO)\n" +
  "  --monitor-agent-id ID      Release only when this monitor holds the lease\n" +
  "  --owner LOGIN              Release only when this GitHub login holds the lease\n" +
  "  --project-root PATH        Project root (default: cwd)\n" +
  "\n" +
  "exit codes: 0 released / 1 held-by-other / 2 config error\n";
