import { scan } from "../cache/scanner.js";
import {
  fetchIssueComments,
  ISSUE_COMMENT_THREAD_KEY,
  type IssueComment,
} from "../intake/issue-ingest.js";
import {
  classifyOriginRequirementShape,
  type OriginRequirementShape,
  selectedCurrentShapeId,
} from "../intake/origin-requirement-shape.js";
import {
  extractReferencesFromVbrief,
  GITHUB_ISSUE_REF_TYPES,
  parseIssueNumber,
} from "../intake/reconcile-issues.js";
import {
  fetchSpecPathLiveIdentities,
  readSpecPathSourceRecord,
  type SpecPathLiveIdentities,
  type SpecPathSourceRecord,
} from "../intake/spec-path-source.js";
import {
  digestAdmittedSourceSentences,
  readAdmittedSourceDigest,
  readAdmittedSourceSentences,
} from "../product-first-done-gate/acceptance.js";
import { type CallOptions, type CompletedProcess, call } from "../scm/call.js";
import { hasWritePermission } from "../scope-provenance/forge-approval.js";

const ISSUE_URL_PATTERN = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/g;
const ISSUE_API_URL_PATTERN =
  /https:\/\/api\.github\.com\/repos\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/g;
/** The Origin narrative `issue:ingest` writes: `Ingested from <issue URL>`. */
const INGEST_ORIGIN_PATTERN = /^Ingested from (https:\/\/github\.com\/\S+\/issues\/\d+)/;

export const ORIGIN_FRESHNESS_REMEDIATION =
  "Re-read the issue body and comments (#2143), then either refresh the brief or record intentional divergence and bump xBRIEFInfo.updated. Do not auto-write origin text onto the brief (#309 D12).";

export type OriginFreshnessKind = "no-origin" | "current" | "stale" | "uncomparable";

/**
 * Why preflight refuses a drifted origin (#7138). Only the authoritative origin
 * of a brief with a baseline is compared by content; a brief with no baseline
 * keeps the timestamp refusal (`no baseline`).
 */
export type OriginRefusalReason =
  | "origin body changed"
  | "requirement comment"
  | "Spec-path source changed"
  | "author permission unknown"
  | "no baseline"
  | "origin unavailable";

export interface GithubIssueOrigin {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly uri: string;
  readonly type: string;
}

/**
 * Live origin issue as preflight reads it. `body` is undefined when the
 * fetcher did not read it (a body compare then counts as unavailable).
 */
export interface OriginIssueSnapshot {
  readonly updatedAt: string;
  readonly body?: string | null;
  readonly state?: string | null;
  readonly authorLogin?: string | null;
}

export type FetchOriginUpdatedAt = (
  origin: GithubIssueOrigin,
) => OriginIssueSnapshot | { error: string };

/** Full live comment thread of an origin, or a failure (never a partial thread). */
export type FetchOriginComments = (
  origin: GithubIssueOrigin,
) =>
  | { readonly ok: true; readonly comments: readonly IssueComment[] }
  | { readonly ok: false; readonly reason: string };

/** Write access of `login` on `repo`: true, false, or null when the lookup fails. */
export type FetchAuthorWritePermission = (repo: string, login: string) => boolean | null;

export interface EvaluateOriginFreshnessOptions {
  readonly fetchOriginUpdatedAt?: FetchOriginUpdatedAt;
  readonly fetchOriginComments?: FetchOriginComments;
  readonly fetchAuthorWritePermission?: FetchAuthorWritePermission;
  readonly fetchSpecPathLiveIdentities?: (record: SpecPathSourceRecord) => SpecPathLiveIdentities;
  readonly cwd?: string;
  readonly skip?: boolean;
}

export type OriginFreshnessResult =
  | {
      readonly ok: true;
      readonly kind: OriginFreshnessKind;
      /** `WARN:` lines (without the prefix): ids and URLs only, never comment text. */
      readonly warnings?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly kind: OriginFreshnessKind;
      readonly message: string;
      readonly reason?: OriginRefusalReason;
    };

export type ScmCallFn = (
  source: string,
  verb: string,
  args: readonly string[] | null,
  options?: CallOptions,
) => CompletedProcess;

