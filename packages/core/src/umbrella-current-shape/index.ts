import { spawnSync } from "node:child_process";
import { scan } from "../cache/scanner.js";
import { resolveBinary } from "../scm/binary.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { resolveRepo } from "../triage/queue/repo.js";

/**
 * #2307: only comments authored by a repo maintainer may be treated as the
 * authoritative current-shape state. GitHub's `author_association` on an issue
 * comment is the trust signal; anything outside this set (CONTRIBUTOR, NONE,
 * FIRST_TIME_CONTRIBUTOR, ...) is an untrusted third party and cannot forge a
 * higher-pass current-shape comment.
 */
export const MAINTAINER_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** True when a comment's author_association marks it as maintainer-authored (#2307). */
export function isMaintainerAuthored(association: string): boolean {
  return MAINTAINER_ASSOCIATIONS.has(association.toUpperCase());
}

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
  readonly authorLogin: string;
  readonly authorAssociation: string;
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
  readonly authorLogin: string;
  readonly authorAssociation: string;
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

/**
 * Map a GitHub REST issue-comment object (or an already-normalized row) onto
 * the internal `IssueComment` shape. Used by `umbrella:current-shape`, the
 * triage cache put path, and `issue:ingest` so all three share one selector.
 */
export function mapIssueCommentEntry(entry: unknown): IssueComment | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }
  const rec = entry as Record<string, unknown>;
  // Accept either GitHub REST field names or the already-mapped camelCase shape.
  const id = typeof rec.id === "number" ? rec.id : null;
  const body = typeof rec.body === "string" ? rec.body : null;
  if (id === null || body === null) {
    return null;
  }
  const user =
    typeof rec.user === "object" && rec.user !== null
      ? (rec.user as Record<string, unknown>)
      : null;
  const htmlUrl =
    typeof rec.html_url === "string"
      ? rec.html_url
      : typeof rec.htmlUrl === "string"
        ? rec.htmlUrl
        : "";
  const updatedAt =
    typeof rec.updated_at === "string"
      ? rec.updated_at
      : typeof rec.updatedAt === "string"
        ? rec.updatedAt
        : "";
  const authorLogin =
    user !== null && typeof user.login === "string"
      ? user.login
      : typeof rec.authorLogin === "string"
        ? rec.authorLogin
        : "";
  const authorAssociation =
    typeof rec.author_association === "string"
      ? rec.author_association
      : typeof rec.authorAssociation === "string"
        ? rec.authorAssociation
        : "";
  return {
    id,
    body,
    htmlUrl,
    updatedAt,
    authorLogin,
    authorAssociation,
  };
}

/** @deprecated Prefer `mapIssueCommentEntry` — kept as a private alias for call sites. */
function mapCommentEntry(entry: unknown): IssueComment | null {
  return mapIssueCommentEntry(entry);
}

/**
 * Labels that mark an issue as umbrella/tracker-like for cache comment enrichment
 * (#1870). Mirrors `TRACKER_LABELS` in scope/open-umbrella-warning.ts.
 */
export const UMBRELLA_TRACKER_LABELS: ReadonlySet<string> = new Set([
  "epic",
  "meta",
  "tracker",
  "type:tracker",
  "status:tracker",
]);

/**
 * Key under which `cache:fetch-all` / `cache:put` stash the issue comment thread
 * on the raw.json payload so `content.md` and `issue:ingest` can surface the
 * canonical current-shape comment without a second live fetch (#1870).
 */
export const RAW_ISSUE_COMMENTS_KEY = "comments" as const;

/** Sidecar filename next to content.md carrying the selected current-shape payload. */
export const CURRENT_SHAPE_SIDECAR = "current-shape.json" as const;

export interface CurrentShapeSidecar {
  readonly commentId: number;
  readonly htmlUrl: string;
  readonly pass: number;
  readonly authorLogin: string;
  readonly authorAssociation: string;
  readonly body: string;
}

