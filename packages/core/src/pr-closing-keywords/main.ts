import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { extractIntentCloserSet } from "../one-pr-unit/closer-set.js";
import { evaluateOnePrUnit } from "../one-pr-unit/evaluate.js";
import {
  enforceLiveOnePrUnitCheck,
  loadOnePrUnitGrant,
  resolveProductionAppStore,
} from "../one-pr-unit/store.js";
import { MISSING_ONE_PR_UNIT_CONSENT } from "../one-pr-unit/types.js";
import { collectGithubRefs } from "../orphan-active/refs.js";
import {
  listActiveRunningBriefs,
  productPullRequestFromPlan,
} from "../orphan-active/running-briefs.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { resolveRepo } from "../triage/queue/repo.js";
import { EXIT_CONFIG_ERROR, EXIT_HITS_FOUND, EXIT_OK } from "./constants.js";
import { findAllClosingKeywordHits, findHits, renderHit } from "./detect.js";
import { defaultRunGh, fetchPrBody, fetchPrCommitMessages } from "./gh.js";
import { readCommitsFile, readTextFile } from "./io.js";
import type {
  ClosingKeywordMode,
  FullStoryCloseIntent,
  Hit,
  ParsedArgs,
  RunGhFn,
} from "./types.js";

export interface PrDiffPath {
  readonly status: string;
  readonly path: string;
}

/** Leftover-shaped: every path under xbrief|vbrief, active removed, completed added (#4919). */
export function isLeftoverShapedDiff(files: readonly PrDiffPath[]): boolean {
  if (files.length === 0) {
    return false;
  }
  let removedActive = false;
  let addedCompleted = false;
  for (const file of files) {
    const p = file.path.replace(/\\/g, "/");
    if (!(p.startsWith("xbrief/") || p.startsWith("vbrief/"))) {
      return false;
    }
    const status = file.status.toLowerCase();
    // Extra proposed/pending churn disqualifies the leftover exception (#4919).
    if (/\/(proposed|pending)\//.test(p)) {
      return false;
    }
    if (/\/active\//.test(p)) {
      if (status === "removed" || status === "renamed" || status.startsWith("r")) {
        removedActive = true;
      } else {
        return false;
      }
    }
    if (/\/completed\//.test(p)) {
      if (status === "added" || status === "renamed" || status.startsWith("r")) {
        addedCompleted = true;
      } else {
        return false;
      }
    }
  }
  return removedActive && addedCompleted;
}

/** proposed|pending → completed without active is refused at admission (#4919). */
export function isSkipActiveDeliveryShape(files: readonly PrDiffPath[]): boolean {
  let removedProposedOrPending = false;
  let removedActive = false;
  let addedCompleted = false;
  for (const file of files) {
    const p = file.path.replace(/\\/g, "/");
    if (!(p.startsWith("xbrief/") || p.startsWith("vbrief/"))) {
      // Mixed source+brief diffs still refuse skip-active; do not bypass admission (#4919).
      continue;
    }
    const status = file.status.toLowerCase();
    if (
      (status === "removed" || status === "renamed" || status.startsWith("r")) &&
      /\/(proposed|pending)\//.test(p)
    ) {
      removedProposedOrPending = true;
    }
    if (
      (status === "removed" || status === "renamed" || status.startsWith("r")) &&
      /\/active\//.test(p)
    ) {
      removedActive = true;
    }
    if (
      (status === "added" || status === "renamed" || status.startsWith("r")) &&
      /\/completed\//.test(p)
    ) {
      addedCompleted = true;
    }
  }
  return removedProposedOrPending && addedCompleted && !removedActive;
}

