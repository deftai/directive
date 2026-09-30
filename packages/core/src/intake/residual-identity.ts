/**
 * Residual re-ingest identity (#5177 Prefer-A).
 *
 * Distinct residual plan.id + lineage, shared ownership for detect/admit,
 * and discoverable recovery verb naming. Keeps findParentsByPlanId uniqueness
 * (no multi-match under github.issue.N).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { extractPlanId } from "../scope/parent-lineage.js";
import {
  type IssueOrigin,
  issueOriginKey,
  LIFECYCLE_FOLDERS,
  TERMINAL_LIFECYCLE_FOLDERS,
} from "./reconcile-issues.js";

export const RESIDUAL_PLAN_ID_SOURCE = "github-residual" as const;
export const RESIDUAL_LINEAGE_META_KEY = "x-directive/residual-lineage" as const;
export const RESIDUAL_LINEAGE_SCHEMA = "deft.scope.residual-lineage.v1" as const;
export const RESIDUAL_CLI_FLAG = "--residual" as const;
/** Operator-visible recovery verb shared by Stage A and duplicate ingest. */
export const RESIDUAL_RECOVERY_VERB = "issue:ingest --residual" as const;

const PLAN_ID_FORMAT = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;
const ORIGIN_HTML_RE = /https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i;
const ORIGIN_API_RE = /https?:\/\/api\.github\.com\/repos\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i;
const ORIGIN_BARE_RE = /ingested from(?:\s+github)?\s+issue\s+#(\d+)/i;
const RESIDUAL_ID_RE = /^github\.issue\.residual\.(\d+)(?:\.lean\.(\d+))?$/;

const NONTERMINAL_FOLDERS = ["proposed", "pending", "active"] as const;

export function residualRecoveryCommand(issueNumber: number): string {
  return `${RESIDUAL_RECOVERY_VERB} -- ${issueNumber}`;
}

export function isResidualPlanId(id: string): boolean {
  return RESIDUAL_ID_RE.test(id.trim());
}

export function residualPlanIdRestIssueId(id: string): number | null {
  const match = RESIDUAL_ID_RE.exec(id.trim());
  if (match?.[1] === undefined) {
    return null;
  }
  const n = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function predecessorPlanIdForRestIssue(restId: number): string {
  return `github.issue.${restId}`;
}

export type ResidualMintResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly source: typeof RESIDUAL_PLAN_ID_SOURCE;
      readonly githubIssueId: number;
      readonly originKey: string;
      readonly leanCommentId: number | null;
    }
  | { readonly ok: false; readonly message: string };

function parsePositiveId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number.parseInt(value, 10);
    if (Number.isSafeInteger(n) && n > 0) {
      return n;
    }
  }
  return null;
}

/**
 * Mint a residual plan.id that never equals github.issue.<REST_ID>.
 * Prefer lean-scoped id when a Bound lean is known; otherwise the base residual id.
 */
export function mintResidualIssuePlanId(input: {
  readonly issueId: unknown;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly leanCommentId?: number | null;
}): ResidualMintResult {
  const restId = parsePositiveId(input.issueId);
  if (restId === null) {
    return {
      ok: false,
      message: `cannot mint residual plan.id for ${input.owner}/${input.repo}#${input.number}: missing positive GitHub REST issue id`,
    };
  }
  const lean =
    input.leanCommentId !== undefined && input.leanCommentId !== null
      ? parsePositiveId(input.leanCommentId)
      : null;
  const id =
    lean !== null
      ? `github.issue.residual.${restId}.lean.${lean}`
      : `github.issue.residual.${restId}`;
  if (!PLAN_ID_FORMAT.test(id)) {
    return {
      ok: false,
      message: `residual plan.id ${id} fails the schema pattern`,
    };
  }
  const origin: IssueOrigin = {
    owner: input.owner,
    repo: input.repo,
    number: input.number,
  };
  return {
    ok: true,
    id,
    source: RESIDUAL_PLAN_ID_SOURCE,
    githubIssueId: restId,
    originKey: issueOriginKey(origin),
    leanCommentId: lean,
  };
}

export function residualIdMatchesRestIssue(id: string, restId: number): boolean {
  const parsed = residualPlanIdRestIssueId(id);
  return parsed === restId;
}

function ingestOwnerTexts(data: Record<string, unknown>): string[] {
  const plan =
    data.plan !== null && typeof data.plan === "object" && !Array.isArray(data.plan)
      ? (data.plan as Record<string, unknown>)
      : {};
  const narratives =
    plan.narratives !== null &&
    typeof plan.narratives === "object" &&
    !Array.isArray(plan.narratives)
      ? (plan.narratives as Record<string, unknown>)
      : {};
  const infoRaw = data.xBRIEFInfo ?? data.vBRIEFInfo;
  const info =
    infoRaw !== null && typeof infoRaw === "object" && !Array.isArray(infoRaw)
      ? (infoRaw as Record<string, unknown>)
      : {};
  const out: string[] = [];
  for (const text of [narratives.Origin, info.description]) {
    if (typeof text === "string" && /ingested from/i.test(text)) {
      out.push(text);
    }
  }
  return out;
}