/** True when labels or sub-issue summary mark the issue as umbrella/tracker-like. */
export function isUmbrellaLikeIssue(raw: Record<string, unknown>): boolean {
  const labelsRaw = raw.labels;
  if (Array.isArray(labelsRaw)) {
    for (const label of labelsRaw) {
      let name = "";
      if (typeof label === "string") {
        name = label;
      } else if (label !== null && typeof label === "object" && !Array.isArray(label)) {
        const n = (label as Record<string, unknown>).name;
        if (typeof n === "string") name = n;
      }
      if (name.length > 0 && UMBRELLA_TRACKER_LABELS.has(name.toLowerCase())) {
        return true;
      }
    }
  }
  const summary = raw.sub_issues_summary;
  if (summary !== null && typeof summary === "object" && !Array.isArray(summary)) {
    const total = (summary as Record<string, unknown>).total;
    if (typeof total === "number" && Number.isFinite(total) && total > 0) {
      return true;
    }
  }
  return false;
}

/** Normalize a raw issue payload's comment array (REST or pre-mapped). */
export function commentsFromRawPayload(raw: Record<string, unknown>): IssueComment[] {
  const rawComments = raw[RAW_ISSUE_COMMENTS_KEY];
  if (!Array.isArray(rawComments)) {
    return [];
  }
  const out: IssueComment[] = [];
  for (const entry of rawComments) {
    const mapped = mapIssueCommentEntry(entry);
    if (mapped !== null) {
      out.push(mapped);
    }
  }
  return out;
}

/**
 * Count maintainer-authored `## Current shape` comments (for the !=1 lint).
 * Non-maintainer forgeries are excluded (#2307).
 */
export function countMaintainerCurrentShapeComments(comments: readonly IssueComment[]): number {
  let count = 0;
  for (const comment of comments) {
    if (!isMaintainerAuthored(comment.authorAssociation)) {
      continue;
    }
    if (extractPassFromBody(comment.body) !== null) {
      count += 1;
    }
  }
  return count;
}

/** Markdown section appended to cache content.md when a canonical shape exists. */
export function formatCurrentShapeSection(selected: CurrentShapeComment): string {
  const permalink = selected.htmlUrl.length > 0 ? selected.htmlUrl : `comment id ${selected.id}`;
  const author = selected.authorLogin.length > 0 ? `@${selected.authorLogin}` : "maintainer";
  return [
    "",
    "---",
    "",
    "## Canonical current shape (#1152 / #1870)",
    "",
    `_Authoritative planning surface — prefer this over the issue body (stale by design). ` +
      `Source: [${permalink}](${permalink}) · pass-${selected.pass} · ${author}. ` +
      `Deterministic read path: \`task umbrella:current-shape <N>\`._`,
    "",
    selected.body.trimEnd(),
    "",
  ].join("\n");
}

/**
 * Append the canonical current-shape comment (if any) to a rendered cache body.
 * Returns the input unchanged when no maintainer-authored current-shape exists.
 */
export function appendCurrentShapeSection(
  baseContent: string,
  raw: Record<string, unknown>,
): string {
  const selected = selectCurrentShapeComment(commentsFromRawPayload(raw));
  if (selected === null) {
    return baseContent;
  }
  return `${baseContent.trimEnd()}\n${formatCurrentShapeSection(selected)}`;
}

