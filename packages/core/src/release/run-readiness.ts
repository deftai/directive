/**
 * Readiness for `deft release:run` (#6876, #6845 S3 lean item 2).
 *
 * Runs before any write: the Phase 1 checks (clean tree, GitHub usable), the
 * Phase 2 dry run, a free tag, consistent version files and the CI reuse rule
 * of lean item 3. A failed check refuses. Queued PRs and armed auto-merge are
 * reported, never refused. The CI rule only reports here: readiness says that
 * reuse is provisional and how long the full local check can take, and when
 * the rule does not hold it says, before the mint, that the full check will run.
 * #6849: readiness also prints each nightly lane (status, run URL, head SHA),
 * names a lane that is not reusable and why, and prints the command that
 * starts the nightly workflow.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchCheckRunsRest } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import {
  applyNightlyConjunct,
  type CiReuseDecision,
  classifyReleaseInputCleanliness,
  decideCiReuseFromRuns,
  formatCiReuseDecision,
  windowsSuiteSkippedLineForSmokeOnly,
} from "./ci-reuse.js";
import { RELEASE_CHECK_TIMEOUT_MINUTES } from "./constants.js";
import { runGit } from "./git.js";
import {
  evaluateNightlyReuse,
  formatNightlyLanes,
  type NightlyReuse,
  nightlyDispatchCommand,
  windowsSuiteSkippedLine,
} from "./nightly-reuse.js";
import type { ReleaseSeams } from "./types.js";

export type ReadinessStatus = "ok" | "fail" | "report";

export interface ReadinessCheck {
  readonly name: string;
  readonly status: ReadinessStatus;
  readonly detail: string;
}

export interface ReadinessResult {
  /** False when any check failed; reports never make it false. */
  readonly ok: boolean;
  readonly checks: readonly ReadinessCheck[];
  readonly ci: CiReuseDecision;
}

export interface ReadinessInput {
  readonly version: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly projectRoot: string;
  readonly summary: string | null;
}

export interface ReadinessSeams {
  readonly release?: ReleaseSeams;
  readonly runGh?: RunGhFn;
  /** The Phase 2 dry run; production runs the release pipeline with --dry-run. */
  readonly dryRun: (input: ReadinessInput) => number;
  /** Tag availability; production uses the release Step 4 check. */
  readonly tagFree: (version: string, repo: string, projectRoot: string) => [boolean, string];
  readonly readFile?: (path: string) => string;
  readonly listDir?: (path: string) => readonly string[];
  /** #6849 seam: read the nightly lanes for a tree. Production uses evaluateNightlyReuse. */
  readonly evaluateNightly?: (inputTree: string) => NightlyReuse;
  /** #6849 seam: the host platform for the Windows host-boundary line. */
  readonly platform?: NodeJS.Platform;
}

function ghOk(runGh: RunGhFn, args: readonly string[]): { ok: boolean; out: string } {
  const r = runGh(["gh", ...args]);
  return { ok: r.returncode === 0, out: r.returncode === 0 ? r.stdout : r.stderr.trim() };
}

/** Workspace manifests whose `version` must agree (root plus packages/*). */
export function versionFileProblems(
  projectRoot: string,
  version: string,
  readFile: (path: string) => string,
  listDir: (path: string) => readonly string[],
): string[] {
  const problems: string[] = [];
  const manifests = ["package.json"];
  for (const name of listDir(join(projectRoot, "packages"))) {
    manifests.push(`packages/${name}/package.json`);
  }
  const versions = new Map<string, string[]>();
  for (const rel of manifests) {
    let raw: string;
    try {
      raw = readFile(join(projectRoot, rel));
    } catch {
      if (rel === "package.json") problems.push("package.json is unreadable");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problems.push(`${rel} is not JSON`);
      continue;
    }
    const v = (parsed as { version?: unknown }).version;
    if (typeof v !== "string") {
      problems.push(`${rel} has no version`);
      continue;
    }
    versions.set(v, [...(versions.get(v) ?? []), rel]);
  }
  if (versions.size > 1) {
    const parts = [...versions.entries()].map(([v, files]) => `${v} (${files.join(", ")})`);
    problems.push(`workspace package versions differ: ${parts.join("; ")}`);
  }
  let changelog = "";
  try {
    changelog = readFile(join(projectRoot, "CHANGELOG.md"));
  } catch {
    problems.push("CHANGELOG.md is unreadable");
  }
  const heading = `## [${version}]`;
  if (changelog.split(/\r?\n/).some((line) => line.startsWith(heading))) {
    problems.push(`CHANGELOG.md already has a ${heading} section`);
  }
  return problems;
}

