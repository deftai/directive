import { EXIT_CONFIG_ERROR, EXIT_HITS_FOUND, EXIT_OK } from "./constants.js";
import { findHits, renderHit } from "./detect.js";
import { defaultRunGh, fetchPrBody, fetchPrCommitMessages } from "./gh.js";
import { readCommitsFile, readTextFile } from "./io.js";
import type { Hit, ParsedArgs, RunGhFn } from "./types.js";

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
          `Invalid issue number in --allow-known-false-positives: ${JSON.stringify(tok)}`,
        );
      }
      out.add(Number(tok));
    }
  }
  return out;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let pr: number | null = null;
  let bodyFile: string | null = null;
  let commitsFile: string | null = null;
  let repo: string | null = null;
  const allowKnownFalsePositives: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pr") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          pr,
          bodyFile,
          commitsFile,
          repo,
          allowKnownFalsePositives,
          error: "argument --pr: expected one argument",
        };
      }
      const n = Number(value);
      if (!Number.isInteger(n)) {
        return {
          pr,
          bodyFile,
          commitsFile,
          repo,
          allowKnownFalsePositives,
          error: `invalid int value: ${JSON.stringify(value)}`,
        };
      }
      pr = n;
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      const value = arg.slice("--pr=".length);
      const n = Number(value);
      if (!Number.isInteger(n)) {
        return {
          pr,
          bodyFile,
          commitsFile,
          repo,
          allowKnownFalsePositives,
          error: `invalid int value: ${JSON.stringify(value)}`,
        };
      }
      pr = n;
    } else if (arg === "--body-file") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          pr,
          bodyFile,
          commitsFile,
          repo,
          allowKnownFalsePositives,
          error: "argument --body-file: expected one argument",
        };
      }
      bodyFile = value;
      i += 1;
    } else if (arg?.startsWith("--body-file=")) {
      bodyFile = arg.slice("--body-file=".length);
    } else if (arg === "--commits-file") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          pr,
          bodyFile,
          commitsFile,
          repo,
          allowKnownFalsePositives,
          error: "argument --commits-file: expected one argument",
        };
      }
      commitsFile = value;
      i += 1;
    } else if (arg?.startsWith("--commits-file=")) {
      commitsFile = arg.slice("--commits-file=".length);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          pr,
          bodyFile,
          commitsFile,
          repo,
          allowKnownFalsePositives,
          error: "argument --repo: expected one argument",
        };
      }
      repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--allow-known-false-positives") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          pr,
          bodyFile,
          commitsFile,
          repo,
          allowKnownFalsePositives,
          error: "argument --allow-known-false-positives: expected one argument",
        };
      }
      allowKnownFalsePositives.push(value);
      i += 1;
    } else if (arg?.startsWith("--allow-known-false-positives=")) {
      allowKnownFalsePositives.push(arg.slice("--allow-known-false-positives=".length));
    } else if (arg?.startsWith("-")) {
      return {
        pr,
        bodyFile,
        commitsFile,
        repo,
        allowKnownFalsePositives,
        error: `unrecognized arguments: ${arg}`,
      };
    } else {
      return {
        pr,
        bodyFile,
        commitsFile,
        repo,
        allowKnownFalsePositives,
        error: `unrecognized arguments: ${arg}`,
      };
    }
  }

  return { pr, bodyFile, commitsFile, repo, allowKnownFalsePositives };
}

export interface RunOptions {
  readonly runGh?: RunGhFn;
}

function filterHits(hits: readonly Hit[], allowList: Set<number>): Hit[] {
  return hits.filter((h) => !allowList.has(h.issueNumber));
}

function emitResult(hits: readonly Hit[], filtered: readonly Hit[]): number {
  if (filtered.length === 0) {
    if (hits.length > 0) {
      process.stderr.write(
        `OK: ${hits.length} hit(s) suppressed by --allow-known-false-positives.\n`,
      );
    } else {
      process.stderr.write(
        "OK: no closing-keyword negation/quotation/example/code-block hits found.\n",
      );
    }
    return EXIT_OK;
  }

  process.stderr.write(
    `FAIL: ${filtered.length} closing-keyword negation-context hit(s) found (see #737). Rewrite the PR body / commit messages to avoid the trigger token, or pass --allow-known-false-positives to suppress.\n`,
  );
  for (const h of filtered) {
    process.stderr.write(`${renderHit(h)}\n`);
  }
  return EXIT_HITS_FOUND;
}

export function run(argv: readonly string[], options: RunOptions = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`Error: ${args.error}\n`);
    return EXIT_CONFIG_ERROR;
  }

  let allowList: Set<number>;
  try {
    allowList = parseAllowList(args.allowKnownFalsePositives);
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

  const hits: Hit[] = [];
  if (bodyText !== null) {
    hits.push(...findHits(bodyText, "pr-body"));
  }
  for (let idx = 0; idx < commitMessages.length; idx += 1) {
    hits.push(...findHits(commitMessages[idx] ?? "", `commit:${idx}`));
  }

  const filtered = filterHits(hits, allowList);
  return emitResult(hits, filtered);
}

export function cmdPrCheckClosingKeywords(
  argv: readonly string[],
  options: RunOptions = {},
): number {
  return run(argv, options);
}