/** Build the current-shape.json sidecar payload, or null when none is selectable. */
export function buildCurrentShapeSidecar(raw: Record<string, unknown>): CurrentShapeSidecar | null {
  const selected = selectCurrentShapeComment(commentsFromRawPayload(raw));
  if (selected === null) {
    return null;
  }
  return {
    commentId: selected.id,
    htmlUrl: selected.htmlUrl,
    pass: selected.pass,
    authorLogin: selected.authorLogin,
    authorAssociation: selected.authorAssociation,
    body: selected.body,
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

/**
 * Pick the canonical comment — highest pass-N; tie-break by comment id (latest).
 *
 * #2307: only MAINTAINER-authored comments (author_association in
 * {OWNER, MEMBER, COLLABORATOR}) are eligible. A non-maintainer higher-pass
 * comment is ignored, which defeats the forged-higher-pass primitive: an
 * attacker cannot inject authoritative state by simply commenting with a bigger
 * pass number.
 */
export function selectCurrentShapeComment(
  comments: readonly IssueComment[],
): CurrentShapeComment | null {
  let best: CurrentShapeComment | null = null;
  for (const comment of comments) {
    if (!isMaintainerAuthored(comment.authorAssociation)) {
      continue;
    }
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

// #2307 (Greptile review): a structurally valid current-shape comment authored
// by a non-maintainer is filtered out for provenance and would otherwise be
// reported with the generic "not found" message above -- indistinguishable from
// genuine absence, which makes --strict especially confusing to debug. This
// message names the provenance filter explicitly so the caller knows the
// comment exists but was ignored, not that it is missing.
export const NON_MAINTAINER_CURRENT_SHAPE_MESSAGE =
  "A ## Current shape (as of pass-N) comment exists but was authored by a " +
  "non-maintainer (author_association not in OWNER/MEMBER/COLLABORATOR) and is " +
  "ignored per AGENTS.md ## Umbrella current-shape convention (#1152 / #2307). " +
  "A maintainer must (re-)post the current-shape comment for it to be authoritative.";

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
    // Distinguish provenance-filtered absence from genuine absence (#2307).
    const hadNonMaintainerShape = fetched.some(
      (c) => extractPassFromBody(c.body) !== null && !isMaintainerAuthored(c.authorAssociation),
    );
    return {
      ok: false,
      error: hadNonMaintainerShape
        ? NON_MAINTAINER_CURRENT_SHAPE_MESSAGE
        : NO_CURRENT_SHAPE_MESSAGE,
      kind: "not-found",
    };
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
      authorLogin: selected.authorLogin,
      authorAssociation: selected.authorAssociation,
      sections,
    },
  };
}

export function emitCurrentShape(
  result: CurrentShapeResult,
  options: {
    jsonMode: boolean;
    writeOut: (text: string) => void;
    writeErr?: (text: string) => void;
  },
): number {
  // #2307: the selected comment body is still attacker-influencable text (a
  // maintainer can quote/paste untrusted content). Run it through the same
  // quarantine scanner used for cache content and emit the fenced transform so
  // injection-shaped sections are quarantined, never rendered as authoritative
  // instructions.
  const scanned = scan(result.body);
  // #2307 fail-closed (Greptile review): a scanner hard-fail (e.g. a credential
  // pattern) is only FLAGGED by scan() -- detectCredentials sets passed=false
  // but does NOT redact the secret from transformed_content. Emitting the
  // transform regardless would forward the raw credential to stdout / CI logs /
  // JSON consumers. Mirror buildIssueVbrief (#2306, issue:ingest), which throws
  // ScannerHardFailError and writes nothing: refuse to emit and return non-zero.
  if (!scanned.passed) {
    const details = scanned.flags
      .filter((f) => f.severity === "hard-fail")
      .map((f) => f.detail)
      .join("; ");
    const writeErr = options.writeErr ?? ((text: string) => process.stderr.write(text));
    writeErr(
      `umbrella:current-shape: refused issue #${result.issueNumber}: quarantine scanner hard-fail` +
        (details.length > 0 ? ` (${details})` : "") +
        " -- nothing written.\n",
    );
    return 1;
  }
  if (options.jsonMode) {
    const payload = {
      issueNumber: result.issueNumber,
      repo: result.repo,
      commentId: result.commentId,
      htmlUrl: result.htmlUrl,
      pass: result.pass,
      body: scanned.transformed_content,
      authorLogin: result.authorLogin,
      authorAssociation: result.authorAssociation,
      scannerPassed: scanned.passed,
      sections: sectionsRecord(result.sections),
      missingSections: result.sections.missing,
      missingOptionalSections: result.sections.optionalMissing,
    };
    options.writeOut(`${JSON.stringify(payload)}\n`);
  } else {
    options.writeOut(`${scanned.transformed_content}\n`);
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
    writeErr,
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
