import { RELEASE_PUBLISH_HELP } from "./constants.js";
import type { PublishFlags } from "./types.js";

export function formatReleasePublishHelp(): string {
  return RELEASE_PUBLISH_HELP;
}

export function parsePublishFlags(args: readonly string[]): PublishFlags {
  let help = false;
  let dryRun = false;
  let repo: string | null = null;
  let projectRoot: string | null = null;
  let version: string | null = null;
  const unknown: string[] = [];

  const takeValue = (flag: string, i: number): string | null => {
    if (i + 1 >= args.length) {
      unknown.push(`${flag} (missing value)`);
      return null;
    }
    return args[i + 1] ?? null;
  };

  let i = 0;
  while (i < args.length) {
    const token = args[i] ?? "";
    if (token === "-h" || token === "--help") {
      help = true;
    } else if (token === "--dry-run") {
      dryRun = true;
    } else if (token === "--repo") {
      repo = takeValue(token, i);
      if (repo !== null) i += 1;
    } else if (token.startsWith("--repo=")) {
      repo = token.slice("--repo=".length) || null;
      if (!repo) unknown.push("--repo= (empty value)");
    } else if (token === "--project-root") {
      projectRoot = takeValue(token, i);
      if (projectRoot !== null) i += 1;
    } else if (token.startsWith("--project-root=")) {
      projectRoot = token.slice("--project-root=".length) || null;
      if (!projectRoot) unknown.push("--project-root= (empty value)");
    } else if (token.startsWith("-")) {
      unknown.push(token);
    } else if (version === null) {
      version = token;
    } else {
      unknown.push(token);
    }
    i += 1;
  }

  return { help, version, repo, projectRoot, dryRun, unknown };
}

export function formatMissingVersionError(): string {
  return (
    "usage: release_publish [-h] [--dry-run] [--repo OWNER/REPO]\n" +
    "                       [--project-root PATH]\n" +
    "                       version\n" +
    "release_publish: error: the following arguments are required: version\n"
  );
}