function fetchPrFiles(pr: number, repo: string, runGh: RunGhFn): PrDiffPath[] | null {
  const out: PrDiffPath[] = [];
  // Paginate beyond page 1 so later nonterminal briefs cannot bypass admission (#4919).
  for (let page = 1; page <= 30; page += 1) {
    const result = runGh([
      "gh",
      "api",
      `repos/${repo}/pulls/${String(pr)}/files?per_page=100&page=${String(page)}`,
    ]);
    if (result.returncode !== 0) {
      process.stderr.write(
        `Error: gh REST failed fetching PR #${pr} files page ${String(page)}: ${result.stderr.trim()}\n`,
      );
      return null;
    }
    try {
      const payload: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(payload)) {
        process.stderr.write(`Error: PR #${pr} files payload is not an array\n`);
        return null;
      }
      if (payload.length === 0) {
        break;
      }
      for (const item of payload) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const path = typeof rec.filename === "string" ? rec.filename : "";
        const status = typeof rec.status === "string" ? rec.status : "";
        if (path.length > 0) {
          out.push({ path, status });
        }
      }
      if (payload.length < 100) {
        break;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: failed to parse PR #${pr} files: ${message}\n`);
      return null;
    }
  }
  return out;
}

function briefHasMatchingProductPr(
  projectRoot: string,
  issue: number,
  prNumber: number,
  repo: string,
): { ok: boolean; detail: string } {
  const folders = [
    "xbrief/proposed",
    "xbrief/pending",
    "xbrief/active",
    "xbrief/completed",
    "vbrief/proposed",
    "vbrief/pending",
    "vbrief/active",
    "vbrief/completed",
  ];
  for (const folder of folders) {
    const dir = join(projectRoot, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const full = join(dir, name);
      try {
        const raw: unknown = JSON.parse(readFileSync(full, "utf8"));
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        const plan = (raw as Record<string, unknown>).plan;
        if (typeof plan !== "object" || plan === null || Array.isArray(plan)) continue;
        const planObj = plan as Record<string, unknown>;
        const { issues } = collectGithubRefs(planObj, repo);
        const matched = issues.some(
          (ref) => ref.repo.toLowerCase() === repo.toLowerCase() && ref.number === issue,
        );
        if (!matched) continue;
        if (productPullRequestFromPlan(planObj) === prNumber) {
          return { ok: true, detail: relative(projectRoot, full).replace(/\\/g, "/") };
        }
        return {
          ok: false,
          detail:
            `brief ${relative(projectRoot, full).replace(/\\/g, "/")} for #${String(issue)} ` +
            `lacks metadata.productPullRequest=${String(prNumber)}`,
        };
      } catch {
        /* skip unreadable */
      }
    }
  }
  return {
    ok: false,
    detail: `no TIP_NONTERMINAL/completed brief for #${String(issue)} with productPullRequest=${String(prNumber)}`,
  };
}

function changedNonterminalBriefPaths(files: readonly PrDiffPath[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const p = file.path.replace(/\\/g, "/");
    if (!/^(xbrief|vbrief)\/(proposed|pending|active)\//.test(p)) {
      continue;
    }
    const status = file.status.toLowerCase();
    if (status === "removed") {
      continue;
    }
    out.push(p);
  }
  return out;
}

