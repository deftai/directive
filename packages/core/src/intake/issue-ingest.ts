import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { cacheGet } from "../cache/operations.js";
import { type ScanFlag, scan } from "../cache/scanner.js";
import { assertWriteTargetSafe, ProjectionContainmentError } from "../fs/projection-containment.js";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { captureAndAttachLiteralAcceptance } from "../literal-acceptance/index.js";
import { stampAcceptanceFromLiteralCapture } from "../product-first-done-gate/index.js";
import { type CompletedProcess, call } from "../scm/call.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import { resolveProjectRepo } from "../slice/project-context.js";
import {
  countMaintainerCurrentShapeComments,
  mapIssueCommentEntry,
  RAW_ISSUE_COMMENTS_KEY,
  type IssueComment as ShapeIssueComment,
  selectCurrentShapeComment,
} from "../umbrella-current-shape/index.js";
import { slugify, TODAY } from "../vbrief-build/build.js";
import { EMITTED_VBRIEF_VERSION } from "../vbrief-build/constants.js";
import { stampDerivedClausesOnAcceptance } from "../verify-ac/clauses.js";
import {
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_INFO_ROOT_KEY,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
  VBRIEF_VERSION,
} from "../xbrief-migrate/constants.js";
import { applyClauseQualityForIngest, emitAcceptanceStampFromPlan } from "./clause-derivation.js";
import {
  findAcHeading,
  parseCheckboxItems,
  parseListItems,
  sliceAcSection,
  stripCodeBlocks,
  stripFencedCodeBlocks,
} from "./markdown-scanners.js";
import {
  detectRepo,
  extractReferencesFromVbrief,
  fetchOpenIssues,
  GITHUB_ISSUE_REF_TYPES,
  LIFECYCLE_FOLDERS,
  parseIssueNumber,
  type ScmCallFn,
} from "./reconcile-issues.js";

/** Reference type pointing at the canonical current-shape comment permalink (#1870). */
export const CURRENT_SHAPE_REF_TYPE = "x-xbrief/current-shape" as const;

