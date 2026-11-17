/**
 * Release through a PR (#6296 Bound items 1 and 2).
 *
 * The cut runs on a fresh `release/v<version>` branch made from the fetched
 * tip of the base branch, pushes that branch, and opens a release PR that
 * merges through the merge queue like every PR. No push updates the base
 * branch and no policy switch is needed. `task release -- --finish <version>`
 * (finish.ts) tags the merged commit afterwards.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocsImpactDeclaration } from "../docs/docs-impact.js";
import { containedWrite } from "../fs/contained-write.js";
import { resolveGh } from "./gh.js";
import { runGit } from "./git.js";
import { spawnText } from "./spawn.js";
import type { ReleaseSeams } from "./types.js";

/** Prefix of the release branch: `release/v<version>`. */
export const RELEASE_BRANCH_PREFIX = "release/v";

/** The flag that keeps today's base-branch run with the atomic push. */
export const BREAK_GLASS_FLAG = "--break-glass";

export function releaseBranchName(version: string): string {
  return `${RELEASE_BRANCH_PREFIX}${version}`;
}

/** Command that makes the release branch from the fetched base tip. */
export function releaseBranchCreateCommand(version: string, baseBranch: string): string {
  return `git fetch origin ${baseBranch} && git switch -c ${releaseBranchName(version)} origin/${baseBranch}`;
}

/** Recovery for a release branch left by an earlier attempt (Bound item 7). */
export function releaseBranchRecovery(version: string, baseBranch: string): string {
  const branch = releaseBranchName(version);
  return (
    `recovery: close the open release PR for ${branch} if there is one, delete the branch ` +
    `(git switch ${baseBranch} && git branch -D ${branch}; git push origin --delete ${branch} ` +
    `if it was pushed), then run the cut again from a fresh branch: ` +
    releaseBranchCreateCommand(version, baseBranch)
  );
}

export type ReleaseBranchCheck =
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly reason: string; readonly config: boolean };

/**
 * Step 2 (#6296 item 1): the cut runs only on `release/v<version>` at the
 * fetched base tip. The base branch and every other branch are refused (the
 * break-glass flag is the caller's), and so is a release branch that already
 * exists on the remote or no longer sits at the base tip (an earlier attempt).
 */
export function checkReleaseBranch(
  projectRoot: string,
  version: string,
  baseBranch: string,
  branch: string,
  seams: ReleaseSeams = {},
): ReleaseBranchCheck {
  const expected = releaseBranchName(version);
  if (branch !== expected) {
    return {
      ok: false,
      config: false,
      reason:
        `on '${branch}'; the cut runs on ${expected} made from the fetched ${baseBranch} tip: ` +
        `${releaseBranchCreateCommand(version, baseBranch)} ` +
        `(the base-branch run is break-glass only: ${BREAK_GLASS_FLAG})`,
    };
  }
  const fetch = runGit(projectRoot, ["fetch", "origin", baseBranch], seams);
  if (fetch.status !== 0) {
    return {
      ok: false,
      config: true,
      reason: `git fetch origin ${baseBranch} failed: ${fetch.stderr.trim()}`,
    };
  }
  const remote = runGit(projectRoot, ["ls-remote", "--heads", "origin", expected], seams);
  if (remote.status !== 0) {
    return {
      ok: false,
      config: true,
      reason: `git ls-remote origin ${expected} failed: ${remote.stderr.trim()}`,
    };
  }
  if (remote.stdout.trim().length > 0) {
    return {
      ok: false,
      config: false,
      reason:
        `${expected} already exists on origin (left by an earlier attempt); ` +
        releaseBranchRecovery(version, baseBranch),
    };
  }
  const head = runGit(projectRoot, ["rev-parse", "HEAD"], seams);
  const tip = runGit(projectRoot, ["rev-parse", `origin/${baseBranch}`], seams);
  if (head.status !== 0 || tip.status !== 0) {
    return {
      ok: false,
      config: true,
      reason: `git rev-parse failed: ${(head.status !== 0 ? head : tip).stderr.trim()}`,
    };
  }
  const headSha = head.stdout.trim();
  const tipSha = tip.stdout.trim();
  if (headSha !== tipSha) {
    return {
      ok: false,
      config: false,
      reason:
        `${expected} is at ${headSha.slice(0, 12)}, not at the fetched origin/${baseBranch} tip ` +
        `${tipSha.slice(0, 12)} (left by an earlier attempt, or ${baseBranch} moved); ` +
        releaseBranchRecovery(version, baseBranch),
    };
  }
  return { ok: true, reason: `on ${expected} at the fetched origin/${baseBranch} tip` };
}