export function briefUpdatedOf(payload: Record<string, unknown>): string | null {
  const info = payload.xBRIEFInfo;
  if (info !== null && typeof info === "object" && !Array.isArray(info)) {
    const updated = (info as Record<string, unknown>).updated;
    if (typeof updated === "string" && updated.trim().length > 0) {
      return updated.trim();
    }
  }
  const plan = payload.plan;
  if (plan !== null && typeof plan === "object" && !Array.isArray(plan)) {
    const updated = (plan as Record<string, unknown>).updated;
    if (typeof updated === "string" && updated.trim().length > 0) {
      return updated.trim();
    }
  }
  return null;
}

export function extractGithubIssueOrigins(payload: Record<string, unknown>): GithubIssueOrigin[] {
  const origins: GithubIssueOrigin[] = [];
  const seen = new Set<string>();
  const add = (origin: GithubIssueOrigin): void => {
    const key = `${origin.owner}/${origin.repo}#${origin.number}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    origins.push(origin);
  };
  for (const rec of extractReferencesFromVbrief(payload)) {
    const type = String(rec.type ?? "");
    if (!GITHUB_ISSUE_REF_TYPES.has(type)) {
      continue;
    }
    const fromUri = originFromUri(rec);
    let origin: GithubIssueOrigin | null = fromUri !== null ? { ...fromUri, type } : null;
    if (origin === null) {
      const number = parseIssueNumber(rec);
      if (number === null) {
        continue;
      }
      origin = {
        owner: "",
        repo: "",
        number,
        uri: typeof rec.uri === "string" ? rec.uri : "",
        type,
      };
    }
    add(origin);
  }
  for (const text of textualOriginFields(payload)) {
    for (const fromText of originsFromText(text)) {
      add({ ...fromText, type: "x-xbrief/github-issue" });
    }
  }
  return origins;
}

export function extractGithubIssueOrigin(
  payload: Record<string, unknown>,
): GithubIssueOrigin | null {
  return extractGithubIssueOrigins(payload)[0] ?? null;
}

function originFromUri(ref: Record<string, unknown>): Omit<GithubIssueOrigin, "type"> | null {
  for (const key of ["uri", "url"] as const) {
    const value = ref[key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    const parsed = originFromText(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function originsFromText(text: string): Array<Omit<GithubIssueOrigin, "type">> {
  const origins: Array<Omit<GithubIssueOrigin, "type">> = [];
  const seen = new Set<string>();
  for (const pattern of [ISSUE_URL_PATTERN, ISSUE_API_URL_PATTERN]) {
    for (const match of text.matchAll(pattern)) {
      if (!match[1] || !match[2] || !match[3]) {
        continue;
      }
      const owner = match[1];
      const repo = match[2];
      const number = Number.parseInt(match[3], 10);
      const key = `${owner}/${repo}#${number}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      origins.push({
        owner,
        repo,
        number,
        uri: `https://github.com/${owner}/${repo}/issues/${number}`,
      });
    }
  }
  return origins;
}

function originFromText(text: string): Omit<GithubIssueOrigin, "type"> | null {
  return originsFromText(text)[0] ?? null;
}

function textualOriginFields(payload: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const plan = payload.plan;
  if (plan !== null && typeof plan === "object" && !Array.isArray(plan)) {
    const narratives = (plan as Record<string, unknown>).narratives;
    if (narratives !== null && typeof narratives === "object" && !Array.isArray(narratives)) {
      const origin = (narratives as Record<string, unknown>).Origin;
      if (typeof origin === "string" && origin.length > 0) {
        texts.push(origin);
      }
    }
  }
  for (const key of ["xBRIEFInfo", "vBRIEFInfo"] as const) {
    const info = payload[key];
    if (info !== null && typeof info === "object" && !Array.isArray(info)) {
      const description = (info as Record<string, unknown>).description;
      if (typeof description === "string" && description.length > 0) {
        texts.push(description);
      }
    }
  }
  return texts;
}

export function compareOriginFreshness(
  briefUpdated: string | null,
  originUpdatedAt: string | null,
): OriginFreshnessKind {
  if (originUpdatedAt === null || originUpdatedAt.trim().length === 0) {
    return "uncomparable";
  }
  if (briefUpdated === null || briefUpdated.trim().length === 0) {
    return "stale";
  }
  const briefMs = Date.parse(briefUpdated);
  const originMs = Date.parse(originUpdatedAt);
  if (Number.isNaN(briefMs) || Number.isNaN(originMs)) {
    return "uncomparable";
  }
  return originMs > briefMs ? "stale" : "current";
}

