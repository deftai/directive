import { EXIT_CONFIG_ERROR, EXIT_HITS_FOUND, EXIT_OK } from "./constants.js";
import { findAllClosingKeywordHits, findHits, hasFullCloseIntent, renderHit } from "./detect.js";
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
    repo: null,
    allowKnownFalsePositives: [],
    allowClose: [],
    mode: "both",
    error,
  };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let pr: number | null = null;
  let bodyFile: string | null = null;
  let commitsFile: string | null = null;
  let repo: string | null = null;
  let mode: ClosingKeywordMode = "both";
  const allowKnownFalsePositives: string[] = [];
  const allowClose: string[] = [];

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
    } else if (arg?.startsWith("-")) {
      return emptyParsed(`unrecognized arguments: ${arg}`);
    } else {
      return emptyParsed(`unrecognized arguments: ${arg}`);
    }
  }

  return { pr, bodyFile, commitsFile, repo, allowKnownFalsePositives, allowClose, mode };
}

export interface RunOptions {
  readonly runGh?: RunGhFn;
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
      notes.push(
        `${intentSuppressed} intent hit(s) suppressed by --allow-close / deft-close-intent: full`,
      );
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
        "issue DoD is met, then either add `deft-close-intent: full` to the PR body or pass " +
        "--allow-close <N,M>. Conditional prose (Phase A / only if / partial) does NOT prevent GitHub auto-close.\n",
    );
    for (const h of intentFiltered) {
      process.stderr.write(`${renderHit(h)}\n`);
    }
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
    if (args.bodyFile === null && args.commitsFile === null) {
      process.stderr.write("Error: must specify --pr OR --body-file / --commits-file.\n");
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
      intentHits.push(...findAllClosingKeywordHits(bodyText, "pr-body"));
    }
  }
  for (let idx = 0; idx < commitMessages.length; idx += 1) {
    const msg = commitMessages[idx] ?? "";
    if (runFp) {
      fpHits.push(...findHits(msg, `commit:${idx}`));
    }
    if (runIntent) {
      intentHits.push(...findAllClosingKeywordHits(msg, `commit:${idx}`));
    }
  }

  const fullIntent =
    (bodyText !== null && hasFullCloseIntent(bodyText)) ||
    commitMessages.some((m) => hasFullCloseIntent(m));

  const fpFiltered = filterHits(fpHits, fpAllow);
  const intentFiltered = fullIntent ? [] : filterHits(intentHits, closeAllow);

  return emitResult(
    args.mode,
    fpFiltered,
    intentFiltered,
    fpHits.length - fpFiltered.length,
    fullIntent ? intentHits.length : intentHits.length - intentFiltered.length,
  );
}

export function cmdPrCheckClosingKeywords(
  argv: readonly string[],
  options: RunOptions = {},
): number {
  return run(argv, options);
}
