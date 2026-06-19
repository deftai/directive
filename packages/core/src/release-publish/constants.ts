/** Byte-identical argparse --help from scripts/release_publish.py (Python 3.14). */
export const RELEASE_PUBLISH_HELP =
  "usage: release_publish [-h] [--dry-run] [--repo OWNER/REPO]\n" +
  "                       [--project-root PATH]\n" +
  "                       version\n" +
  "\n" +
  "Flip a draft GitHub release to public (#716 safety hardening). Companion to\n" +
  "`task release` -- after reviewing the draft's binaries / notes / asset list,\n" +
  "run `task release:publish -- <version>` to publish.\n" +
  "\n" +
  "positional arguments:\n" +
  "  version              Release version, e.g. 0.21.0 (no leading 'v', strict\n" +
  "                       X.Y.Z).\n" +
  "\n" +
  "options:\n" +
  "  -h, --help           show this help message and exit\n" +
  "  --dry-run            Print the publish plan without invoking gh release\n" +
  "                       edit.\n" +
  "  --repo OWNER/REPO    Override the GitHub repository (default: resolved from\n" +
  "                       `git remote get-url origin`, falling back to\n" +
  "                       'deftai/directive').\n" +
  "  --project-root PATH  Repository root (default: $DEFT_PROJECT_ROOT or the\n" +
  "                       parent of the scripts/ directory).\n";

export const RELEASES_LIST_ENDPOINT_TEMPLATE = "repos/{repo}/releases?per_page=100";
