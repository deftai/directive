/** Deterministic review-monitor gate (#2655). Three-state exit contract. */

export const EXIT_READY = 0;
export const EXIT_NOT_READY = 1;
export const EXIT_CONFIG_ERROR = 2;

export const SCHEMA_VERSION = 1;
export const REVIEW_MONITOR_FILENAME = "review-monitor.json";
export const REVIEW_MONITOR_RELPATH = [".deft", REVIEW_MONITOR_FILENAME] as const;

export const MONITORING_TIER_1 = 1;
export const MONITORING_TIER_2 = 2;
export const MONITORING_TIER_3 = 3;

export const DEFAULT_STALE_MINUTES = 30;

export const REVIEW_MONITOR_HELP =
  "usage: task verify:review-monitor -- --pr <N> [options]\n" +
  "\n" +
  "Fail-closed gate: when Tier 1 (sub-agent primitive available), require a\n" +
  "recorded active review-monitor before the parent may yield, Approach-3\n" +
  "sleep-poll, or claim review ownership (#2655).\n" +
  "\n" +
  "options:\n" +
  "  -h, --help                 Show this help and exit 0\n" +
  "  --pr N                     Pull request number (required unless --help)\n" +
  "  --repo OWNER/REPO          Repository (optional audit field)\n" +
  "  --head-sha SHA             Expected HEAD SHA (optional freshness check)\n" +
  "  --project-root PATH        Project root (default: cwd)\n" +
  "  --call-site SITE           solo | swarm-phase5-6 | swarm-phase6-cascade\n" +
  "  --approach3                Assert Approach 3 (blocking poll) intent\n" +
  "  --approach3-warned         User acknowledged Approach 3 warning (Tier 3 only)\n" +
  "  --json                     Emit structured JSON on stdout\n" +
  "\n" +
  "exit codes:\n" +
  "  0  READY       Tier 1 monitor recorded, or Tier 3 Approach 3 with warning ack\n" +
  "  1  NOT READY   Tier 1 without monitor, or Approach 3 blocked on Tier 1\n" +
  "  2  CONFIG      Usage / path / unreadable state error\n" +
  "\n" +
  "Register a monitor after spawning Approach 1:\n" +
  "  task review-monitor:register -- --pr <N> --monitor-agent-id <id> \\\n" +
  "    --platform-primitive cursor-task|spawn_subagent|start_agent \\\n" +
  "    [--head-sha SHA] [--repo OWNER/REPO]\n";

export const REGISTER_HELP =
  "usage: task review-monitor:register -- --pr <N> --monitor-agent-id <id> \\\n" +
  "       --platform-primitive <primitive> [options]\n" +
  "\n" +
  "Record an active review-monitor after spawning an Approach 1 poller (#2655).\n" +
  "\n" +
  "required:\n" +
  "  --pr N                     Pull request number\n" +
  "  --monitor-agent-id ID      Stable poller agent id / Task handle\n" +
  "  --platform-primitive P     start_agent | spawn_subagent | cursor-task\n" +
  "\n" +
  "options:\n" +
  "  --repo OWNER/REPO          Repository\n" +
  "  --head-sha SHA             HEAD SHA at monitor start\n" +
  "  --project-root PATH        Project root (default: cwd)\n" +
  "  --parent-session-id ID     Optional parent ritual / session id\n" +
  "\n" +
  "exit codes: 0 registered / 2 config error\n";