/** Same reuse rule as Step 5, read for the fetched tip (the release branch starts there). */
export function ciReuseAtTip(
  input: ReadinessInput,
  runGh: RunGhFn,
  seams: ReleaseSeams = {},
  evaluateNightly?: (inputTree: string) => NightlyReuse,
): CiReuseDecision {
  const { projectRoot, baseBranch, repo } = input;
  if (process.env.DEFT_NO_NETWORK === "1") {
    return {
      kind: "full",
      reason: "check runs are not readable under DEFT_NO_NETWORK=1",
      tipSha: null,
    };
  }
  const fetch = runGit(projectRoot, ["fetch", "origin", baseBranch], seams);
  if (fetch.status !== 0) {
    return {
      kind: "full",
      reason: `git fetch origin ${baseBranch} failed: ${fetch.stderr.trim()}`,
      tipSha: null,
    };
  }
  const tip = runGit(projectRoot, ["rev-parse", `origin/${baseBranch}`], seams);
  const tree = runGit(projectRoot, ["rev-parse", `origin/${baseBranch}^{tree}`], seams);
  const tipSha = tip.status === 0 ? tip.stdout.trim() : "";
  const tipTree = tree.status === 0 ? tree.stdout.trim() : "";
  if (tipSha.length === 0 || tipTree.length === 0) {
    return {
      kind: "full",
      reason: `could not resolve the fetched origin/${baseBranch} tip`,
      tipSha: null,
    };
  }
  const fetched = fetchCheckRunsRest(tipSha, repo, runGh);
  if (fetched.error.length > 0) {
    return {
      kind: "full",
      reason: `check runs on tip ${tipSha} unreadable: ${fetched.error}`,
      tipSha,
    };
  }
  const readNightly =
    evaluateNightly ??
    ((tree: string) => evaluateNightlyReuse(projectRoot, repo, baseBranch, tree, runGh, seams));
  return applyNightlyConjunct(
    decideCiReuseFromRuns(repo, tipSha, tipTree, fetched.checkRuns),
    readNightly(tipTree),
  );
}

/** Where readiness runs, for the nightly lines (#6849). */
export interface ReadinessCiContext {
  readonly repo: string;
  readonly baseBranch: string;
  readonly platform: NodeJS.Platform;
}

/**
 * #6849 / #7328: before the mint, name each nightly lane that is not reusable
 * and why, print the command that starts the nightly workflow, and print the
 * Windows host line. Tip-green reuse continues with smoke-only; otherwise say
 * the full local Step 5 check will run and about how long.
 */
export function readinessNightlyLines(
  decision: CiReuseDecision,
  context: ReadinessCiContext,
): string[] {
  const nightly = decision.nightly ?? null;
  const blocked =
    nightly === null
      ? [{ label: "lanes", reason: "not read before the CI reuse rule stopped" }]
      : nightly.lanes.filter((lane) => !lane.reusable);
  const tipGreenSmoke = decision.kind === "reuse";
  const lines = blocked.map((lane) =>
    tipGreenSmoke
      ? `Nightly ${lane.label} not reusable (${lane.reason}): tip-green CI reuse continues with host smoke only.`
      : `Nightly ${lane.label} not reusable (${lane.reason}): the full local Step 5 check will run ` +
        `(up to ${RELEASE_CHECK_TIMEOUT_MINUTES} minutes).`,
  );
  if (blocked.length > 0) {
    lines.push(
      `Start the nightly workflow on ${context.baseBranch}: ${nightlyDispatchCommand(context.repo, context.baseBranch)}`,
    );
  }
  const windows =
    tipGreenSmoke && blocked.length > 0
      ? windowsSuiteSkippedLineForSmokeOnly(nightly, context.platform)
      : windowsSuiteSkippedLine(nightly, context.platform);
  if (windows !== null) lines.push(windows);
  return lines;
}