/** Command that finishes the release after the release PR merged. */
export function finishCommand(version: string): string {
  return `task release -- --finish ${version}`;
}

/** Title of the release PR. */
export function releasePrTitle(version: string): string {
  return `chore(release): v${version}`;
}

/**
 * Generated release PR body (#6296 item 2): the version, the
 * documentation-impact declaration `verify:docs-impact` accepts, and no
 * closing keyword. Release notes are not copied into the body.
 */
export function buildReleasePrBody(version: string, baseBranch: string): string {
  return (
    "## Summary\n" +
    "\n" +
    `Release v${version}: promotes \`[Unreleased]\` to \`## [${version}]\` in CHANGELOG.md, ` +
    "rewrites ROADMAP.md and removes the released changelog.d/ fragments. " +
    `The release line \`- [release-line] v${version}\` stays under \`[Unreleased]\`.\n` +
    "\n" +
    `Merge this PR through the merge queue into ${baseBranch}, then tag the merged commit:\n` +
    "\n" +
    "```\n" +
    `${finishCommand(version)}\n` +
    "```\n" +
    "\n" +
    "## Documentation impact\n" +
    "\n" +
    "change_class: none\n" +
    "surfaces: none\n" +
    `rationale: "Release PR for v${version}: CHANGELOG.md and ROADMAP.md only; no command, skill, help key or docs page changes."\n`
  );
}

/** Problems that keep a body from passing the docs-impact parse (empty = ok). */
export function releasePrBodyProblems(body: string): string[] {
  return parseDocsImpactDeclaration(body).errors;
}

/** Push the release branch only (never the base branch). */
export function pushReleaseBranch(
  projectRoot: string,
  version: string,
  seams: ReleaseSeams = {},
): [boolean, string] {
  const branch = releaseBranchName(version);
  const result = runGit(projectRoot, ["push", "-u", "origin", branch], seams);
  if (result.status !== 0) {
    return [false, `git push origin ${branch} failed: ${result.stderr.trim()}`];
  }
  return [true, `pushed ${branch} to origin`];
}

/** Open the release PR with the generated body; returns the PR URL. */
export function openReleasePr(
  projectRoot: string,
  version: string,
  repo: string,
  baseBranch: string,
  seams: ReleaseSeams = {},
): [boolean, string] {
  const ghPath = resolveGh(seams);
  if (ghPath === null) {
    return [false, "gh CLI not found on PATH"];
  }
  const body = buildReleasePrBody(version, baseBranch);
  const problems = releasePrBodyProblems(body);
  if (problems.length > 0) {
    return [false, `generated release PR body fails the docs-impact parse: ${problems.join("; ")}`];
  }
  const dir = mkdtempSync(join(tmpdir(), "deft-release-pr-"));
  const bodyFile = join(dir, "body.md");
  try {
    containedWrite({ root: dir, target: "body.md", data: body, mode: "create" });
    const spawn = seams.spawnText ?? spawnText;
    const result = spawn(
      ghPath,
      [
        "pr",
        "create",
        "--repo",
        repo,
        "--base",
        baseBranch,
        "--head",
        releaseBranchName(version),
        "--title",
        releasePrTitle(version),
        "--body-file",
        bodyFile,
      ],
      { cwd: projectRoot, timeoutMs: 60_000, env: { ...process.env } },
    );
    if (result.status !== 0) {
      return [false, `gh pr create failed: ${result.stderr.trim()}`];
    }
    const url = result.stdout.trim().split(/\r?\n/).pop() ?? "";
    return [true, url.length > 0 ? `opened ${url}` : "opened the release PR"];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