function originsFromText(text: string): IssueOrigin[] {
  const found: IssueOrigin[] = [];
  for (const re of [ORIGIN_HTML_RE, ORIGIN_API_RE]) {
    const copy = new RegExp(re.source, "gi");
    for (const m of text.matchAll(copy)) {
      if (m[1] && m[2] && m[3]) {
        found.push({
          owner: m[1],
          repo: m[2],
          number: Number.parseInt(m[3], 10),
        });
      }
    }
  }
  return found;
}

function originsFromProvenance(data: Record<string, unknown>): {
  readonly origins: IssueOrigin[];
  readonly bareNumbers: number[];
} {
  const texts = ingestOwnerTexts(data);
  const origins: IssueOrigin[] = [];
  const bareNumbers: number[] = [];
  const seenOrigin = new Set<string>();
  const seenBare = new Set<number>();
  for (const text of texts) {
    for (const origin of originsFromText(text)) {
      const key = issueOriginKey(origin);
      if (!seenOrigin.has(key)) {
        seenOrigin.add(key);
        origins.push(origin);
      }
    }
    const bare = ORIGIN_BARE_RE.exec(text);
    if (bare?.[1]) {
      const n = Number.parseInt(bare[1], 10);
      if (Number.isSafeInteger(n) && n > 0 && !seenBare.has(n)) {
        seenBare.add(n);
        bareNumbers.push(n);
      }
    }
  }
  return { origins, bareNumbers };
}

const BINDING_ORIGIN_RE = /^([^/]+)\/([^#]+)#(\d+)$/;

function planIdBindingOrigin(data: Record<string, unknown>): IssueOrigin | null {
  const plan =
    data.plan !== null && typeof data.plan === "object" && !Array.isArray(data.plan)
      ? (data.plan as Record<string, unknown>)
      : null;
  if (plan === null) {
    return null;
  }
  const meta =
    plan.metadata !== null && typeof plan.metadata === "object" && !Array.isArray(plan.metadata)
      ? (plan.metadata as Record<string, unknown>)
      : null;
  if (meta === null) {
    return null;
  }
  const binding = meta["x-directive/plan-id"];
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    return null;
  }
  const rec = binding as Record<string, unknown>;
  const origin = rec.origin;
  if (typeof origin === "string") {
    const match = BINDING_ORIGIN_RE.exec(origin.trim());
    if (match?.[1] && match[2] && match[3]) {
      const n = Number.parseInt(match[3], 10);
      if (Number.isSafeInteger(n) && n > 0) {
        return { owner: match[1], repo: match[2], number: n };
      }
    }
  }
  return null;
}

function ownershipTargetNumber(target: number | IssueOrigin): number {
  return typeof target === "number" ? target : target.number;
}

function ownershipMatchesOrigin(origin: IssueOrigin, target: number | IssueOrigin): boolean {
  if (typeof target === "number") {
    return origin.number === target;
  }
  return issueOriginKey(origin) === issueOriginKey(target);
}

/**
 * Shared ownership predicate (#5177 Prefer-A item 2): ingest-owner Origin and/or
 * plan.id binding — not bare plan.references. When `target` carries owner/repo,
 * ownership stays repo-scoped (same issue number in another repo does not match).
 */
export function briefOwnsIssue(
  data: Record<string, unknown>,
  target: number | IssueOrigin,
): boolean {
  const issueNumber = ownershipTargetNumber(target);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return false;
  }
  const { origins, bareNumbers } = originsFromProvenance(data);
  for (const origin of origins) {
    if (ownershipMatchesOrigin(origin, target)) {
      return true;
    }
  }
  // Bare "#N" Origin has no repository; only admit when the caller did not
  // supply a repo scope (number-only target).
  if (typeof target === "number" && bareNumbers.includes(issueNumber)) {
    return true;
  }
  const bindingOrigin = planIdBindingOrigin(data);
  if (bindingOrigin !== null && ownershipMatchesOrigin(bindingOrigin, target)) {
    return true;
  }
  return false;
}

/** Parse `owner/repo` (+ issue number) into an IssueOrigin when well-formed. */
export function issueOriginFromRepoSlug(
  repoSlug: string | null | undefined,
  issueNumber: number,
): IssueOrigin | null {
  if (repoSlug === null || repoSlug === undefined) {
    return null;
  }
  const trimmed = repoSlug.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return null;
  }
  const owner = trimmed.slice(0, slash);
  const repo = trimmed.slice(slash + 1);
  if (
    owner.includes("/") ||
    repo.includes("/") ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    return null;
  }
  return { owner, repo, number: issueNumber };
}