/** Lines readiness prints for the CI rule (lean item 3; clause 13). */
export function readinessCiLines(
  decision: CiReuseDecision,
  context: ReadinessCiContext | null = null,
): string[] {
  const lines = [
    "CI reuse is provisional: Step 5 evaluates the rule again on the release branch and " +
      "continues either way without a prompt.",
    `The full local check (task check) can take up to ${RELEASE_CHECK_TIMEOUT_MINUTES} minutes ` +
      "(the Step 5 hard timeout).",
  ];
  if (decision.kind === "full") {
    lines.push(
      `CI reuse does not hold at readiness (${decision.reason}): the full local check will run at Step 5.`,
    );
    if (decision.nightly !== undefined && decision.nightly !== null) {
      lines.push(...formatNightlyLanes(decision.nightly));
    }
  } else {
    lines.push(...formatCiReuseDecision(decision));
  }
  if (context !== null) lines.push(...readinessNightlyLines(decision, context));
  return lines;
}

/** Open PRs with armed auto-merge (REST) and the merge-queue entries (one GraphQL read). */
export function queueReport(input: ReadinessInput, runGh: RunGhFn): string {
  const parts: string[] = [];
  // Every page of open PRs: the jq filter prints one armed PR number per line.
  const pulls = ghOk(runGh, [
    "api",
    "--paginate",
    `repos/${input.repo}/pulls?state=open&base=${input.baseBranch}&per_page=100`,
    "--jq",
    ".[] | select(.auto_merge != null) | .number",
  ]);
  if (!pulls.ok) {
    parts.push(`open PRs unreadable (${pulls.out})`);
  } else {
    const rows = pulls.out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (!rows.every((l) => /^\d+$/.test(l))) {
      parts.push("open PRs unreadable (unexpected output)");
    } else {
      parts.push(
        rows.length === 0
          ? "no open PR has auto-merge armed"
          : `auto-merge armed on ${rows.map((n) => `#${n}`).join(", ")}`,
      );
    }
  }
  const slash = input.repo.indexOf("/");
  const owner = input.repo.slice(0, slash);
  const name = input.repo.slice(slash + 1);
  const query =
    "query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name)" +
    "{mergeQueue(branch:$branch){entries(first:100){totalCount nodes{pullRequest{number}}}}}}";
  const queue = ghOk(runGh, [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `branch=${input.baseBranch}`,
  ]);
  if (!queue.ok) {
    parts.push(`merge queue unreadable (${queue.out})`);
  } else {
    try {
      const data = JSON.parse(queue.out) as {
        data?: {
          repository?: {
            mergeQueue?: {
              entries?: {
                totalCount?: number;
                nodes?: Array<{ pullRequest?: { number?: number } }>;
              };
            } | null;
          };
        };
      };
      const entries = data.data?.repository?.mergeQueue?.entries;
      const nodes = entries?.nodes ?? [];
      const total = entries?.totalCount ?? nodes.length;
      const more = total > nodes.length ? ` (${String(total)} queued in all)` : "";
      parts.push(
        nodes.length === 0
          ? "merge queue empty"
          : `queued: ${nodes.map((n) => `#${String(n.pullRequest?.number)}`).join(", ")}${more}`,
      );
    } catch {
      parts.push("merge queue unreadable (not JSON)");
    }
  }
  return parts.join("; ");
}