function bindChangedBriefPath(args: {
  readonly projectRoot: string;
  readonly relPath: string;
  readonly prNumber: number;
  readonly repo: string;
  readonly marks: readonly number[];
}): { ok: boolean; detail: string } {
  const full = join(args.projectRoot, args.relPath);
  if (!existsSync(full)) {
    return {
      ok: false,
      detail: `changed nonterminal brief ${args.relPath} missing on checkout`,
    };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(full, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, detail: `changed brief ${args.relPath} is not a JSON object` };
    }
    const plan = (raw as Record<string, unknown>).plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return { ok: false, detail: `changed brief ${args.relPath} lacks plan` };
    }
    const planObj = plan as Record<string, unknown>;
    const { issues } = collectGithubRefs(planObj, args.repo);
    const matchedIssues = issues
      .filter((ref) => ref.repo.toLowerCase() === args.repo.toLowerCase())
      .map((ref) => ref.number);
    if (matchedIssues.length === 0) {
      return {
        ok: false,
        detail: `changed brief ${args.relPath} has no issue ref for ${args.repo}`,
      };
    }
    const stamped = productPullRequestFromPlan(planObj);
    if (stamped !== args.prNumber) {
      return {
        ok: false,
        detail: `changed brief ${args.relPath} lacks metadata.productPullRequest=${String(args.prNumber)}`,
      };
    }
    const bound = matchedIssues.some((n) => args.marks.includes(n));
    if (!bound) {
      return {
        ok: false,
        detail: `changed brief ${args.relPath} issue #${String(matchedIssues[0])} is not covered by deft-story marks`,
      };
    }
    return { ok: true, detail: args.relPath };
  } catch (err: unknown) {
    return {
      ok: false,
      detail: `changed brief ${args.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Pre-merge full-story mark producer/admission (#4919 / #4864).
 * Leftover-shaped diffs pass. Skip-active proposed|pending→completed refuses.
 * Product PRs that touch nonterminal briefs require deft-story + matching metadata.
 */
export function evaluateFullStoryMarkAdmission(args: {
  readonly bodyText: string | null;
  readonly prNumber: number | null;
  readonly projectRoot: string;
  readonly repo: string;
  readonly files: readonly PrDiffPath[];
}): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  if (isLeftoverShapedDiff(args.files)) {
    return { ok: true, messages: ["leftover-shaped diff admitted (#4919)"] };
  }
  if (isSkipActiveDeliveryShape(args.files)) {
    return {
      ok: false,
      messages: [
        "FAIL: skip-active delivery shape (proposed|pending → completed without active) refused (#4919). " +
          "Route the brief through active/ or use a leftover-shaped rename from active/.",
      ],
    };
  }
  const changedNonterminal = changedNonterminalBriefPaths(args.files);
  if (changedNonterminal.length === 0 || args.prNumber === null) {
    return { ok: true, messages };
  }
  const marks = parseAllDeftStoryMarks(args.bodyText ?? "");
  if (marks.length === 0) {
    return {
      ok: false,
      messages: [
        "FAIL: product pull request touches nonterminal xBRIEF without `deft-story: N` (#4864 / #4919).",
      ],
    };
  }
  // Each changed nonterminal path must itself bind; a stamped sibling cannot satisfy (#4919).
  for (const relPath of changedNonterminal) {
    const bind = bindChangedBriefPath({
      projectRoot: args.projectRoot,
      relPath,
      prNumber: args.prNumber,
      repo: args.repo,
      marks,
    });
    if (!bind.ok) {
      messages.push(`FAIL: ${bind.detail}`);
    }
  }
  for (const issue of marks) {
    const bind = briefHasMatchingProductPr(args.projectRoot, issue, args.prNumber, args.repo);
    if (!bind.ok) {
      messages.push(`FAIL: ${bind.detail}`);
    }
  }
  return { ok: messages.length === 0, messages };
}

/**
 * Parse PR-body full-story close intent (#4864): a line `deft-story: N` (digits only).
 * Not an authorization path for Closes/Fixes/Resolves; `--allow-close` stays CLI-only.
 * `deft-close-intent: full` is intentionally ignored here (stays unauthorized).
 */
export function parseDeftStoryMark(text: string): number | null {
  const re = /^\s*deft-story:\s*(\d+)\s*$/gim;
  const match = re.exec(text);
  if (match === null) {
    return null;
  }
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** All distinct `deft-story: N` marks in text (#4864). */
export function parseAllDeftStoryMarks(text: string): number[] {
  const re = /^\s*deft-story:\s*(\d+)\s*$/gim;
  const out = new Set<number>();
  let match = re.exec(text);
  while (match !== null) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) {
      out.add(n);
    }
    match = re.exec(text);
  }
  return [...out].sort((a, b) => a - b);
}

export function fullStoryCloseIntentFromBody(text: string): FullStoryCloseIntent | null {
  const issue = parseDeftStoryMark(text);
  return issue === null ? null : { issue, source: "deft-story" };
}

export function parseAllowList(values: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const chunk of values) {
    for (const raw of chunk.split(",")) {
      const tok = raw.trim().replace(/^#/, "");
      if (tok.length === 0) {
        continue;
      }
      if (!/^\d+$/.test(tok)) {
        throw new Error(
          `Invalid issue number in --allow-known-false-positives / --allow-close: ${JSON.stringify(tok)}`,
        );
      }
      out.add(Number(tok));
    }
  }
  return out;
}

function emptyParsed(error: string): ParsedArgs {
  return {
    pr: null,
    bodyFile: null,
    commitsFile: null,
    fromGitRange: null,
    repo: null,
    allowKnownFalsePositives: [],
    allowClose: [],
    mode: "both",
    onePrUnit: null,
    projectRoot: null,
    error,
  };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let pr: number | null = null;
  let bodyFile: string | null = null;
  let commitsFile: string | null = null;
  let fromGitRange: string | null = null;
  let repo: string | null = null;
  let mode: ClosingKeywordMode = "both";
  const allowKnownFalsePositives: string[] = [];
  const allowClose: string[] = [];
  let onePrUnit: string | null = null;
  let projectRoot: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pr") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --pr: expected one argument");
      }
      const n = Number(value);
      if (!Number.isInteger(n)) {
        return emptyParsed(`invalid int value: ${JSON.stringify(value)}`);
      }
      pr = n;
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      const value = arg.slice("--pr=".length);
      const n = Number(value);
      if (!Number.isInteger(n)) {
        return emptyParsed(`invalid int value: ${JSON.stringify(value)}`);
      }
      pr = n;
    } else if (arg === "--body-file") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --body-file: expected one argument");
      }
      bodyFile = value;
      i += 1;
    } else if (arg?.startsWith("--body-file=")) {
      bodyFile = arg.slice("--body-file=".length);
    } else if (arg === "--commits-file") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --commits-file: expected one argument");
      }
      commitsFile = value;
      i += 1;
    } else if (arg?.startsWith("--commits-file=")) {
      commitsFile = arg.slice("--commits-file=".length);
    } else if (arg === "--from-git-range") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --from-git-range: expected one argument");
      }
      fromGitRange = value;
      i += 1;
    } else if (arg?.startsWith("--from-git-range=")) {
      fromGitRange = arg.slice("--from-git-range=".length);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --repo: expected one argument");
      }
      repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--mode") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --mode: expected one argument (fp|intent|both)");
      }
      if (value !== "fp" && value !== "intent" && value !== "both") {
        return emptyParsed(`invalid --mode: ${JSON.stringify(value)} (expected fp|intent|both)`);
      }
      mode = value;
      i += 1;
    } else if (arg?.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value !== "fp" && value !== "intent" && value !== "both") {
        return emptyParsed(`invalid --mode: ${JSON.stringify(value)} (expected fp|intent|both)`);
      }
      mode = value;
    } else if (arg === "--allow-known-false-positives") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --allow-known-false-positives: expected one argument");
      }
      allowKnownFalsePositives.push(value);
      i += 1;
    } else if (arg?.startsWith("--allow-known-false-positives=")) {
      allowKnownFalsePositives.push(arg.slice("--allow-known-false-positives=".length));
    } else if (arg === "--allow-close") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --allow-close: expected one argument");
      }
      allowClose.push(value);
      i += 1;
    } else if (arg?.startsWith("--allow-close=")) {
      allowClose.push(arg.slice("--allow-close=".length));
    } else if (arg === "--one-pr-unit") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --one-pr-unit: expected one argument");
      }
      onePrUnit = value;
      i += 1;
    } else if (arg?.startsWith("--one-pr-unit=")) {
      onePrUnit = arg.slice("--one-pr-unit=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --project-root: expected one argument");
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg?.startsWith("-")) {
      return emptyParsed(`unrecognized arguments: ${arg}`);
    } else {
      return emptyParsed(`unrecognized arguments: ${arg}`);
    }
  }

  return {
    pr,
    bodyFile,
    commitsFile,
    fromGitRange,
    repo,
    allowKnownFalsePositives,
    allowClose,
    mode,
    onePrUnit,
    projectRoot,
  };
}

export interface RunOptions {
  readonly runGh?: RunGhFn;
  readonly runGit?: RunGhFn;
  readonly env?: NodeJS.ProcessEnv;
}

function defaultRunGit(cmd: readonly string[]): {
  returncode: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync("git", [...cmd], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      returncode: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}

function readGitRange(range: string, runGit: RunGhFn): string[] | null {
  const result = runGit(["log", range, "--format=%B%n--END--"]);
  if (result.returncode !== 0) {
    process.stderr.write(
      "Error: git log " +
        range +
        " failed: " +
        result.stderr.trim() +
        ". Recovery: git fetch origin master.\n",
    );
    return null;
  }
  return result.stdout
    .split("\n--END--\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function filterHits(hits: readonly Hit[], allowList: Set<number>): Hit[] {
  return hits.filter((h) => !allowList.has(h.issueNumber));
}

function emitResult(
  mode: ClosingKeywordMode,
  fpFiltered: readonly Hit[],
  intentFiltered: readonly Hit[],
  fpSuppressed: number,
  intentSuppressed: number,
): number {
  const totalFail = fpFiltered.length + intentFiltered.length;
  if (totalFail === 0) {
    const notes: string[] = [];
    if (fpSuppressed > 0) {
      notes.push(`${fpSuppressed} FP hit(s) suppressed by --allow-known-false-positives`);
    }
    if (intentSuppressed > 0) {
      notes.push(`${intentSuppressed} intent hit(s) suppressed by --allow-close`);
    }
    if (notes.length > 0) {
      process.stderr.write(`OK: ${notes.join("; ")}.\n`);
    } else if (mode === "fp") {
      process.stderr.write(
        "OK: no closing-keyword negation/quotation/example/code-block hits found.\n",
      );
    } else if (mode === "intent") {
      process.stderr.write("OK: no unallowlisted closing-keyword hits (intent mode; #3015).\n");
    } else {
      process.stderr.write(
        "OK: no closing-keyword FP or unallowlisted intent hits found (#737 / #3015).\n",
      );
    }
    return EXIT_OK;
  }

  if (fpFiltered.length > 0) {
    process.stderr.write(
      `FAIL: ${fpFiltered.length} closing-keyword negation-context hit(s) found (FP mode / #737). ` +
        "Rewrite the PR body / commit messages to avoid the trigger token, or pass " +
        "--allow-known-false-positives to suppress known-safe quotes.\n",
    );
    for (const h of fpFiltered) {
      process.stderr.write(`${renderHit(h)}\n`);
    }
  }
  if (intentFiltered.length > 0) {
    process.stderr.write(
      `FAIL: ${intentFiltered.length} real closing-keyword hit(s) without allowlist (intent mode / #3015 class D). ` +
        "Default PR bodies use Tracking: #N / Related: #N / Refs #N. Use Closes/Fixes/Resolves only when full " +
        "issue DoD is met, then pass --allow-close <N,M> on the lint (body trailers are not an authorization path). " +
        "Conditional prose (Phase A / only if / partial) does NOT prevent GitHub auto-close.\n",
    );
    for (const h of intentFiltered) {
      process.stderr.write(`${renderHit(h)}\n`);
    }
  }
  return EXIT_HITS_FOUND;
}