export interface OwnedLifecycleHit {
  readonly folder: (typeof LIFECYCLE_FOLDERS)[number];
  readonly path: string;
  readonly relPath: string;
  readonly planId: string | null;
  readonly residual: boolean;
  readonly data: Record<string, unknown>;
}

function readBrief(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function listOwnedLifecycleHits(
  vbriefDir: string,
  target: number | IssueOrigin,
): OwnedLifecycleHit[] {
  const hits: OwnedLifecycleHit[] = [];
  for (const folder of LIFECYCLE_FOLDERS) {
    const folderPath = join(vbriefDir, folder);
    try {
      if (!statSync(folderPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    let files: string[];
    try {
      files = readdirSync(folderPath)
        .filter((f) => hasArtifactSuffix(f))
        .sort();
    } catch {
      continue;
    }
    for (const filename of files) {
      const full = join(folderPath, filename);
      const data = readBrief(full);
      if (data === null || !briefOwnsIssue(data, target)) {
        continue;
      }
      const planId = extractPlanId(data);
      hits.push({
        folder,
        path: full,
        relPath: `${folder}/${filename}`,
        planId,
        residual: planId !== null && isResidualPlanId(planId),
        data,
      });
    }
  }
  return hits;
}

export function findOwnedCompletedHits(
  vbriefDir: string,
  target: number | IssueOrigin,
): OwnedLifecycleHit[] {
  return listOwnedLifecycleHits(vbriefDir, target).filter((hit) => hit.folder === "completed");
}

/**
 * Prefer-A residual lineage (#5177): when multiple owned completed briefs
 * exist, lineage the most recently completed residual/predecessor — not the
 * oldest ascending-filename hit. Date-prefixed filenames sort lexicographically.
 */
export function selectMostRecentOwnedHit(
  hits: readonly OwnedLifecycleHit[],
): OwnedLifecycleHit | null {
  if (hits.length === 0) {
    return null;
  }
  let best = hits[0] as OwnedLifecycleHit;
  for (let i = 1; i < hits.length; i++) {
    const hit = hits[i] as OwnedLifecycleHit;
    if (hit.relPath > best.relPath) {
      best = hit;
    }
  }
  return best;
}

export function findNonterminalResidualHits(
  vbriefDir: string,
  target: number | IssueOrigin,
): OwnedLifecycleHit[] {
  return listOwnedLifecycleHits(vbriefDir, target).filter(
    (hit) => hit.residual && (NONTERMINAL_FOLDERS as readonly string[]).includes(hit.folder),
  );
}

export function findResidualHitsForIssue(
  vbriefDir: string,
  target: number | IssueOrigin,
): OwnedLifecycleHit[] {
  return listOwnedLifecycleHits(vbriefDir, target).filter((hit) => hit.residual);
}

export function attachResidualLineage(
  plan: Record<string, unknown>,
  lineage: {
    readonly predecessorPlanId: string;
    readonly predecessorPath: string;
    readonly boundLeanCommentId: number | null;
  },
): void {
  // Clone before write so shared/frozen plan.metadata is not mutated in place.
  const meta =
    plan.metadata !== null && typeof plan.metadata === "object" && !Array.isArray(plan.metadata)
      ? { ...(plan.metadata as Record<string, unknown>) }
      : {};
  meta[RESIDUAL_LINEAGE_META_KEY] = {
    schema: RESIDUAL_LINEAGE_SCHEMA,
    predecessor_plan_id: lineage.predecessorPlanId,
    predecessor_path: lineage.predecessorPath,
    bound_lean_comment_id: lineage.boundLeanCommentId,
  };
  plan.metadata = meta;
}

export function formatResidualAlreadyAdmittedMessage(issueNumber: number, relPath: string): string {
  return (
    `#${issueNumber} residual already admitted at ${relPath}; ` +
    `refuse second mint (use lifecycle of that residual, not another ${RESIDUAL_RECOVERY_VERB})`
  );
}

export function formatCompletedDuplicateWithResidualRecovery(
  issueNumber: number,
  existingRelPath: string,
): string {
  return (
    `#${issueNumber} already ingested at ${existingRelPath}; ` +
    `for a reopened residual Bound use ${residualRecoveryCommand(issueNumber)}`
  );
}

export function isTerminalRelPath(relPath: string): boolean {
  const folder = relPath.split(/[\\/]/, 1)[0] ?? "";
  return TERMINAL_LIFECYCLE_FOLDERS.has(folder);
}