export function formatOriginStaleMessage(
  origin: GithubIssueOrigin,
  originUpdatedAt: string,
  briefUpdated: string | null,
): string {
  const slug = origin.owner.length > 0 ? `${origin.owner}/${origin.repo}` : "origin";
  const briefStamp = briefUpdated ?? "(missing)";
  return (
    `Origin GitHub issue #${origin.number} (${slug}) is newer than this xBRIEF ` +
    `(origin updated_at=${originUpdatedAt}, brief updated=${briefStamp}). ` +
    ORIGIN_FRESHNESS_REMEDIATION
  );
}

/**
 * Read the origin issue over REST. Returns its `updated_at` and, for the
 * content compare (#7138), its body, state and author login.
 */
export function fetchGithubIssueUpdatedAt(
  origin: GithubIssueOrigin,
  options: { scmCall?: ScmCallFn; cwd?: string } = {},
): OriginIssueSnapshot | { error: string } {
  if (origin.owner.length === 0 || origin.repo.length === 0) {
    return { error: "origin reference is missing owner/repo in the GitHub issue URI" };
  }
  const scmCall = options.scmCall ?? call;
  let result: CompletedProcess;
  try {
    result = scmCall(
      "github-issue",
      "api",
      [`repos/${origin.owner}/${origin.repo}/issues/${origin.number}`],
      { timeout: 30, cwd: options.cwd },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `gh CLI not available (${message})` };
  }
  if (result.returncode !== 0) {
    const stderr = result.stderr.trim();
    return { error: stderr.length > 0 ? stderr : `gh api exited ${result.returncode}` };
  }
  try {
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const updatedAt = payload.updated_at;
    if (typeof updatedAt !== "string" || updatedAt.trim().length === 0) {
      return { error: "origin issue payload lacks updated_at" };
    }
    const snapshot: OriginIssueSnapshot = { updatedAt: updatedAt.trim() };
    if (!Object.hasOwn(payload, "body")) {
      return snapshot;
    }
    const login = asRecord(payload.user)?.login;
    return {
      ...snapshot,
      body: typeof payload.body === "string" ? payload.body : null,
      state: typeof payload.state === "string" ? payload.state : null,
      authorLogin: typeof login === "string" && login.length > 0 ? login : null,
    };
  } catch {
    return { error: "origin issue payload is not valid JSON" };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function slugOf(origin: GithubIssueOrigin): string {
  return origin.owner.length > 0 ? `${origin.owner}/${origin.repo}` : "origin";
}

function sameIssue(a: GithubIssueOrigin, b: GithubIssueOrigin): boolean {
  return (
    a.number === b.number &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/** The authoritative origin of a brief and what the brief holds from it (#7138). */
export type OriginBaseline =
  | {
      readonly kind: "spec-path";
      readonly origin: GithubIssueOrigin;
      readonly record: SpecPathSourceRecord;
      /** Stored scanned body of the same issue, or null (a slice stores the child's). */
      readonly storedBody: string | null;
      readonly acceptance: unknown;
    }
  | {
      readonly kind: "body-route";
      readonly origin: GithubIssueOrigin;
      /** `plan.narratives.Overview`, or "" when ingest wrote none. */
      readonly body: string;
      /** `plan.metadata.issueCommentThread`, or null when ingest stored none. */
      readonly thread: readonly IssueComment[] | null;
    };

function ingestOriginOf(plan: Record<string, unknown>): GithubIssueOrigin | null {
  const origin = asRecord(plan.narratives)?.Origin;
  if (typeof origin !== "string") {
    return null;
  }
  const match = INGEST_ORIGIN_PATTERN.exec(origin.trim());
  const parsed = match?.[1] !== undefined ? originFromText(match[1]) : null;
  return parsed !== null ? { ...parsed, type: "x-xbrief/github-issue" } : null;
}

/**
 * Resolve the authoritative origin and baseline (#7138 item 1). A Spec-path
 * brief uses its source record's issue (the parent for a slice). A body-route
 * brief (ingest Origin, no Spec-path refused-body record) uses the Origin
 * issue, with `Overview` (or "") as its body baseline. Anything else has none.
 */
export function resolveOriginBaseline(payload: Record<string, unknown>): OriginBaseline | null {
  const plan = asRecord(payload.plan);
  if (plan === null) {
    return null;
  }
  const meta = asRecord(plan.metadata);
  const ingestOrigin = ingestOriginOf(plan);
  const record = readSpecPathSourceRecord(plan);
  if (record !== null) {
    const [owner = "", repo = ""] = record.repo.split("/");
    const origin: GithubIssueOrigin = {
      owner,
      repo,
      number: record.issue,
      uri: `https://github.com/${record.repo}/issues/${record.issue}`,
      type: "x-directive/spec-path-source",
    };
    const storedBody =
      ingestOrigin !== null &&
      sameIssue(ingestOrigin, origin) &&
      typeof meta?.issueBody === "string"
        ? meta.issueBody
        : null;
    return { kind: "spec-path", origin, record, storedBody, acceptance: plan.acceptance };
  }
  if (meta !== null && Object.hasOwn(meta, "issueBody") && typeof meta.issueBody === "string") {
    return null;
  }
  if (ingestOrigin === null) {
    return null;
  }
  const overview = asRecord(plan.narratives)?.Overview;
  const rawThread = meta?.[ISSUE_COMMENT_THREAD_KEY];
  const thread = Array.isArray(rawThread)
    ? rawThread.filter((row): row is IssueComment => asRecord(row) !== null)
    : null;
  return {
    kind: "body-route",
    origin: ingestOrigin,
    body: typeof overview === "string" ? overview : "",
    thread,
  };
}

/** Body text for the compare: line ends and trailing whitespace ignored. */
function normalizeBodyForCompare(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

function scannedBody(body: string): string {
  return scan(body).transformed_content;
}

/** Is `later` newer than `earlier`? Unknown or unparseable stamps count as newer. */
function isNewer(later: string | undefined, earlier: string | null | undefined): boolean {
  if (typeof later !== "string" || typeof earlier !== "string") {
    return true;
  }
  const laterMs = Date.parse(later);
  const earlierMs = Date.parse(earlier);
  if (Number.isNaN(laterMs) || Number.isNaN(earlierMs)) {
    return true;
  }
  return laterMs > earlierMs;
}

function commentIdOf(comment: IssueComment): number | null {
  const id = Number(comment.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function commentUrl(origin: GithubIssueOrigin, comment: IssueComment): string {
  if (typeof comment.html_url === "string" && comment.html_url.length > 0) {
    return comment.html_url;
  }
  return `https://github.com/${origin.owner}/${origin.repo}/issues/${origin.number}#issuecomment-${String(comment.id)}`;
}

function refuse(
  reason: OriginRefusalReason,
  detail: string,
  kind: OriginFreshnessKind = "stale",
): OriginFreshnessResult {
  return {
    ok: false,
    kind,
    reason,
    message: `Origin check refused (reason: ${reason}). ${detail} ${ORIGIN_FRESHNESS_REMEDIATION}`,
  };
}

function shapeRefusal(
  shape: OriginRequirementShape,
  origin: GithubIssueOrigin,
  comment: IssueComment,
  what: string,
): OriginFreshnessResult {
  const reason: OriginRefusalReason =
    shape === "permission-unknown" ? "author permission unknown" : "requirement comment";
  const why =
    shape === "permission-unknown"
      ? "carries an Acceptance Criteria list and its author's write permission could not be read"
      : `has a requirement shape (${shape})`;
  return refuse(
    reason,
    `Comment ${String(comment.id)} on origin GitHub issue #${origin.number} (${slugOf(origin)}) ${what} and ${why}: ${commentUrl(origin, comment)}.`,
  );
}

/** One `WARN:` line for a drifted authoritative origin: ids and URLs only. */
function formatDriftWarning(
  origin: GithubIssueOrigin,
  originUpdatedAt: string,
  briefUpdated: string | null,
  unread: readonly IssueComment[],
  bodyNote: string,
): string {
  const head =
    `origin GitHub issue #${origin.number} (${slugOf(origin)}) changed after this xBRIEF ` +
    `(origin updated_at=${originUpdatedAt}, brief updated=${briefUpdated ?? "(missing)"}) ` +
    `with no requirement change${bodyNote}`;
  if (unread.length === 0) {
    return `${head}; no newer comments (a label, close or same-content edit).`;
  }
  const list = unread
    .map((comment) => `${String(comment.id)} ${commentUrl(origin, comment)}`)
    .join(", ");
  return `${head}; ${unread.length} newer comment(s): ${list}. Read them before implementing (#2143).`;
}

interface CompareDeps {
  readonly fetchComments: FetchOriginComments;
  readonly mayWrite: (login: string) => boolean | null;
  readonly fetchSpecPath: (record: SpecPathSourceRecord) => SpecPathLiveIdentities;
}

function readThread(
  origin: GithubIssueOrigin,
  deps: CompareDeps,
): { readonly comments: readonly IssueComment[] } | { readonly refused: OriginFreshnessResult } {
  const thread = deps.fetchComments(origin);
  if (!thread.ok) {
    return {
      refused: refuse(
        "origin unavailable",
        `Could not read the comment thread of origin GitHub issue #${origin.number} (${slugOf(origin)}): ${thread.reason}.`,
        "uncomparable",
      ),
    };
  }
  return { comments: thread.comments };
}

/** Body-route compare on drift (#7138 items 2-3). */
function compareBodyRoute(
  baseline: Extract<OriginBaseline, { kind: "body-route" }>,
  snapshot: OriginIssueSnapshot,
  briefUpdated: string | null,
  deps: CompareDeps,
): OriginFreshnessResult {
  const { origin } = baseline;
  if (snapshot.body === undefined) {
    return refuse(
      "origin unavailable",
      `The body of origin GitHub issue #${origin.number} (${slugOf(origin)}) was not read.`,
      "uncomparable",
    );
  }
  if (
    normalizeBodyForCompare(scannedBody(snapshot.body ?? "")) !==
    normalizeBodyForCompare(baseline.body)
  ) {
    return refuse(
      "origin body changed",
      `The body of origin GitHub issue #${origin.number} (${slugOf(origin)}) differs from the body this xBRIEF was ingested from.`,
    );
  }
  const thread = readThread(origin, deps);
  if ("refused" in thread) {
    return thread.refused;
  }
  const live = thread.comments;
  const liveById = new Map<number, IssueComment>();
  for (const comment of live) {
    const id = commentIdOf(comment);
    if (id !== null) {
      liveById.set(id, comment);
    }
  }
  const issueAuthor = snapshot.authorLogin ?? null;
  const storedById = new Map<number, IssueComment>();
  if (baseline.thread !== null) {
    const storedShapeId = selectedCurrentShapeId(baseline.thread);
    for (const stored of baseline.thread) {
      const id = commentIdOf(stored);
      if (id === null) {
        continue;
      }
      storedById.set(id, stored);
      const now = liveById.get(id);
      if (now !== undefined && !isNewer(now.updated_at, stored.updated_at)) {
        continue;
      }
      const shape = classifyOriginRequirementShape({
        comment: stored,
        currentShapeId: storedShapeId,
        issueAuthor,
        mayWrite: deps.mayWrite,
      });
      if (shape !== null) {
        return shapeRefusal(
          shape,
          origin,
          stored,
          now === undefined ? "was deleted after ingest" : "was edited after ingest",
        );
      }
    }
  }
  const unread = live.filter((comment) => {
    const id = commentIdOf(comment);
    if (baseline.thread === null) {
      return isNewer(comment.updated_at ?? comment.created_at, briefUpdated);
    }
    const stored = id !== null ? storedById.get(id) : undefined;
    return stored === undefined || isNewer(comment.updated_at, stored.updated_at);
  });
  const liveShapeId = selectedCurrentShapeId(live);
  for (const comment of unread) {
    const shape = classifyOriginRequirementShape({
      comment,
      currentShapeId: liveShapeId,
      issueAuthor,
      mayWrite: deps.mayWrite,
    });
    if (shape !== null) {
      return shapeRefusal(shape, origin, comment, "is new or edited since ingest");
    }
  }
  return {
    ok: true,
    kind: "current",
    warnings: [formatDriftWarning(origin, snapshot.updatedAt, briefUpdated, unread, "")],
  };
}

function normalizeIdentityText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Spec-path compare on drift (#7138 item 4): source digest, then live comment shapes. */
function compareSpecPath(
  baseline: Extract<OriginBaseline, { kind: "spec-path" }>,
  snapshot: OriginIssueSnapshot,
  briefUpdated: string | null,
  deps: CompareDeps,
): OriginFreshnessResult {
  const { origin, record } = baseline;
  const source = `lean ${record.leanCommentId} of #${record.issue} (${record.repo})`;
  const live = deps.fetchSpecPath(record);
  if (!live.ok) {
    return live.kind === "mismatch"
      ? refuse("Spec-path source changed", `Spec-path source ${source}: ${live.reason}.`)
      : refuse(
          "origin unavailable",
          `Spec-path source ${source} could not be read: ${live.reason}.`,
          "uncomparable",
        );
  }
  // The same pin compare verify:ac runs for a brief not on the merge base.
  const liveDigest = digestAdmittedSourceSentences(live.identities.map(normalizeIdentityText));
  const working = readAdmittedSourceSentences(baseline.acceptance);
  const recordedDigest = readAdmittedSourceDigest(baseline.acceptance);
  const workingDigest =
    working !== null ? digestAdmittedSourceSentences(working.map(normalizeIdentityText)) : null;
  if (
    (workingDigest !== null && workingDigest !== liveDigest) ||
    (recordedDigest !== null && recordedDigest !== liveDigest)
  ) {
    return refuse(
      "Spec-path source changed",
      `The brief's pin disagrees with Spec-path source ${source}.`,
    );
  }
  const thread = readThread(origin, deps);
  if ("refused" in thread) {
    return thread.refused;
  }
  // The stored thread may belong to a slice's child issue, so newer comments
  // are judged by their live shape alone.
  const unread = thread.comments.filter((comment) =>
    isNewer(comment.updated_at ?? comment.created_at, briefUpdated),
  );
  const liveShapeId = selectedCurrentShapeId(thread.comments);
  for (const comment of unread) {
    const shape = classifyOriginRequirementShape({
      comment,
      currentShapeId: liveShapeId,
      issueAuthor: snapshot.authorLogin ?? null,
      mayWrite: deps.mayWrite,
    });
    if (shape !== null) {
      return shapeRefusal(shape, origin, comment, "is newer than this xBRIEF");
    }
  }
  let bodyNote = "";
  if (typeof snapshot.body === "string" && baseline.storedBody !== null) {
    const changed =
      normalizeBodyForCompare(scannedBody(snapshot.body)) !==
      normalizeBodyForCompare(baseline.storedBody);
    bodyNote = changed
      ? " (its body changed; the lean, not the body, is this brief's contract)"
      : "";
  }
  return {
    ok: true,
    kind: "current",
    warnings: [formatDriftWarning(origin, snapshot.updatedAt, briefUpdated, unread, bodyNote)],
  };
}

function defaultFetchOriginComments(cwd: string | undefined): FetchOriginComments {
  return (origin) => {
    if (origin.owner.length === 0 || origin.repo.length === 0) {
      return { ok: false, reason: "origin reference is missing owner/repo" };
    }
    try {
      return {
        ok: true,
        comments: fetchIssueComments(`${origin.owner}/${origin.repo}`, origin.number, { cwd }),
      };
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

function defaultFetchAuthorWritePermission(cwd: string | undefined): FetchAuthorWritePermission {
  return (repo, login) => {
    const answer = hasWritePermission(
      {
        getJson: (path) => {
          try {
            const result = call("github-issue", "api", [path], { timeout: 30, cwd });
            if (result.returncode !== 0) {
              return { ok: false, detail: result.stderr.trim() || `exit ${result.returncode}` };
            }
            return { ok: true, value: JSON.parse(result.stdout) as unknown };
          } catch (err: unknown) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
          }
        },
      },
      repo,
      login,
    );
    return answer.ok ? answer.value : null;
  };
}

/** Today's timestamp-only check, kept for a brief with no baseline (#3363). */
function evaluateTimestampOnly(
  origins: readonly GithubIssueOrigin[],
  fetch: FetchOriginUpdatedAt,
  briefUpdated: string | null,
): OriginFreshnessResult {
  for (const origin of origins) {
    const fetched = fetch(origin);
    if ("error" in fetched) {
      return refuse(
        "origin unavailable",
        `Could not fetch origin GitHub issue #${origin.number} for freshness check: ${fetched.error}.`,
        "uncomparable",
      );
    }
    const kind = compareOriginFreshness(briefUpdated, fetched.updatedAt);
    if (kind === "stale") {
      return {
        ok: false,
        kind,
        reason: "no baseline",
        message: `Origin check refused (reason: no baseline). ${formatOriginStaleMessage(origin, fetched.updatedAt, briefUpdated)}`,
      };
    }
    if (kind === "uncomparable") {
      return refuse(
        "origin unavailable",
        `Could not compare origin GitHub issue #${origin.number} updated_at=${fetched.updatedAt} ` +
          `to brief updated=${briefUpdated ?? "(missing)"}.`,
        "uncomparable",
      );
    }
  }
  return { ok: true, kind: "current" };
}

/**
 * Origin freshness for `xbrief:preflight` (#3363, content compare #7138).
 *
 * The authoritative origin's `updated_at` is the cheap first check: no drift
 * passes. On drift a brief with a baseline is compared by content: a changed
 * body, a requirement-shaped comment that is new, edited or deleted, a changed
 * Spec-path source, an unknown author permission or an unreadable thread
 * refuses; other activity passes with one `WARN:` line (ids and URLs only).
 * Other origins and a closed authoritative origin only warn. A brief with no
 * baseline keeps the timestamp refusal.
 */
export function evaluateOriginFreshness(
  payload: Record<string, unknown>,
  options: EvaluateOriginFreshnessOptions = {},
): OriginFreshnessResult {
  if (options.skip === true) {
    return { ok: true, kind: "no-origin" };
  }
  const origins = extractGithubIssueOrigins(payload);
  const baseline = resolveOriginBaseline(payload);
  const fetch =
    options.fetchOriginUpdatedAt ??
    ((next) => fetchGithubIssueUpdatedAt(next, { cwd: options.cwd }));
  const briefUpdated = briefUpdatedOf(payload);
  if (baseline === null) {
    if (origins.length === 0) {
      return { ok: true, kind: "no-origin" };
    }
    return evaluateTimestampOnly(origins, fetch, briefUpdated);
  }

  const { origin } = baseline;
  const fetched = fetch(origin);
  if ("error" in fetched) {
    return refuse(
      "origin unavailable",
      `Could not fetch origin GitHub issue #${origin.number} for freshness check: ${fetched.error}.`,
      "uncomparable",
    );
  }
  const kind = compareOriginFreshness(briefUpdated, fetched.updatedAt);
  if (kind === "uncomparable") {
    return refuse(
      "origin unavailable",
      `Could not compare origin GitHub issue #${origin.number} updated_at=${fetched.updatedAt} ` +
        `to brief updated=${briefUpdated ?? "(missing)"}.`,
      "uncomparable",
    );
  }
  const warnings: string[] = [];
  if (kind === "stale") {
    const permissionCache = new Map<string, boolean | null>();
    const lookup =
      options.fetchAuthorWritePermission ?? defaultFetchAuthorWritePermission(options.cwd);
    const deps: CompareDeps = {
      fetchComments: options.fetchOriginComments ?? defaultFetchOriginComments(options.cwd),
      mayWrite: (login) => {
        const key = login.toLowerCase();
        if (!permissionCache.has(key)) {
          permissionCache.set(key, lookup(`${origin.owner}/${origin.repo}`, login));
        }
        return permissionCache.get(key) ?? null;
      },
      fetchSpecPath:
        options.fetchSpecPathLiveIdentities ?? ((record) => fetchSpecPathLiveIdentities(record)),
    };
    const compared =
      baseline.kind === "body-route"
        ? compareBodyRoute(baseline, fetched, briefUpdated, deps)
        : compareSpecPath(baseline, fetched, briefUpdated, deps);
    if (!compared.ok) {
      return compared;
    }
    warnings.push(...(compared.warnings ?? []));
  }
  if (typeof fetched.state === "string" && fetched.state.toLowerCase() === "closed") {
    warnings.push(
      `origin GitHub issue #${origin.number} (${slugOf(origin)}) is closed; closure alone does not refuse. Confirm the work is still wanted.`,
    );
  }
  for (const other of origins) {
    if (sameIssue(other, origin)) {
      continue;
    }
    const otherFetched = fetch(other);
    if ("error" in otherFetched) {
      warnings.push(
        `referenced origin GitHub issue #${other.number} (${slugOf(other)}) could not be fetched (${otherFetched.error}); it is not this brief's authoritative origin (#${origin.number}), so it does not refuse.`,
      );
      continue;
    }
    if (compareOriginFreshness(briefUpdated, otherFetched.updatedAt) !== "current") {
      warnings.push(
        `referenced origin GitHub issue #${other.number} (${slugOf(other)}) updated_at=${otherFetched.updatedAt} is newer than this xBRIEF; it is not the authoritative origin (#${origin.number}), so it does not refuse. Read it before implementing (#2143).`,
      );
    }
  }
  return warnings.length > 0
    ? { ok: true, kind: "current", warnings }
    : { ok: true, kind: "current" };
}
