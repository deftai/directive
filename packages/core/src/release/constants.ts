/** Exit codes mirroring scripts/release.py. */
export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_CONFIG_ERROR = 2;

export const DEFAULT_REPO = "deftai/directive";
export const DEFAULT_BASE_BRANCH = "master";

export const UPGRADE_BANNER_RELPATH = ".github/release-notes/upgrade-banner.md";

export const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const TAG_RE = /^v(\d+\.\d+\.\d+)$/;
export const UNRELEASED_RE = /^##\s+\[Unreleased\]\s*$/m;
export const UNRELEASED_LINK_RE =
  /^\[Unreleased\]:\s+https?:\/\/github\.com\/[^/]+\/[^/]+\/compare\/v(?<prev>\d+\.\d+\.\d+)\.\.\.HEAD\s*$/m;

export const FRESH_UNRELEASED_BLOCK =
  "## [Unreleased]\n" +
  "\n" +
  "### Added\n" +
  "\n" +
  "### Changed\n" +
  "\n" +
  "### Fixed\n" +
  "\n" +
  "### Removed\n";

export const TOTAL_STEPS = 13;

export const VERIFY_DRAFT_MAX_ATTEMPTS = 5;
export const VERIFY_DRAFT_INTERVAL_SECONDS = 1.0;

export const RELEASE_ARTIFACTS = [
  "CHANGELOG.md",
  "ROADMAP.md",
  "pyproject.toml",
  "uv.lock",
] as const;

export const BRANCH_GATE_BYPASS_ENV = "DEFT_ALLOW_DEFAULT_BRANCH_COMMIT";
export const DESTRUCTIVE_GH_GATE_BYPASS_ENV = "DEFT_ALLOW_DESTRUCTIVE_GH_VERBS";

export const PYPROJECT_VERSION_LINE_RE = /version\s*=\s*"[^"]*"/;

/** Byte-identical argparse --help from scripts/release.py (Python 3.12). */
export const RELEASE_HELP =
  "usage: release [-h] [--dry-run] [--skip-tag] [--skip-release] [--allow-dirty]\n" +
  "               [--allow-vbrief-drift] [--skip-ci] [--skip-build] [--no-draft]\n" +
  "               [--repo OWNER/REPO] [--base-branch BRANCH]\n" +
  "               [--project-root PATH] [--summary TEXT]\n" +
  "               version\n" +
  "\n" +
  "Automate the v0.X.Y release flow (#74): pre-flight, CI, CHANGELOG promote,\n" +
  "ROADMAP refresh, build, tag, push, gh release. Halt-friendly: supports --dry-\n" +
  "run / --skip-tag / --skip-release for safe rehearsals.\n" +
  "\n" +
  "positional arguments:\n" +
  "  version               Release version, e.g. 0.21.0 (no leading 'v', strict\n" +
  "                        X.Y.Z).\n" +
  "\n" +
  "options:\n" +
  "  -h, --help            show this help message and exit\n" +
  "  --dry-run             Print the full release plan without writing files or\n" +
  "                        invoking external commands.\n" +
  "  --skip-tag            Do not invoke git tag / git push origin <tag> (still\n" +
  "                        updates CHANGELOG).\n" +
  "  --skip-release        Do not invoke gh release create.\n" +
  "  --allow-dirty         Bypass the dirty-tree pre-flight (use only for\n" +
  "                        rehearsals).\n" +
  "  --allow-vbrief-drift  Bypass the vBRIEF-lifecycle sync pre-flight gate\n" +
  "                        (#734). Use only when the operator has reviewed the\n" +
  "                        drift and explicitly accepts that closed-issue vBRIEFs\n" +
  "                        may still live in non-terminal folders. The clean path\n" +
  "                        is to run `task reconcile:issues -- --apply-lifecycle-\n" +
  "                        fixes` first.\n" +
  "  --skip-ci             Skip Step 3 (task ci:local / task check fallback).\n" +
  "                        Used by `task release:e2e` to keep wall-clock\n" +
  "                        manageable inside the auto-created temp repo (CI\n" +
  "                        semantics are covered by the unit-test suite, not the\n" +
  "                        e2e rehearsal).\n" +
  "  --skip-build          Skip Step 6 (task build). Used by `task release:e2e`\n" +
  "                        to keep wall-clock manageable; build artefacts are not\n" +
  "                        needed for the draft-release verification step.\n" +
  "  --no-draft            Publish the GitHub release immediately instead of\n" +
  "                        creating a draft (default: --draft, paired with `task\n" +
  "                        release:publish -- <version>`).\n" +
  "  --repo OWNER/REPO     Override the GitHub repository (default: resolved from\n" +
  "                        `git remote get-url origin`, falling back to\n" +
  "                        'deftai/directive').\n" +
  "  --base-branch BRANCH  Expected base branch for releases (default: master).\n" +
  "  --project-root PATH   Repository root (default: $DEFT_PROJECT_ROOT or the\n" +
  "                        parent of the scripts/ directory).\n" +
  "  --summary TEXT        Optional one-line summary to inject as a Markdown\n" +
  "                        blockquote at the top of the promoted CHANGELOG\n" +
  "                        section. Flows through to the GitHub release body and\n" +
  "                        the Slack announcement template (Phase 8). Recommended\n" +
  "                        length 80-160 chars.\n";
