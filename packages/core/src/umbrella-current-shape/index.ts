import { spawnSync } from "node:child_process";
import { resolveBinary } from "../scm/binary.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { resolveRepo } from "../triage/queue/repo.js";

/** Matches `## Current shape (as of pass-N)` — same pattern as vbrief-reconcile/umbrellas.ts. */
export const CURRENT_SHAPE_HEADER_RE = /^## Current shape \(as of pass-(\d+)\)/m;

export const SECTION_MARKERS = {
  lastUpdated: /^Last updated:\s/m,
  lastPassType: /^Last pass type:\s/m,
  childCount: /^Child count:\s/m,
  childCountHistory: /^Child-count history:\s/m,
  openChildren: /^### Open children\s*$/m,
  closedChildren: /^### Closed children\s*$/m,
  waveOrder: /^### Wave order\s*$/m,
  openQuestions: /^### Open questions\s*$/m,
  readingOrder: /^### Reading order for fresh contributors\s*$/m,
} as const;

export type SectionKey = keyof typeof SECTION_MARKERS;

/** Required per AGENTS.md #1152; openQuestions is optional. */
export const REQUIRED_SECTIONS: readonly SectionKey[] = [
  "lastUpdated",
  "lastPassType",
  "childCount",
  "childCountHistory",
  "openChildren",
  "closedChildren",
  "waveOrder",
  "readingOrder",
];

export const OPTIONAL_SECTIONS: readonly SectionKey[] = ["openQuestions"];

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly htmlUrl: string;
  readonly updatedAt: string;
}

export interface CurrentShapeComment extends IssueComment {
  readonly pass: number;
}

export interface SectionPresence {
  readonly present: SectionKey[];
  readonly missing: SectionKey[];
  readonly optionalPresent: SectionKey[];
  readonly optionalMissing: SectionKey[];
}

export interface CurrentShapeResult {
  readonly issueNumber: number;
  readonly repo: string;
  readonly commentId: number;
  readonly htmlUrl: string;
  readonly pass: number;
  readonly body: string;
  readonly sections: SectionPresence;
}

export type ScmFetcher = (repo: string, issueNumber: number) => IssueComment[] | { error: string };

export interface RunCurrentShapeOptions {
  readonly issueNumber: number;
  readonly projectRoot: string;
  readonly repo?: string | null;
  readonly jsonMode?: boolean;
  readonly strict?: boolean;
  readonly fetchComments?: ScmFetcher;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
}

function mapCommentEntry(entry: unknown): IssueComment | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const rec = entry as Record<string, unknown>;
  if (typeof rec.id !== "number" || typeof rec.body !== "string") {
    return null;
  }
  return {
    id: rec.id,
    body: rec.body,
    htmlUrl: typeof rec.html_url === "string" ? rec.html_url : "",
    updatedAt: typeof rec.updated_at === "string" ? rec.updated_at : "",
  };
}

/** Merge `gh api --paginate` concatenated JSON array pages into comment rows. */
export function parseCommentsFromGhStdout(stdout: string): IssueComment[] {
  const comments: IssueComment[] = [];
  const text = stdout.trim();
  if (!text) {
    return comments;
  }

  const pages: unknown[] = [];
  try {
    pages.push(JSON.parse(text));
  } catch {
    let idx = 0;
    while (idx < text.length) {
      while (idx < text.length && /\s/.test(text[idx] ?? "")) {
        idx += 1;
      }
      if (idx >= text.length) {
        break;
      }
      const slice = text.slice(idx);
      if (!slice.startsWith("[")) {
        break;
      }
      let depth = 0;
      let end = -1;
      for (let j = 0; j < slice.length; j += 1) {
        const ch = slice[j];
        if (ch === "[") {
          depth += 1;
        } else if (ch === "]") {
          depth -= 1;
          if (depth === 0) {
            end = j + 1;
            break;
          }
        }
      }
      if (end < 0) {
        throw new SyntaxError("invalid paginated JSON");
      }
      pages.push(JSON.parse(slice.slice(0, end)));
      idx += end;
    }
  }

  for (const page of pages) {
    if (!Array.isArray(page)) {
      continue;
    }
    for (const entry of page) {
      const mapped = mapCommentEntry(entry);
      if (mapped !== null) {
        comments.push(mapped);
      }
    }
  }
  return comments;
}

function defaultFetchComments(
  repo: string,
  issueNumber: number,
): IssueComment[] | { error: string } {
  const binary = resolveBinary();
  const path = `repos/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const proc = spawnSync(binary, ["api", "--paginate", path], {
    encoding: "utf8",
    maxBuffer: SUBPROCESS_MAX_BUFFER,
  });
  if (proc.error !== undefined) {
    return {
      error: `fetch comments #${issueNumber} (${repo}) failed: ${proc.error.message}`,
    };
  }
  if (proc.status !== 0) {
    return {
      error: `fetch comments #${issueNumber} (${repo}) failed: ${(proc.stderr || proc.stdout || "").trim()}`,
    };
  }
  try {
    return parseCommentsFromGhStdout(String(proc.stdout ?? ""));
  } catch (exc) {
    return {
      error: `fetch comments #${issueNumber} (${repo}) returned non-JSON: ${String(exc)}`,
    };
  }
}

export function extractPassFromBody(body: string): number | null {
  const match = CURRENT_SHAPE_HEADER_RE.exec(body);
  if (!match?.[1]) {
    return null;
  }
  const pass = Number(match[1]);
  return Number.isFinite(pass) ? pass : null;
}