export const INGEST_STATUSES = ["proposed", "pending", "active"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

/**
 * Thrown when the quarantine scanner hard-fails (credential-shaped content) on
 * an ingested issue body/comment thread (#2306). Ingest MUST fail closed: emit
 * nothing and propagate a non-zero exit rather than persisting the xBRIEF.
 */
export class ScannerHardFailError extends Error {
  readonly issueNumber: number;
  readonly flags: readonly ScanFlag[];

  constructor(issueNumber: number, flags: readonly ScanFlag[]) {
    const details = flags
      .filter((f) => f.severity === "hard-fail")
      .map((f) => f.detail)
      .join("; ");
    super(
      `issue:ingest refused #${issueNumber}: quarantine scanner hard-fail` +
        (details.length > 0 ? ` (${details})` : "") +
        " -- nothing written.",
    );
    this.name = "ScannerHardFailError";
    this.issueNumber = issueNumber;
    this.flags = flags;
  }
}

/** GitHub issue comment thread entry (REST `repos/.../issues/N/comments`). */
export interface IssueComment {
  readonly id?: number;
  readonly body?: string;
  readonly user?: { readonly login?: string };
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly html_url?: string;
  readonly author_association?: string;
}

/** Enriched on issues after `fetchIssue` when the comment thread is non-empty (#2143). */
export const ISSUE_COMMENT_THREAD_KEY = "issueCommentThread" as const;

/**
 * Map ingest/REST comment rows onto the umbrella-current-shape selector input
 * so #1152 pass-N + #2307 maintainer provenance rules apply (#1870).
 */
export function mapIngestCommentsToShapeComments(
  comments: readonly IssueComment[],
): ShapeIssueComment[] {
  const out: ShapeIssueComment[] = [];
  for (const comment of comments) {
    const mapped = mapIssueCommentEntry(comment);
    if (mapped !== null) {
      out.push(mapped);
    }
  }
  return out;
}

/**
 * Select the canonical current-shape comment from an ingest comment thread.
 * Returns null when none is maintainer-authored / header-matched.
 */
export function selectIngestCurrentShape(
  comments: readonly IssueComment[],
): (ShapeIssueComment & { pass: number }) | null {
  return selectCurrentShapeComment(mapIngestCommentsToShapeComments(comments));
}

/** Count maintainer current-shape comments (lint surface for !=1). */
export function countIngestCurrentShapeComments(comments: readonly IssueComment[]): number {
  return countMaintainerCurrentShapeComments(mapIngestCommentsToShapeComments(comments));
}

const STATUS_MAP: Record<IngestStatus, [string, string]> = {
  proposed: ["proposed", "proposed"],
  pending: ["pending", "pending"],
  active: ["active", "running"],
};

interface IngestEmissionLayout {
  readonly artifactSuffix: typeof LEGACY_ARTIFACT_SUFFIX | typeof MIGRATED_ARTIFACT_SUFFIX;
  readonly infoRootKey: typeof LEGACY_INFO_ROOT_KEY | typeof MIGRATED_INFO_ROOT_KEY;
  readonly infoVersion: string;
}

function readDeclaredInfoVersion(
  vbriefDir: string,
  infoRootKey: typeof LEGACY_INFO_ROOT_KEY | typeof MIGRATED_INFO_ROOT_KEY,
  artifactSuffix: typeof LEGACY_ARTIFACT_SUFFIX | typeof MIGRATED_ARTIFACT_SUFFIX,
  fallbackVersion: string,
): string {
  const projectDefinitionPath = join(vbriefDir, `PROJECT-DEFINITION${artifactSuffix}`);
  try {
    const parsed = JSON.parse(readFileSync(projectDefinitionPath, "utf8")) as Record<
      string,
      unknown
    >;
    const info = parsed[infoRootKey];
    if (info !== null && typeof info === "object" && !Array.isArray(info)) {
      const declared = (info as Record<string, unknown>).version;
      if (typeof declared === "string" && declared.length > 0) {
        return declared;
      }
    }
  } catch {
    // Fall back to the schema-default version when no declaration is available.
  }
  return fallbackVersion;
}

/**
 * Decide the emission format (`.xbrief.json` + `xBRIEFInfo` vs legacy `.vbrief.json`
 * + `vBRIEFInfo`) for an ingested scope artifact.
 *
 * The decision is STRUCTURAL and keyed on the resolved lifecycle root directory
 * (`vbriefDir`), which is itself produced by `resolveLifecycleLayout` / `resolveLifecycleRoot`
 * -- the exact same layout-decision logic `project:render` uses. This guarantees the two
 * surfaces cannot diverge (#2149 finding #1): whichever tree `resolveLifecycleLayout` selected
 * (`xbrief/` when migrated, else `vbrief/`) is the tree ingest writes into, and the emission
 * format always matches that directory.
 *
 * It deliberately does NOT content-scan the tree for legacy markers (`detectLegacyVbriefLayout`).
 * A historical vBRIEF-serialized artifact sitting in `xbrief/completed/` is migrated content,
 * not a legacy layout, and must NOT force legacy emission on a migrated project (#2149 finding #3).
 */
function resolveIngestEmissionLayout(vbriefDir: string): IngestEmissionLayout {
  const migrated = basename(vbriefDir) === MIGRATED_ARTIFACT_DIR;
  if (!migrated) {
    return {
      artifactSuffix: LEGACY_ARTIFACT_SUFFIX,
      infoRootKey: LEGACY_INFO_ROOT_KEY,
      infoVersion: EMITTED_VBRIEF_VERSION,
    };
  }
  return {
    artifactSuffix: MIGRATED_ARTIFACT_SUFFIX,
    infoRootKey: MIGRATED_INFO_ROOT_KEY,
    infoVersion: readDeclaredInfoVersion(
      vbriefDir,
      MIGRATED_INFO_ROOT_KEY,
      MIGRATED_ARTIFACT_SUFFIX,
      VBRIEF_VERSION,
    ),
  };
}

const CONTROL_CHAR_LABELS: Record<string, string> = {
  "\b": "U+0008 backspace",
  "\t": "U+0009 tab",
  "\v": "U+000B vertical tab",
  "\f": "U+000C form feed",
};

const ORIGIN_URL_PATTERN = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/;
const ORIGIN_BARE_PATTERN = /issue\s*#(\d+)/i;

const CROSS_REF_PATTERNS: readonly [string, RegExp][] = [
  ["x-xbrief/closes", /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i],
  ["x-xbrief/blocks", /\bblocked[\s-]+by\s+#(\d+)\b/i],
  ["x-xbrief/refs", /\b(?:refs?|references?|see\s+also|related(?:\s+to)?)\s+#(\d+)\b/i],
];

function hasNonIndentationPrefix(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  for (let i = lineStart; i < index; i += 1) {
    const ch = text[i];
    if (ch !== " " && ch !== "\t") {
      return true;
    }
  }
  return false;
}

export function bodyControlCharacterLabels(body: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (char === "\t" && !hasNonIndentationPrefix(body, index)) {
      continue;
    }
    let label = CONTROL_CHAR_LABELS[char];
    if (label === undefined) {
      const code = char.charCodeAt(0);
      if (code < 32 && char !== "\n" && char !== "\r") {
        label = `U+${code.toString(16).padStart(4, "0").toUpperCase()} control character`;
      }
    }
    if (label !== undefined && !seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
  }
  return labels;
}

export function warnBodyControlCharacters(number: number, body: string): void {
  const labels = bodyControlCharacterLabels(body);
  if (labels.length === 0) {
    return;
  }
  process.stderr.write(
    `Warning: issue #${number} body contains unexpected control characters (${labels.join(", ")}); preserving Overview verbatim, but verify_encoding will flag the generated vBRIEF narrative.\n`,
  );
}

export function extractPlanItems(body: string): Record<string, string>[] {
  if (body.length === 0) {
    return [];
  }
  const text = stripFencedCodeBlocks(body);
  const checkboxItems = parseCheckboxItems(text);
  if (checkboxItems.length > 0) {
    return checkboxItems.map((item) => ({ title: item.title, status: item.status }));
  }
  return extractAcSectionItems(text);
}

export function extractAcSectionItems(text: string): Record<string, string>[] {
  const heading = findAcHeading(text);
  if (heading === null) {
    return [];
  }
  const sectionText = sliceAcSection(text, heading);
  return parseListItems(sectionText).map((item) => ({
    title: item.title,
    status: item.status,
  }));
}

export function extractCrossRefs(
  body: string,
  repoUrl: string,
  exclude: ReadonlySet<number> = new Set(),
): Record<string, string>[] {
  if (body.length === 0 || repoUrl.length === 0) {
    return [];
  }
  const text = stripCodeBlocks(body);
  const refs: Record<string, string>[] = [];
  const seen = new Set<string>();

  for (const [refType, pattern] of CROSS_REF_PATTERNS) {
    const re = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of text.matchAll(re)) {
      const number = Number.parseInt(match[1] as string, 10);
      if (!exclude.has(number)) {
        const key = `${refType}:${number}`;
        if (!seen.has(key)) {
          seen.add(key);
          refs.push({
            uri: `${repoUrl}/issues/${number}`,
            type: refType,
            title: `Issue #${number}`,
          });
        }
      }
    }
  }
  return refs;
}

export function provenanceIssueNumber(data: Record<string, unknown>): number | null {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const narratives = (plan.narratives ?? {}) as Record<string, unknown>;
  const origin = narratives.Origin;
  const info = (data.vBRIEFInfo ?? {}) as Record<string, unknown>;
  const description = info.description;

  for (const text of [origin, description]) {
    if (typeof text !== "string" || text.length === 0) {
      continue;
    }
    let m = ORIGIN_URL_PATTERN.exec(text);
    if (m?.[1]) {
      return Number.parseInt(m[1], 10);
    }
    m = ORIGIN_BARE_PATTERN.exec(text);
    if (m?.[1]) {
      return Number.parseInt(m[1], 10);
    }
  }
  return null;
}

export function scanProvenanceRefs(vbriefDir: string): Map<number, string[]> {
  const issueToVbriefs = new Map<number, string[]>();

  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    try {
      if (!statSync(folderPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const files = readdirSync(folderPath)
      .filter((f) => hasArtifactSuffix(f))
      .sort();
    for (const filename of files) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(readFileSync(join(folderPath, filename), "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }

      const refs = extractReferencesFromVbrief(data);
      const githubRefs: [Record<string, unknown>, number][] = [];
      for (const ref of refs) {
        if (!GITHUB_ISSUE_REF_TYPES.has(String(ref.type ?? ""))) {
          continue;
        }
        const num = parseIssueNumber(ref);
        if (num !== null) {
          githubRefs.push([ref, num]);
        }
      }
      if (githubRefs.length === 0) {
        continue;
      }

      const provenanceNum = provenanceIssueNumber(data);
      let ownerNum: number;
      if (provenanceNum !== null) {
        if (!githubRefs.some(([, num]) => num === provenanceNum)) {
          continue;
        }
        ownerNum = provenanceNum;
      } else {
        ownerNum = githubRefs[0]?.[1] as number;
      }

      const relPath = `${folder}/${filename}`;
      const existing = issueToVbriefs.get(ownerNum) ?? [];
      existing.push(relPath);
      issueToVbriefs.set(ownerNum, existing);
    }
  }
  return issueToVbriefs;
}

export function composeOverviewWithComments(
  body: string,
  comments: readonly IssueComment[],
): string {
  if (comments.length === 0) {
    return body;
  }
  const parts: string[] = [];
  if (body.length > 0) {
    parts.push(body);
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  parts.push("## Issue comment thread");
  parts.push("");
  parts.push(
    "_The issue body is the original write-up; maintainer comments below may supersede it. Read the full thread before building a dispatch envelope (#2143)._",
  );
  parts.push("");
  for (const comment of comments) {
    const author = comment.user?.login ?? "unknown";
    const when = comment.created_at ?? "";
    const header =
      when.length > 0 ? `### Comment by @${author} (${when})` : `### Comment by @${author}`;
    parts.push(header);
    parts.push("");
    parts.push(typeof comment.body === "string" ? comment.body : "");
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

export function issueCommentThread(issue: Record<string, unknown>): IssueComment[] {
  const raw = issue[ISSUE_COMMENT_THREAD_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is IssueComment => entry !== null && typeof entry === "object");
}

export function issueCommentsAlreadyFetched(issue: Record<string, unknown>): boolean {
  return Object.hasOwn(issue, ISSUE_COMMENT_THREAD_KEY);
}

/**
 * Run quarantine `scan()` on untrusted ingest text (#2447). Fail closed on a
 * credential hard-fail; return the fenced/quarantined transform for soft signals.
 */
function scanUntrustedIngestText(issueNumber: number, text: string): string {
  const scanResult = scan(text);
  const hardFails = scanResult.flags.filter((f) => f.severity === "hard-fail");
  if (hardFails.length > 0) {
    throw new ScannerHardFailError(issueNumber, scanResult.flags);
  }
  return scanResult.transformed_content;
}

export function buildIssueVbrief(
  issue: Record<string, unknown>,
  status: IngestStatus,
  repoUrl: string,
  options: {
    infoRootKey?: typeof LEGACY_INFO_ROOT_KEY | typeof MIGRATED_INFO_ROOT_KEY;
    infoVersion?: string;
  } = {},
): [Record<string, unknown>, string] {
  const number = Number(issue.number);
  const titleRaw =
    (typeof issue.title === "string" && issue.title.length > 0
      ? issue.title
      : `Issue #${number}`) || `Issue #${number}`;
  // #2447: quarantine-scan issue title before it lands in agent-authoritative fields.
  const title = scanUntrustedIngestText(number, titleRaw);
  const url =
    (typeof issue.url === "string" && issue.url.length > 0 ? issue.url : "") ||
    (repoUrl.length > 0 ? `${repoUrl}/issues/${number}` : "");
  const bodyRaw = issue.body;
  const bodyStr = typeof bodyRaw === "string" && bodyRaw.length > 0 ? bodyRaw : "";
  const commentThread = issueCommentThread(issue);
  const overviewSource =
    commentThread.length > 0 ? composeOverviewWithComments(bodyStr, commentThread) : bodyStr;
  // #1870 / #1152: materialize the canonical Current shape comment as its own
  // narrative so agents cannot plan umbrellas from the stale body alone. Prefer
  // the same selector as `task umbrella:current-shape` (highest pass-N,
  // maintainer-authored only — #2307).
  const currentShape = selectIngestCurrentShape(commentThread);
  const labelsRaw = issue.labels;
  const labelNames: string[] = [];
  if (Array.isArray(labelsRaw)) {
    for (const lbl of labelsRaw) {
      let rawName: string | undefined;
      if (typeof lbl === "string") {
        rawName = lbl;
      } else if (lbl !== null && typeof lbl === "object" && !Array.isArray(lbl)) {
        const name = (lbl as Record<string, unknown>).name;
        if (typeof name === "string" && name.length > 0) {
          rawName = name;
        }
      }
      if (rawName === undefined || rawName.length === 0) {
        continue;
      }
      // #2916: label names copy unchanged into narratives.Labels and plan.tags --
      // agent-authoritative fields. Quarantine-scan them under the same contract as
      // titles/body: hard-fail closed on credential-shaped labels, fence/omit
      // injection-shaped labels. (cache-quarantine-06, tracker #2904)
      labelNames.push(scanUntrustedIngestText(number, rawName));
    }
  }

  const [folder, planStatus] = STATUS_MAP[status];
  const narratives: Record<string, string> = {
    Description: title,
    Origin: url.length > 0 ? `Ingested from ${url}` : `Ingested from issue #${number}`,
  };
  if (overviewSource.length > 0) {
    warnBodyControlCharacters(number, overviewSource);
    // #2306: quarantine-scan untrusted body + comment-thread content before it
    // is persisted as agent-facing scope authority. Fail closed on a credential
    // hard-fail; otherwise persist the fenced/quarantined transform.
    const scanResult = scan(overviewSource);
    if (!scanResult.passed) {
      throw new ScannerHardFailError(number, scanResult.flags);
    }
    narratives.Overview = scanResult.transformed_content;
  }
  if (currentShape !== null) {
    // Scan shape body under the same fail-closed contract as Overview (#2306).
    narratives.CurrentShape = scanUntrustedIngestText(number, currentShape.body);
  }
  if (labelNames.length > 0) {
    narratives.Labels = labelNames.join(", ");
  }

  const planItemsRaw = bodyStr.length > 0 ? extractPlanItems(bodyStr) : [];
  // #2447: scan each derived plan-item title (empty-body issues still scan title above).
  const planItems = planItemsRaw.map((item) => ({
    ...item,
    title: scanUntrustedIngestText(number, String(item.title ?? "")),
  }));
  const plan: Record<string, unknown> = {
    title,
    status: planStatus,
    narratives,
    items: planItems,
  };
  if (labelNames.length > 0) {
    plan.tags = [...labelNames];
  }

  if (url.length > 0) {
    const references: Record<string, string>[] = [
      {
        uri: url,
        type: "x-xbrief/github-issue",
        title: `Issue #${number}: ${title}`,
      },
    ];
    if (currentShape !== null) {
      const shapeUri =
        currentShape.htmlUrl.length > 0
          ? currentShape.htmlUrl
          : `${url}#issuecomment-${currentShape.id}`;
      references.push({
        uri: shapeUri,
        type: CURRENT_SHAPE_REF_TYPE,
        title: `Current shape (pass-${currentShape.pass}) for #${number}`,
      });
    }
    if (overviewSource.length > 0 && repoUrl.length > 0) {
      references.push(...extractCrossRefs(overviewSource, repoUrl, new Set([number])));
    }
    plan.references = references;
  }

  // #3267: capture exact stated acceptance commands from the issue body at intake
  // into plan.metadata.literal_acceptance_commands (source=task_statement, capture-only).
  // Agents MUST promote exact strings into swarm.verify_commands before shell execution
  // (Greptile P1: raw issue text must not auto-spawn). Not paraphrased.
  if (bodyStr.length > 0) {
    const intakeText = [title, bodyStr].filter((s) => s.length > 0).join("\n\n");
    const attached = captureAndAttachLiteralAcceptance(plan, intakeText);
    // Re-tag stored capture as task_statement so run refuses until promote.
    const meta = attached.plan.metadata as Record<string, unknown> | undefined;
    if (meta !== undefined && Array.isArray(meta.literal_acceptance_commands)) {
      meta.literal_acceptance_commands = (
        meta.literal_acceptance_commands as Record<string, unknown>[]
      ).map((row) => ({ ...row, source: "task_statement" }));
      // Do not copy untrusted issue text into swarm.verify_commands (executable).
      const swarm = meta.swarm as Record<string, unknown> | undefined;
      if (swarm !== undefined && Array.isArray(swarm.verify_commands)) {
        // Keep only pre-existing verify_commands that were not just attached from capture.
        // captureAndAttach merges captured into verify_commands — strip those that match
        // task_statement captures so issue text cannot auto-execute.
        const capturedSet = new Set(
          (meta.literal_acceptance_commands as { command?: string }[])
            .map((r) => (typeof r.command === "string" ? r.command : ""))
            .filter((s) => s.length > 0),
        );
        swarm.verify_commands = (swarm.verify_commands as unknown[]).filter(
          (c) => typeof c === "string" && !capturedSet.has(c),
        );
        if ((swarm.verify_commands as unknown[]).length === 0) {
          delete swarm.verify_commands;
        }
      }
    }
    Object.assign(plan, attached.plan);
    // #3284: stamp plan.acceptance from captured literals (stated or none_stated floor).
    Object.assign(plan, stampAcceptanceFromLiteralCapture(plan));
    // #3323: when no commands were stated, derive numbered clauses before product edit.
    const derived = stampDerivedClausesOnAcceptance(
      plan,
      [title, overviewSource].filter((s) => s.length > 0).join("\n\n"),
    );
    Object.assign(plan, derived.plan);
    applyClauseQualityForIngest(plan);
  } else {
    // No body: still record none_stated acceptance so absence is a decision.
    Object.assign(plan, stampAcceptanceFromLiteralCapture(plan));
  }

  const infoRootKey = options.infoRootKey ?? LEGACY_INFO_ROOT_KEY;
  const infoVersion = options.infoVersion ?? EMITTED_VBRIEF_VERSION;
  const briefLabel = infoRootKey === MIGRATED_INFO_ROOT_KEY ? "xBRIEF" : "vBRIEF";
  return [
    {
      [infoRootKey]: {
        version: infoVersion,
        description: `Scope ${briefLabel} ingested from GitHub issue #${number}`,
      },
      plan,
    },
    folder,
  ];
}

/** Include a refused-stamp remediation on the ingest result so it is not silent. */
export function formatIngestCreatedMessage(
  folder: string,
  filename: string,
  plan: unknown,
  dryRun = false,
): string {
  const lead = dryRun
    ? `DRY-RUN would write ${folder}/${filename}`
    : `CREATED ${folder}/${filename}`;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return lead;
  }
  const acceptance = (plan as { acceptance?: unknown }).acceptance;
  if (typeof acceptance !== "object" || acceptance === null || Array.isArray(acceptance)) {
    return lead;
  }
  const notice = (acceptance as { quality_notice?: unknown }).quality_notice;
  if (typeof notice !== "string" || notice.trim().length === 0) {
    return lead;
  }
  return `${lead}\n${notice.trim()}`;
}

export function targetFilename(
  number: number,
  title: string,
  artifactSuffix:
    | typeof LEGACY_ARTIFACT_SUFFIX
    | typeof MIGRATED_ARTIFACT_SUFFIX = LEGACY_ARTIFACT_SUFFIX,
): string {
  const slug = slugify(title) || `issue-${number}`;
  return `${TODAY}-${number}-${slug}${artifactSuffix}`;
}

export interface FetchIssueOptions {
  readonly cwd?: string | null;
  readonly cacheRoot?: string | null;
  readonly scmCall?: ScmCallFn;
}

/**
 * Strip the `# #<number>: <title>` header that `renderContent` prepends when it
 * materializes an issue's `content.md` at cache-put (#2314). The header is the
 * only shape difference between the cache-read body and the live/raw-body path;
 * removing it makes an ingested xBRIEF's `Overview` identical whether the source
 * was a cache hit or a live fetch. A missing/older-shape header is left intact.
 */
export function stripRenderedIssueHeader(content: string, number: number): string {
  if (!Number.isFinite(number)) {
    return content;
  }
  const header = new RegExp(`^# #${number}:[^\\n]*\\n\\n`);
  return content.replace(header, "");
}

export function fetchFromCache(
  repo: string,
  number: number,
  options: FetchIssueOptions = {},
): Record<string, unknown> | null {
  const key = `${repo}/${number}`;
  try {
    const result = cacheGet("github-issue", key, {
      cacheRoot: options.cacheRoot ?? undefined,
      allowStale: false,
    });
    const rawPath = join(result.entryDir, "raw.json");
    const issue = JSON.parse(readFileSync(rawPath, "utf8")) as Record<string, unknown>;
    if (typeof issue.html_url === "string" && issue.html_url.length > 0) {
      issue.url = issue.html_url;
    }
    // #2306: consume the cache entry's SCANNED content.md (fenced/quarantined at
    // cache-put) rather than the raw body, so the cache read path cannot bypass
    // the quarantine transform. When content.md is absent (e.g. a credential
    // hard-fail deleted it), the raw body falls through and is re-scanned in
    // buildIssueVbrief.
    //
    // #1870 note: content.md may also include the appended Canonical current
    // shape section. That is intentional for agent-facing cache reads. When
    // raw.comments is present we also restore the comment thread so
    // narratives.CurrentShape + the current-shape reference can be materialised
    // offline (without a live comments fetch).
    if (result.contentPath !== null) {
      try {
        // #2314: content.md is `renderContent`-prefixed with a `# #<n>: <title>`
        // header at cache-put. Strip that header so the cache-read Overview
        // matches the live/raw-body path (which has no header), keeping the
        // durable xBRIEF identical for a cache hit vs a live fetch.
        issue.body = stripRenderedIssueHeader(
          readFileSync(result.contentPath, "utf8"),
          Number(issue.number),
        );
      } catch {
        // fall back to the raw body (re-scanned downstream)
      }
    }
    // #1870: restore comment thread from cache raw so CurrentShape survives
    // offline / no-live-gh paths (fetchIssue still prefers live comments).
    if (!issueCommentsAlreadyFetched(issue) && Array.isArray(issue[RAW_ISSUE_COMMENTS_KEY])) {
      return attachIssueCommentThread(issue, issue[RAW_ISSUE_COMMENTS_KEY] as IssueComment[]);
    }
    return issue;
  } catch {
    return null;
  }
}

export function fetchIssueComments(
  repo: string,
  number: number,
  options: FetchIssueOptions = {},
): IssueComment[] {
  const scmCall = options.scmCall ?? call;
  let result: CompletedProcess;
  try {
    result = scmCall("github-issue", "api", [`repos/${repo}/issues/${number}/comments`], {
      timeout: 30,
      cwd: options.cwd ?? undefined,
    });
  } catch {
    return [];
  }
  if (result.returncode !== 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as IssueComment[]) : [];
  } catch {
    return [];
  }
}

export function attachIssueCommentThread(
  issue: Record<string, unknown>,
  comments: readonly IssueComment[],
): Record<string, unknown> {
  return { ...issue, [ISSUE_COMMENT_THREAD_KEY]: [...comments] };
}

export function repoSlugFromUrl(repoUrl: string): string | null {
  const match = /github\.com\/([^/\s]+\/[^/\s]+)/.exec(repoUrl);
  return match?.[1] ?? null;
}

export function enrichIssueWithComments(
  issue: Record<string, unknown>,
  repoUrl: string,
  options: FetchIssueOptions = {},
): Record<string, unknown> {
  if (issueCommentsAlreadyFetched(issue)) {
    return issue;
  }
  const repo = repoSlugFromUrl(repoUrl);
  const number = Number(issue.number);
  if (repo === null || !Number.isFinite(number)) {
    return issue;
  }
  return attachIssueCommentThread(issue, fetchIssueComments(repo, number, options));
}

export function fetchSingleIssue(
  repo: string,
  number: number,
  options: FetchIssueOptions = {},
): Record<string, unknown> | null {
  const scmCall = options.scmCall ?? call;
  let result: CompletedProcess;
  try {
    result = scmCall("github-issue", "api", [`repos/${repo}/issues/${number}`], {
      timeout: 30,
      cwd: options.cwd ?? undefined,
    });
  } catch {
    process.stderr.write("Error: gh CLI not found. Install GitHub CLI.\n");
    return null;
  }

  if (result.returncode !== 0) {
    process.stderr.write(`Error: gh CLI failed fetching #${number}: ${result.stderr.trim()}\n`);
    return null;
  }
  try {
    const issue = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof issue.html_url === "string" && issue.html_url.length > 0) {
      issue.url = issue.html_url;
    }
    return issue;
  } catch {
    process.stderr.write(`Error: failed to parse gh CLI output for #${number}.\n`);
    return null;
  }
}

export function fetchIssue(
  repo: string,
  number: number,
  options: FetchIssueOptions = {},
): Record<string, unknown> | null {
  const live = fetchSingleIssue(repo, number, options);
  if (live !== null) {
    const comments = fetchIssueComments(repo, number, options);
    return attachIssueCommentThread(live, comments);
  }
  const cached = fetchFromCache(repo, number, options);
  if (cached === null) {
    return null;
  }
  const comments = fetchIssueComments(repo, number, options);
  return attachIssueCommentThread(cached, comments);
}

export type IngestResult = "created" | "dryrun" | "duplicate";

/**
 * Resolve the containment root for ingest writes (#2869 / #2871).
 *
 * Precedence:
 * 1. Explicit `cwd` (CLI project root)
 * 2. Sentinel walk from vbriefDir (`xbrief` / `vbrief` / `.git`)
 * 3. Parent of a layout-named lifecycle dir (`…/xbrief` or `…/vbrief`) — even when
 *    that dir does not exist yet (mkdir is about to create it)
 * 4. An already-existing non-symlink vbriefDir used as a bare lifecycle root (tests)
 *
 * ⊗ Never use a non-existent or symlink path as a silent dirname fallback.
 */
function resolveIngestProjectRoot(
  vbriefDir: string,
  cwd: string | null | undefined,
): string | null {
  if (cwd !== undefined && cwd !== null && cwd.length > 0) {
    return resolve(cwd);
  }
  const walked = resolveProjectRoot(null, vbriefDir);
  if (walked !== null) {
    return walked;
  }
  const abs = resolve(vbriefDir);
  const base = basename(abs);
  if (base === "xbrief" || base === "vbrief" || base === "vBRIEF") {
    return dirname(abs);
  }
  try {
    const info = lstatSync(abs);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      return abs;
    }
  } catch {
    // missing dir — cannot contain writes safely without an explicit root
  }
  return null;
}

export function ingestOne(
  issue: Record<string, unknown>,
  options: {
    vbriefDir: string;
    status: IngestStatus;
    repoUrl: string;
    dryRun?: boolean;
    existingRefs?: Map<number, string[]>;
    scmCall?: ScmCallFn;
    cwd?: string | null;
    cacheRoot?: string | null;
  },
): [IngestResult, string | null, string] {
  const number = Number(issue.number);
  const refs = options.existingRefs ?? scanProvenanceRefs(options.vbriefDir);
  if (refs.has(number)) {
    const existing = refs.get(number)?.[0] ?? "";
    return [
      "duplicate",
      join(options.vbriefDir, existing),
      `#${number} already ingested at ${existing}`,
    ];
  }

  const enriched = enrichIssueWithComments(issue, options.repoUrl, {
    scmCall: options.scmCall,
    cwd: options.cwd,
    cacheRoot: options.cacheRoot,
  });
  const emissionLayout = resolveIngestEmissionLayout(options.vbriefDir);
  const [vbrief, folder] = buildIssueVbrief(enriched, options.status, options.repoUrl, {
    infoRootKey: emissionLayout.infoRootKey,
    infoVersion: emissionLayout.infoVersion,
  });
  const filename = targetFilename(number, String(issue.title ?? ""), emissionLayout.artifactSuffix);
  const folderPath = join(options.vbriefDir, folder);
  const target = join(folderPath, filename);

  if (options.dryRun) {
    return ["dryrun", target, formatIngestCreatedMessage(folder, filename, vbrief.plan, true)];
  }

  // Gate lifecycle folder + leaf before mkdir/write so folder/parent symlinks
  // cannot divert issue:ingest / triage:accept outside the project (#2869).
  const projectRoot = resolveIngestProjectRoot(options.vbriefDir, options.cwd);
  if (projectRoot === null) {
    throw new ProjectionContainmentError(
      `projection write refused: could not resolve project root for ingest into ${options.vbriefDir}`,
      {
        projectDir: options.vbriefDir,
        targetPath: target,
        offendingPath: options.vbriefDir,
      },
    );
  }
  assertWriteTargetSafe(projectRoot, folderPath);
  assertWriteTargetSafe(projectRoot, target);

  mkdirSync(folderPath, { recursive: true });
  writeFileSync(target, `${JSON.stringify(vbrief, null, 2)}\n`, "utf8");
  emitAcceptanceStampFromPlan(projectRoot, vbrief.plan);
  return ["created", target, formatIngestCreatedMessage(folder, filename, vbrief.plan)];
}

export function ingestBulk(
  issues: Record<string, unknown>[],
  options: {
    vbriefDir: string;
    status: IngestStatus;
    repoUrl: string;
    label?: string | null;
    dryRun?: boolean;
    scmCall?: ScmCallFn;
    cwd?: string | null;
    cacheRoot?: string | null;
  },
): Record<string, string[] | number> {
  let filtered = issues;
  if (options.label !== undefined && options.label !== null) {
    filtered = issues.filter((issue) => {
      const labels = issue.labels;
      if (!Array.isArray(labels)) {
        return false;
      }
      for (const lbl of labels) {
        const name =
          typeof lbl === "string"
            ? lbl
            : lbl !== null && typeof lbl === "object"
              ? String((lbl as Record<string, unknown>).name ?? "")
              : "";
        if (name === options.label) {
          return true;
        }
      }
      return false;
    });
  }

  const refs = scanProvenanceRefs(options.vbriefDir);
  const summary: Record<string, string[] | number> = {
    created: [],
    duplicate: [],
    dryrun: [],
    failed: [],
    notices: [],
  };

  for (const issue of filtered) {
    let ingested: [IngestResult, string | null, string];
    try {
      ingested = ingestOne(issue, { ...options, existingRefs: refs });
    } catch (exc) {
      // #2306: a per-issue quarantine hard-fail must not sink the whole batch;
      // record it, emit nothing for that issue, and surface a non-zero exit
      // upstream via the `failed` bucket.
      if (exc instanceof ScannerHardFailError) {
        (summary.failed as string[]).push(`#${exc.issueNumber}`);
        process.stderr.write(`${exc.message}\n`);
        continue;
      }
      throw exc;
    }
    const [result, path, msg] = ingested;
    const rel = path !== null ? path.replace(`${options.vbriefDir}/`, "").replace(/\\/g, "/") : "";
    (summary[result] as string[]).push(rel);
    if (msg.includes("\n")) {
      (summary.notices as string[]).push(msg);
    }
    if (result === "created" && path !== null) {
      const num = Number(issue.number);
      const existing = refs.get(num) ?? [];
      existing.push(rel);
      refs.set(num, existing);
    }
  }
  summary.total = filtered.length;
  return summary;
}

export function resolveRepoUrl(repo: string): string {
  if (repo.length === 0) {
    return "";
  }
  if (repo.startsWith("http://") || repo.startsWith("https://")) {
    return repo.replace(/\/$/, "");
  }
  if (/^[^/]+\/[^/]+$/.test(repo)) {
    return `https://github.com/${repo}`;
  }
  return "";
}

export interface IssueIngestCliArgs {
  number?: number | null;
  all?: boolean;
  label?: string | null;
  status?: IngestStatus;
  dryRun?: boolean;
  vbriefDir?: string;
  repo?: string | null;
  projectRoot?: string | null;
}

export function issueIngestMain(args: IssueIngestCliArgs): number {
  if ((args.number === undefined || args.number === null) && !args.all) {
    process.stderr.write("Error: Provide an issue number or --all\n");
    return 2;
  }
  if (args.number !== undefined && args.number !== null && args.all) {
    process.stderr.write("Error: Use either a single issue number OR --all, not both\n");
    return 2;
  }

  const projectRoot = resolveProjectRoot(args.projectRoot ?? undefined);
  const vbriefDir = args.vbriefDir
    ? resolve(args.vbriefDir)
    : resolveLifecycleRoot(args.projectRoot ? resolve(args.projectRoot) : resolve("."));
  mkdirSync(vbriefDir, { recursive: true });
  let repo = resolveProjectRepo(args.repo ?? undefined, projectRoot);
  if (repo === null) {
    repo = detectRepo();
  }
  if (repo === null) {
    process.stderr.write(
      "Error: could not detect repo. Pass --repo OWNER/NAME, set $DEFT_PROJECT_REPO, or run from a directory tree whose git remote origin is the consumer repo (#538).\n",
    );
    return 2;
  }
  const repoUrl = resolveRepoUrl(repo);
  const status = args.status ?? "proposed";

  if (args.all) {
    const issues = fetchOpenIssues(repo, { cwd: projectRoot });
    if (issues === null) {
      return 2;
    }
    const summary = ingestBulk(issues, {
      vbriefDir,
      status,
      repoUrl,
      label: args.label,
      dryRun: args.dryRun,
      cwd: projectRoot,
    });
    const created = summary.created as string[];
    const duplicate = summary.duplicate as string[];
    const dryrun = summary.dryrun as string[];
    const failed = (summary.failed as string[] | undefined) ?? [];
    process.stdout.write(
      `issue:ingest bulk summary: ${created.length} created, ${duplicate.length} duplicate, ${dryrun.length} dry-run, ${failed.length} refused (total considered: ${summary.total})\n`,
    );
    for (const entry of created) {
      process.stdout.write(`  CREATED ${entry}\n`);
    }
    for (const notice of (summary.notices as string[] | undefined) ?? []) {
      process.stdout.write(`${notice}\n`);
    }
    for (const entry of dryrun) {
      process.stdout.write(`  DRY-RUN ${entry}\n`);
    }
    for (const entry of duplicate) {
      process.stdout.write(`  SKIP    ${entry} (already has scope vBRIEF)\n`);
    }
    for (const entry of failed) {
      process.stdout.write(`  REFUSED ${entry} (quarantine scanner hard-fail; nothing written)\n`);
    }
    // #2306: fail closed on any quarantine hard-fail in the batch.
    return failed.length > 0 ? 2 : 0;
  }

  const issue = fetchIssue(repo, args.number as number, { cwd: projectRoot });
  if (issue === null) {
    return 2;
  }
  let result: IngestResult;
  let msg: string;
  try {
    [result, , msg] = ingestOne(issue, {
      vbriefDir,
      status,
      repoUrl,
      dryRun: args.dryRun,
      cwd: projectRoot,
    });
  } catch (exc) {
    // #2306: fail closed -- emit nothing, non-zero exit on a quarantine hard-fail.
    if (exc instanceof ScannerHardFailError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    throw exc;
  }
  process.stdout.write(`${msg}\n`);
  return result === "duplicate" ? 1 : 0;
}

export function ingestSingleForAccept(
  n: number,
  repo: string,
  options: {
    projectRoot?: string | null;
    status?: IngestStatus;
    cacheRoot?: string | null;
  } = {},
): [IngestResult, string | null, string] {
  const root = resolve(options.projectRoot ?? process.cwd());
  const vbriefDir = resolveLifecycleRoot(root);
  mkdirSync(vbriefDir, { recursive: true });
  const repoUrl = resolveRepoUrl(repo);
  const issue = fetchIssue(repo, n, {
    cwd: root,
    cacheRoot: options.cacheRoot,
  });
  if (issue === null) {
    throw new Error(
      `failed to fetch GitHub issue #${n} from ${repo} (unified cache miss + live gh api fetch failed; see stderr)`,
    );
  }
  // Forward ingestOne's notice-bearing third return so triage:accept can
  // print a refused-stamp remediation instead of only the decision id (#3398).
  return ingestOne(issue, {
    vbriefDir,
    status: options.status ?? "proposed",
    repoUrl,
    cwd: root,
  });
}
