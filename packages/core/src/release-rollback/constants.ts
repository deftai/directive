/** Exit codes mirroring scripts/release_rollback.py (via release.py). */
export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_CONFIG_ERROR = 2;

/** Download-count guard time windows (seconds). */
export const FIVE_MINUTES_SECONDS = 5 * 60;
export const THIRTY_MINUTES_SECONDS = 30 * 60;

/** Default threshold inside the 5-30 minute window. */
export const DEFAULT_BOT_THRESHOLD = 10;

/** Race-condition double-read sleep duration. */
export const DOUBLE_READ_SLEEP_SECONDS = 5;

/** Subject prefix for the auto-generated release-prep commit. */
export const RELEASE_COMMIT_SUBJECT_PREFIX = "chore(release): v";

/** Short usage line emitted by argparse on parse errors (not full --help). */
export const ROLLBACK_USAGE_SHORT =
  "usage: release_rollback [-h] [--dry-run] [--repo OWNER/REPO]\n" +
  "                        [--base-branch BRANCH] [--project-root PATH]\n" +
  "                        [--allow-low-downloads N] [--allow-data-loss]\n" +
  "                        [--force-strict-0]\n" +
  "                        version\n";

/** Byte-identical argparse --help from scripts/release_rollback.py (Python 3.12). */
export const ROLLBACK_HELP =
  "usage: release_rollback [-h] [--dry-run] [--repo OWNER/REPO]\n" +
  "                        [--base-branch BRANCH] [--project-root PATH]\n" +
  "                        [--allow-low-downloads N] [--allow-data-loss]\n" +
  "                        [--force-strict-0]\n" +
  "                        version\n" +
  "\n" +
  "State-aware release unwind (#716 safety hardening). Detects one of four post-\n" +
  "release states (local-only / tag-pushed / released-low-downloads / released-\n" +
  "high-downloads) and applies the matching tiered recovery.\n" +
  "\n" +
  "positional arguments:\n" +
  "  version               Release version, e.g. 0.21.0 (no leading 'v', strict\n" +
  "                        X.Y.Z).\n" +
  "\n" +
  "options:\n" +
  "  -h, --help            show this help message and exit\n" +
  "  --dry-run             Print the rollback plan without invoking gh / git\n" +
  "                        side-effects.\n" +
  "  --repo OWNER/REPO     Override repo (default: resolved from `git remote get-\n" +
  "                        url origin`).\n" +
  "  --base-branch BRANCH  Base branch (default: master).\n" +
  "  --project-root PATH   Repository root (default: $DEFT_PROJECT_ROOT or\n" +
  "                        scripts/.. ).\n" +
  "  --allow-low-downloads N\n" +
  "                        Accept up to N downloads (defaults to the time-window-\n" +
  "                        derived value). The maximum of this flag and the time-\n" +
  "                        window default wins, so passing N=5 with a 10-min-old\n" +
  "                        release still allows up to 10.\n" +
  "  --allow-data-loss     Accept any download count; explicit acknowledgment of\n" +
  "                        consumer impact. Required when the release is > 30\n" +
  "                        minutes old.\n" +
  "  --force-strict-0      Override the time-window: require exactly 0 downloads\n" +
  "                        regardless of release age. Use for security-incident\n" +
  "                        hot-rollbacks where even bot scrapes are unacceptable.\n";