function relBriefPath(path: string, projectRoot: string): string {
  try {
    return relative(resolve(projectRoot), resolve(path)).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

function refuseAllowCloseWhileRunning(
  closeAllow: Set<number>,
  projectRoot: string,
  repoArg: string | null,
): number | null {
  if (closeAllow.size === 0) {
    return null;
  }
  const repo = resolveRepo(repoArg, projectRoot);
  if (repo === null || repo.length === 0) {
    process.stderr.write(
      "Error: --allow-close requires OWNER/REPO to match running briefs. " +
        "Pass --repo OWNER/REPO, set DEFT_TRIAGE_REPO, or run inside a checkout with a GitHub origin remote.\n",
    );
    return EXIT_CONFIG_ERROR;
  }
  const briefs = listActiveRunningBriefs(projectRoot);
  const hits: { issue: number; briefPath: string }[] = [];
  for (const issue of [...closeAllow].sort((a, b) => a - b)) {
    for (const brief of briefs) {
      const { issues } = collectGithubRefs(brief.plan, repo);
      const matched = issues.some(
        (ref) => ref.repo.toLowerCase() === repo.toLowerCase() && ref.number === issue,
      );
      if (matched) {
        hits.push({ issue, briefPath: relBriefPath(brief.path, projectRoot) });
        break;
      }
    }
  }
  if (hits.length === 0) {
    return null;
  }
  process.stderr.write(
    "FAIL: --allow-close names issue(s) whose brief is still running in xbrief/active/. " +
      "Use Refs / Tracking until leftover-complete. --allow-close is the #3015 intent-mode allowlist, not leftover-complete consent.\n",
  );
  for (const hit of hits) {
    process.stderr.write(`  --allow-close ${String(hit.issue)} running brief: ${hit.briefPath}\n`);
  }
  return EXIT_HITS_FOUND;
}

const LIVE_PR_REQUIRES_REPO =
  "live PR one-PR-unit check requires repository identity (--repo or GITHUB_REPOSITORY)";

function resolveLiveRepo(args: ParsedArgs, env: NodeJS.ProcessEnv): string | null {
  const fromArgs = args.repo?.trim() ?? "";
  if (fromArgs.length > 0) return fromArgs;
  const fromEnv = env.GITHUB_REPOSITORY?.trim() ?? "";
  if (fromEnv.length > 0) return fromEnv;
  return null;
}

function fetchPrNodeId(pr: number, repo: string, runGh: RunGhFn): string | null {
  const result = runGh(["gh", "api", `repos/${repo}/pulls/${pr}`]);
  if (result.returncode !== 0) {
    process.stderr.write(
      `Error: gh REST failed fetching PR #${pr} node id: ${result.stderr.trim()}\n`,
    );
    return null;
  }
  try {
    const payload: unknown = JSON.parse(result.stdout);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      process.stderr.write(`Error: PR #${pr} REST payload missing node_id\n`);
      return null;
    }
    const node = (payload as { node_id?: unknown }).node_id;
    if (typeof node === "string" && node.trim().length > 0) return node.trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: failed to parse PR #${pr} REST node id: ${message}\n`);
    return null;
  }
  process.stderr.write(`Error: PR #${pr} REST payload missing node_id\n`);
  return null;
}

export function run(argv: readonly string[], options: RunOptions = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`Error: ${args.error}\n`);
    return EXIT_CONFIG_ERROR;
  }

  let fpAllow: Set<number>;
  let closeAllow: Set<number>;
  try {
    fpAllow = parseAllowList(args.allowKnownFalsePositives);
    closeAllow = parseAllowList(args.allowClose);
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`Error: ${message}\n`);
    return EXIT_CONFIG_ERROR;
  }

  const runningRefuse = refuseAllowCloseWhileRunning(
    closeAllow,
    args.projectRoot ?? ".",
    args.repo,
  );
  if (runningRefuse !== null) {
    return runningRefuse;
  }

  const runGh = options.runGh ?? defaultRunGh;
  const envBag = options.env ?? process.env;
  let bodyText: string | null = null;
  let commitMessages: string[] = [];

  if (args.pr !== null) {
    const liveRepo = resolveLiveRepo(args, envBag);
    if (liveRepo === null) {
      process.stderr.write(`FAIL: ${LIVE_PR_REQUIRES_REPO}\n`);
      return EXIT_CONFIG_ERROR;
    }
    bodyText = fetchPrBody(args.pr, liveRepo, runGh);
    if (bodyText === null) {
      return EXIT_CONFIG_ERROR;
    }
    const msgs = fetchPrCommitMessages(args.pr, liveRepo, runGh);
    if (msgs === null) {
      return EXIT_CONFIG_ERROR;
    }
    commitMessages = msgs;
  } else {
    if (args.bodyFile === null && args.commitsFile === null && args.fromGitRange === null) {
      process.stderr.write(
        "Error: must specify --pr OR --body-file / --commits-file / --from-git-range.\n",
      );
      return EXIT_CONFIG_ERROR;
    }
    if (args.bodyFile !== null) {
      const text = readTextFile(args.bodyFile);
      if (text === null) {
        return EXIT_CONFIG_ERROR;
      }
      bodyText = text;
    }
    if (args.commitsFile !== null) {
      const msgs = readCommitsFile(args.commitsFile);
      if (msgs === null) {
        return EXIT_CONFIG_ERROR;
      }
      commitMessages = msgs;
    }
    if (args.fromGitRange !== null) {
      const msgs = readGitRange(args.fromGitRange, options.runGit ?? defaultRunGit);
      if (msgs === null) {
        return EXIT_CONFIG_ERROR;
      }
      commitMessages = [...commitMessages, ...msgs];
    }
  }

  const runFp = args.mode === "fp" || args.mode === "both";
  const runIntent = args.mode === "intent" || args.mode === "both";

  const fpHits: Hit[] = [];
  const intentHits: Hit[] = [];

  if (bodyText !== null) {
    if (runFp) {
      fpHits.push(...findHits(bodyText, "pr-body"));
    }
    if (runIntent) {
      // Intent = class D only (bare/conditional real closes). Class A FP-context
      // hits (negation/quote/example/code) stay exclusive to FP mode so operators
      // do not need --allow-close for quoted fixtures (#3015 / SLizard).
      intentHits.push(
        ...findAllClosingKeywordHits(bodyText, "pr-body").filter((h) => h.reason === "intent"),
      );
    }
  }
  for (let idx = 0; idx < commitMessages.length; idx += 1) {
    const msg = commitMessages[idx] ?? "";
    if (runFp) {
      fpHits.push(...findHits(msg, `commit:${idx}`));
    }
    if (runIntent) {
      intentHits.push(
        ...findAllClosingKeywordHits(msg, `commit:${idx}`).filter((h) => h.reason === "intent"),
      );
    }
  }

  // Intent allowlist is CLI --allow-close only (#3015). Body trailers are not
  // an authorization path (Markdown example/fence false-authorization class).
  // Live `--pr` forge reads (branch-gate / merge-gate) cannot carry that
  // allowlist. Skip intent-fail there unless the caller passed --allow-close.
  // FP + one-PR-unit still run. Local --body-file / --from-git-range still
  // require --allow-close for real Closes.
  const fpFiltered = filterHits(fpHits, fpAllow);
  const intentFiltered =
    args.pr !== null && closeAllow.size === 0 ? [] : filterHits(intentHits, closeAllow);

  // #4919 / #4864: full-story mark admission on live PR diffs (leftover exception).
  if (args.pr !== null) {
    const liveRepo = resolveLiveRepo(args, envBag);
    if (liveRepo === null) {
      process.stderr.write(`FAIL: ${LIVE_PR_REQUIRES_REPO}\n`);
      return EXIT_CONFIG_ERROR;
    }
    const files = fetchPrFiles(args.pr, liveRepo, runGh);
    if (files === null) {
      return EXIT_CONFIG_ERROR;
    }
    const admission = evaluateFullStoryMarkAdmission({
      bodyText,
      prNumber: args.pr,
      projectRoot: args.projectRoot ?? ".",
      repo: liveRepo,
      files,
    });
    if (!admission.ok) {
      for (const message of admission.messages) {
        process.stderr.write(`${message}\n`);
      }
      return EXIT_HITS_FOUND;
    }
  }

  // FP-only is false-positive detection, not the closer-set gate. Negated
  // "not Closes #N" must not mint a multi-origin unit. Intent/both run the gate.
  if (runIntent) {
    const texts: string[] = [];
    if (bodyText !== null) {
      texts.push(bodyText);
    }
    texts.push(...commitMessages);
    const env = envBag;
    if (args.pr !== null) {
      const repo = resolveLiveRepo(args, env);
      if (repo === null) {
        process.stderr.write(`FAIL: ${LIVE_PR_REQUIRES_REPO}\n`);
        return EXIT_CONFIG_ERROR;
      }
      const closerSet = extractIntentCloserSet(texts, repo);
      if (closerSet.length <= 1) {
        const unit = evaluateOnePrUnit({
          closerSet,
          grant: null,
          binding: { repo },
          phase: "enforce",
        });
        if (!unit.ok) {
          process.stderr.write(`FAIL: ${unit.message}\n`);
          return EXIT_HITS_FOUND;
        }
      } else {
        const resolved = resolveProductionAppStore(env);
        if (!resolved.ok) {
          process.stderr.write(`FAIL: ${resolved.message}\n`);
          return EXIT_CONFIG_ERROR;
        }
        const prNodeId = fetchPrNodeId(args.pr, repo, runGh);
        if (prNodeId === null) {
          return EXIT_CONFIG_ERROR;
        }
        // Find via membershipOf/listActive; exact-set match; phase declare only when code === "allow-granted" (not declare.ok); then bind, resolveClaimFromStore({ prNodeId }), enforce with { repo, prNodeId }.
        const unit = enforceLiveOnePrUnitCheck({
          store: resolved.store,
          closerSet,
          repo,
          prNodeId,
        });
        if (!unit.ok) {
          process.stderr.write(`FAIL: ${unit.message}\n`);
          if (!unit.message.includes("missing one-PR-unit consent") && closerSet.length > 1) {
            process.stderr.write(`${MISSING_ONE_PR_UNIT_CONSENT}\n`);
          }
          return EXIT_HITS_FOUND;
        }
      }
    } else {
      const grant =
        args.onePrUnit === null
          ? null
          : loadOnePrUnitGrant(args.projectRoot ?? ".", args.onePrUnit);
      const repo = args.repo ?? grant?.repo ?? "unknown/unknown";
      const closerSet = extractIntentCloserSet(texts, repo);
      const unit = evaluateOnePrUnit({
        closerSet,
        grant,
        binding: { repo: args.repo ?? grant?.repo },
        presentedIdWithoutStore: args.onePrUnit !== null && grant === null,
        phase: "declare",
      });
      if (!unit.ok) {
        process.stderr.write(`FAIL: ${unit.message}\n`);
        if (!unit.message.includes("missing one-PR-unit consent") && closerSet.length > 1) {
          process.stderr.write(`${MISSING_ONE_PR_UNIT_CONSENT}\n`);
        }
        return EXIT_HITS_FOUND;
      }
    }
  }
  return emitResult(
    args.mode,
    fpFiltered,
    intentFiltered,
    fpHits.length - fpFiltered.length,
    intentHits.length - intentFiltered.length,
  );
}

export function cmdPrCheckClosingKeywords(
  argv: readonly string[],
  options: RunOptions = {},
): number {
  return run(argv, options);
}
