/** Exit codes mirroring scripts/release_e2e.py (via scripts/release.py). */
export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_CONFIG_ERROR = 2;

export const DEFAULT_OWNER = "deftai";
export const REPO_SLUG_PREFIX = "deftai-release-test-";

/** Fixed sentinel rehearsal version (#720). */
export const REHEARSAL_VERSION = "0.0.1";

/**
 * #1910: dependency order for the npm publish dry-run rehearsal, mirroring
 * .github/workflows/npm-publish.yml (types -> core -> content -> cli).
 */
export const NPM_PUBLISH_PACKAGES = ["types", "core", "content", "cli"] as const;
/** #1925: throwaway dist-tag so dry-run does not apply `latest` to 0.0.1. */
export const NPM_E2E_REHEARSAL_TAG = "e2e-rehearsal";
export const NPM_INSTALL_TIMEOUT_SECONDS = 600;
export const NPM_BUILD_TIMEOUT_SECONDS = 600;
export const NPM_PUBLISH_DRYRUN_TIMEOUT_SECONDS = 180;

export const RELEASE_ENTRYPOINT_TIMEOUT_SECONDS = 600.0;
export const ROLLBACK_ENTRYPOINT_TIMEOUT_SECONDS = 300.0;
export const ENTRYPOINT_TIMEOUT_EXIT_CODE = 124;

/** Byte-identical --help from scripts/release_e2e.py (Python 3.12 argparse). */
export const RELEASE_E2E_HELP =
  "usage: release_e2e [-h] [--owner OWNER] [--dry-run] [--keep-repo]\n" +
  "                   [--project-root PATH] [--skip-npm]\n" +
  "\n" +
  "End-to-end release rehearsal against an auto-created+destroyed temp GitHub\n" +
  "repo (#716 safety hardening Q1).\n" +
  "\n" +
  "options:\n" +
  "  -h, --help           show this help message and exit\n" +
  "  --owner OWNER        GitHub owner under which to create the temp repo\n" +
  "                       (default: deftai).\n" +
  "  --dry-run            Print the pipeline plan without invoking gh.\n" +
  "  --keep-repo          Skip destroying the temp repo at the end (use only when\n" +
  "                       manually debugging a failed rehearsal; remember to\n" +
  "                       clean up by hand).\n" +
  "  --project-root PATH  Repository root (default: $DEFT_PROJECT_ROOT or\n" +
  "                       scripts/.. ).\n" +
  "  --skip-npm           Skip the npm publish dry-run rehearsal step (#1910).\n" +
  "                       The step installs + builds the workspace, which exceeds\n" +
  "                       the <90s fast budget that --skip-ci/--skip-build\n" +
  "                       protect; use this to keep the rehearsal fast. The step\n" +
  "                       also soft-skips on its own when npm is absent from\n" +
  "                       PATH.\n";