/** Pick the canonical comment — highest pass-N; tie-break by comment id (latest). */
export function selectCurrentShapeComment(
  comments: readonly IssueComment[],
): CurrentShapeComment | null {
  let best: CurrentShapeComment | null = null;
  for (const comment of comments) {
    const pass = extractPassFromBody(comment.body);
    if (pass === null) {
      continue;
    }
    const candidate: CurrentShapeComment = { ...comment, pass };
    if (
      best === null ||
      candidate.pass > best.pass ||
      (candidate.pass === best.pass && candidate.id > best.id)
    ) {
      best = candidate;
    }
  }
  return best;
}

export function detectSections(body: string): SectionPresence {
  const present: SectionKey[] = [];
  const missing: SectionKey[] = [];
  const optionalPresent: SectionKey[] = [];
  const optionalMissing: SectionKey[] = [];

  for (const key of REQUIRED_SECTIONS) {
    if (SECTION_MARKERS[key].test(body)) {
      present.push(key);
    } else {
      missing.push(key);
    }
  }
  for (const key of OPTIONAL_SECTIONS) {
    if (SECTION_MARKERS[key].test(body)) {
      optionalPresent.push(key);
    } else {
      optionalMissing.push(key);
    }
  }

  return { present, missing, optionalPresent, optionalMissing };
}

export function sectionsRecord(presence: SectionPresence): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of REQUIRED_SECTIONS) {
    out[key] = presence.present.includes(key);
  }
  for (const key of OPTIONAL_SECTIONS) {
    out[key] = presence.optionalPresent.includes(key);
  }
  return out;
}

export const NO_CURRENT_SHAPE_MESSAGE =
  "No ## Current shape (as of pass-N) comment found on this issue. " +
  "Create one per AGENTS.md ## Umbrella current-shape convention (#1152) — " +
  "do not fall back to the issue body (stale by design).";

export function fetchCurrentShape(options: {
  repo: string;
  issueNumber: number;
  fetchComments?: ScmFetcher;
}):
  | { ok: true; result: CurrentShapeResult }
  | { ok: false; error: string; kind: "not-found" | "config" } {
  const fetcher = options.fetchComments ?? defaultFetchComments;
  const fetched = fetcher(options.repo, options.issueNumber);
  if (!Array.isArray(fetched)) {
    return { ok: false, error: fetched.error, kind: "config" };
  }
  const selected = selectCurrentShapeComment(fetched);
  if (selected === null) {
    return { ok: false, error: NO_CURRENT_SHAPE_MESSAGE, kind: "not-found" };
  }
  const sections = detectSections(selected.body);
  return {
    ok: true,
    result: {
      issueNumber: options.issueNumber,
      repo: options.repo,
      commentId: selected.id,
      htmlUrl: selected.htmlUrl,
      pass: selected.pass,
      body: selected.body,
      sections,
    },
  };
}

export function emitCurrentShape(
  result: CurrentShapeResult,
  options: { jsonMode: boolean; writeOut: (text: string) => void },
): number {
  if (options.jsonMode) {
    const payload = {
      issueNumber: result.issueNumber,
      repo: result.repo,
      commentId: result.commentId,
      htmlUrl: result.htmlUrl,
      pass: result.pass,
      body: result.body,
      sections: sectionsRecord(result.sections),
      missingSections: result.sections.missing,
      missingOptionalSections: result.sections.optionalMissing,
    };
    options.writeOut(`${JSON.stringify(payload)}\n`);
  } else {
    options.writeOut(`${result.body}\n`);
  }
  return 0;
}

export function runCurrentShape(options: RunCurrentShapeOptions): number {
  const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text));

  if (!Number.isInteger(options.issueNumber) || options.issueNumber <= 0) {
    writeErr("umbrella:current-shape: issue number must be a positive integer\n");
    return 2;
  }

  const repo = resolveRepo(options.repo ?? null, options.projectRoot);
  if (repo === null) {
    writeErr(
      "umbrella:current-shape: could not resolve owner/repo — pass --repo OWNER/REPO or run inside a git repo with origin\n",
    );
    return 2;
  }

  const fetched = fetchCurrentShape({
    repo,
    issueNumber: options.issueNumber,
    fetchComments: options.fetchComments,
  });

  if (!fetched.ok) {
    writeErr(`umbrella:current-shape: ${fetched.error}\n`);
    return fetched.kind === "config" ? 2 : 1;
  }

  if (options.strict === true && fetched.result.sections.missing.length > 0) {
    writeErr(
      `umbrella:current-shape: --strict: missing required section(s): ${fetched.result.sections.missing.join(", ")}\n`,
    );
    return 1;
  }

  return emitCurrentShape(fetched.result, {
    jsonMode: options.jsonMode ?? false,
    writeOut,
  });
}

export function parseCurrentShapeArgv(argv: readonly string[]): {
  issueNumber: number | null;
  repo: string | null;
  jsonMode: boolean;
  strict: boolean;
  passthroughError?: string;
} {
  let issueNumber: number | null = null;
  let repo: string | null = null;
  let jsonMode = false;
  let strict = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--json") {
      jsonMode = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          issueNumber,
          repo,
          jsonMode,
          strict,
          passthroughError: "argument --repo: expected one argument",
        };
      }
      repo = value;
      i += 1;
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg.startsWith("-")) {
      return {
        issueNumber,
        repo,
        jsonMode,
        strict,
        passthroughError: `unknown flag: ${arg}`,
      };
    } else if (issueNumber === null) {
      const parsed = Number(arg);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return {
          issueNumber,
          repo,
          jsonMode,
          strict,
          passthroughError: `invalid issue number: ${arg}`,
        };
      }
      issueNumber = parsed;
    } else {
      return {
        issueNumber,
        repo,
        jsonMode,
        strict,
        passthroughError: `unexpected positional argument: ${arg}`,
      };
    }
  }

  return { issueNumber, repo, jsonMode, strict };
}