function defaultListDir(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Run every readiness check. Writes nothing; the CI rule and queue only report. */
export function runReleaseReadiness(
  input: ReadinessInput,
  seams: ReadinessSeams,
  runGh: RunGhFn,
): ReadinessResult {
  const release = seams.release ?? {};
  const readFile = seams.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const listDir = seams.listDir ?? defaultListDir;
  const checks: ReadinessCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, status: ok ? "ok" : "fail", detail });
  };

  const cleanliness = classifyReleaseInputCleanliness(input.projectRoot, release);
  if (cleanliness.kind === "clean") {
    add("Phase 1: clean working tree", true, "tree clean");
  } else if (cleanliness.kind === "session-scratch-only") {
    add(
      "Phase 1: clean working tree",
      true,
      `session-scratch-only (admitted without --allow-dirty):\n${cleanliness.detail}`,
    );
  } else {
    // #7338: empty porcelain after probe failure must keep "git status failed:" for footer match
    const unverifiable = cleanliness.porcelain.trim().length === 0;
    add(
      "Phase 1: clean working tree",
      false,
      unverifiable
        ? `working-tree cleanliness could not be verified at readiness entry:\ngit status failed: ${cleanliness.reason}`
        : `working tree is dirty (${cleanliness.reason}):\n${cleanliness.porcelain}`,
    );
  }

  const gh = ghOk(runGh, ["api", "rate_limit"]);
  add(
    "Phase 1: GitHub usable",
    gh.ok,
    gh.ok ? "gh api rate_limit ok" : `gh api rate_limit failed: ${gh.out}`,
  );

  const [tagOk, tagReason] = seams.tagFree(input.version, input.repo, input.projectRoot);
  add(`Tag v${input.version} free`, tagOk, tagReason);

  const problems = versionFileProblems(input.projectRoot, input.version, readFile, listDir);
  add(
    "Consistent version files",
    problems.length === 0,
    problems.length === 0
      ? "workspace versions agree; no CHANGELOG section yet"
      : problems.join("; "),
  );

  const dry = seams.dryRun(input);
  add("Phase 2 dry run", dry === 0, dry === 0 ? "dry run passed" : `dry run exited ${String(dry)}`);

  // #7327 Prefer-A defense in depth: re-check porcelain after the dry-run seam.
  const [postClean, postDirty] = checkGitClean(input.projectRoot, release);
  add(
    "Phase 2: clean working tree after dry run",
    postClean,
    postClean
      ? "tree clean after dry run"
      : postDirty.startsWith("git status failed:")
        ? `working-tree cleanliness could not be verified after the dry-run:\n${postDirty}`
        : `working tree is dirty after the dry-run:\n${postDirty}`,
  );

  const ci = ciReuseAtTip(input, runGh, release, seams.evaluateNightly);
  checks.push({
    name: "CI reuse rule (item 3)",
    status: "report",
    detail: readinessCiLines(ci, {
      repo: input.repo,
      baseBranch: input.baseBranch,
      platform: seams.platform ?? process.platform,
    }).join("\n"),
  });

  checks.push({
    name: "Queued PRs and armed auto-merge",
    status: "report",
    detail: queueReport(input, runGh),
  });

  return { ok: checks.every((c) => c.status !== "fail"), checks, ci };
}

/** Prefer-A #7327 refuse footer: entry vs post-dry-run vs other readiness fails. */
export function formatReadinessRefuseFooter(result: ReadinessResult): string {
  const entry = result.checks.find((c) => c.name === "Phase 1: clean working tree");
  const post = result.checks.find((c) => c.name === "Phase 2: clean working tree after dry run");
  if (entry?.status === "fail") {
    const unverifiable = entry.detail.includes("git status failed:");
    return unverifiable
      ? "[readiness] refused: readiness wrote nothing; working-tree cleanliness could not be verified at readiness entry"
      : "[readiness] refused: readiness wrote nothing; working tree was dirty at readiness entry";
  }
  if (post?.status === "fail") {
    const unverifiable = post.detail.includes("could not be verified after the dry-run");
    return unverifiable
      ? "[readiness] refused: a readiness check failed; working-tree cleanliness could not be verified after the dry-run"
      : "[readiness] refused: a readiness check failed; working tree is dirty after the dry-run";
  }
  return "[readiness] refused: a readiness check failed; nothing was written";
}

/** One line per check, with multi-line details indented. */
export function formatReadiness(result: ReadinessResult): string {
  const out: string[] = [];
  for (const check of result.checks) {
    const tag = check.status === "ok" ? "OK" : check.status === "fail" ? "FAIL" : "REPORT";
    const [first, ...rest] = check.detail.split("\n");
    out.push(`[readiness] ${check.name}... ${tag} (${first ?? ""})`);
    for (const line of rest) out.push(`    ${line}`);
  }
  out.push(
    result.ok
      ? "[readiness] all checks passed; nothing written yet"
      : formatReadinessRefuseFooter(result),
  );
  return `${out.join("\n")}\n`;
}
