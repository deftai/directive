import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { extractIntentCloserSet } from "../one-pr-unit/closer-set.js";
import { evaluateOnePrUnit } from "../one-pr-unit/evaluate.js";
import { loadOnePrUnitGrant } from "../one-pr-unit/store.js";
import { MISSING_ONE_PR_UNIT_CONSENT } from "../one-pr-unit/types.js";
import { collectGithubRefs } from "../orphan-active/refs.js";
import { listActiveRunningBriefs } from "../orphan-active/running-briefs.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { resolveRepo } from "../triage/queue/repo.js";
import { EXIT_CONFIG_ERROR, EXIT_HITS_FOUND, EXIT_OK } from "./constants.js";
import { findAllClosingKeywordHits, findHits, renderHit } from "./detect.js";
import { defaultRunGh, fetchPrBody, fetchPrCommitMessages } from "./gh.js";
import { readCommitsFile, readTextFile } from "./io.js";
import type { ClosingKeywordMode, Hit, ParsedArgs, RunGhFn } from "./types.js";

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
  let bodyText: string | null = null;
  let commitMessages: string[] = [];

  if (args.pr !== null) {
    bodyText = fetchPrBody(args.pr, args.repo, runGh);
    if (bodyText === null) {
      return EXIT_CONFIG_ERROR;
    }
    const msgs = fetchPrCommitMessages(args.pr, args.repo, runGh);
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

  // FP-only is false-positive detection, not the closer-set gate. Negated
  // "not Closes #N" must not mint a multi-origin unit. Intent/both run the gate.
  if (runIntent) {
    const texts: string[] = [];
    if (bodyText !== null) {
      texts.push(bodyText);
    }
    texts.push(...commitMessages);
    const grant =
      args.onePrUnit === null ? null : loadOnePrUnitGrant(args.projectRoot ?? ".", args.onePrUnit);
    const repo = args.repo ?? grant?.repo ?? "unknown/unknown";
    const closerSet = extractIntentCloserSet(texts, repo);
    const unit = evaluateOnePrUnit({
      closerSet,
      grant,
      binding: { repo: args.repo ?? grant?.repo },
      presentedIdWithoutStore: args.onePrUnit !== null && grant === null,
      phase: args.pr !== null ? "enforce" : "declare",
    });
    if (!unit.ok) {
      process.stderr.write(`FAIL: ${unit.message}\n`);
      if (!unit.message.includes("missing one-PR-unit consent") && closerSet.length > 1) {
        process.stderr.write(`${MISSING_ONE_PR_UNIT_CONSENT}\n`);
      }
      return EXIT_HITS_FOUND;
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
