/**
 * PR deft-story → plan-id adopter for merge-gate mint selection (#5782).
 *
 * Demand-site only: when a gate would config-refuse unresolved planId under
 * multi-running or multi-mint, adopt the unique running plan.id owned by the
 * sole distinct `deft-story: N` mark on the PR body. Never synthesizes plan.id.
 * Does not change #4864 finalize delivery-bind semantics.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultRunGh, fetchPrBodyRest, type RunGhFn } from "../docs/docs-impact.js";
import { briefOwnsIssue, issueOriginFromRepoSlug } from "../intake/residual-identity.js";
import { parseAllDeftStoryMarks, resolveLiveRepoSlug } from "../pr-closing-keywords/main.js";

/** Observable bad-pin + PR context suppress wording (shared). */
export const BAD_PIN_PR_SUPPRESS_MESSAGE =
  "DEFT_ACTIVE_SCOPE is set but is not a running xBRIEF; PR deft-story plan-id adoption was suppressed — pass --plan-id or clear the pin";

const WHOLE_STORY_BIND_HINT =
  "A deft-story: N mark asserts #4864 delivery bind (metadata.productPullRequest must equal this PR before leftover finalize); satisfying that bind closes the whole story at cohort finalize — only use the mark on the PR that is the delivery for #N. Adoption does not alter finalize semantics.";

export type DigitPrContext =
  | { readonly kind: "none" }
  | { readonly kind: "pr"; readonly pr: number }
  | { readonly kind: "malformed-pr"; readonly raw: string };

export type PrStoryAdoptionResult =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "no-pr-context" }
  | { readonly kind: "config"; readonly message: string }
  | { readonly kind: "bad-pin-suppressed"; readonly message: string };

export interface PrStoryAdoptionOptions {
  readonly projectRoot: string;
  /** Explicit `--pr` (digit string). Empty/absent falls through to env. */
  readonly pr?: string;
  /** Explicit `--repo` owner/repo. Empty/absent falls through to env. */
  readonly repo?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runGh?: RunGhFn;
  /**
   * When true (observable path), a set-but-unresolvable DEFT_ACTIVE_SCOPE with
   * PR context suppresses adoption and returns bad-pin-suppressed.
   */
  readonly suppressOnBadPin?: boolean;
  /** Caller-classified set-but-unresolvable DEFT_ACTIVE_SCOPE. */
  readonly badPin?: boolean;
}

export interface ActiveBriefEntry {
  readonly relPath: string;
  readonly planId: string | undefined;
  readonly status: string | undefined;
  readonly data: Record<string, unknown>;
}

/**
 * Digit-gated PR context. Empty or non-digit GITHUB_PR_NUMBER is no-PR
 * (master push / local check). Malformed only for an explicit non-digit `--pr`.
 */
export function resolveDigitPrContext(
  explicitPr: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DigitPrContext {
  if (explicitPr !== undefined) {
    const trimmed = explicitPr.trim();
    if (trimmed.length === 0) return { kind: "none" };
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isInteger(n) && n > 0) return { kind: "pr", pr: n };
    }
    return { kind: "malformed-pr", raw: trimmed };
  }
  const raw = env.GITHUB_PR_NUMBER?.trim() ?? "";
  if (raw.length === 0) return { kind: "none" };
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return { kind: "pr", pr: n };
  }
  // Non-digit env → no-PR-context (same family as verify-closing-keywords).
  return { kind: "none" };
}

/** Resolve owner/repo from `--repo` then GITHUB_REPOSITORY (empty-as-absent). */
export function resolveRepoSlug(
  explicitRepo: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveLiveRepoSlug(explicitRepo, env);
}

export function isWellFormedRepoSlug(slug: string): boolean {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return false;
  const owner = slug.slice(0, slash);
  const repo = slug.slice(slash + 1);
  return owner.length > 0 && repo.length > 0 && !repo.includes("/");
}

/**
 * Present `deft-story:` lines whose value is not a positive decimal issue
 * number (plan-id shaped values refused).
 */
export function findUnparseableDeftStoryMarks(text: string): string[] {
  const re = /^\s*deft-story:\s*(.*?)\s*$/gim;
  const bad: string[] = [];
  let match = re.exec(text);
  while (match !== null) {
    const value = (match[1] ?? "").trim();
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      bad.push(value.length > 0 ? value : "(empty)");
    }
    match = re.exec(text);
  }
  return bad;
}

/** Shared bad-pin + PR suppress check for both gates. */
export function evaluateBadPinPrSuppress(args: {
  readonly badPin: boolean;
  readonly hasPrContext: boolean;
}): { readonly suppress: true; readonly message: string } | null {
  if (args.badPin && args.hasPrContext) {
    return { suppress: true, message: BAD_PIN_PR_SUPPRESS_MESSAGE };
  }
  return null;
}

function parseActiveBrief(text: string): {
  planId: string | undefined;
  status: string | undefined;
  data: Record<string, unknown>;
} | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const data = raw as Record<string, unknown>;
    const plan = data.plan;
    if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
      return { planId: undefined, status: undefined, data };
    }
    const rec = plan as Record<string, unknown>;
    const status = typeof rec.status === "string" ? rec.status : undefined;
    const id = typeof rec.id === "string" && rec.id.trim().length > 0 ? rec.id.trim() : undefined;
    return { planId: id, status, data };
  } catch {
    return null;
  }
}

/** Ownership-first scan of xbrief/active (no lifecycle-folder enum). */
export function listActiveBriefEntries(projectRoot: string): ActiveBriefEntry[] {
  const activeDir = join(resolve(projectRoot), "xbrief", "active");
  if (!existsSync(activeDir)) return [];
  const out: ActiveBriefEntry[] = [];
  for (const name of readdirSync(activeDir)) {
    if (!name.endsWith(".xbrief.json")) continue;
    const relPath = `xbrief/active/${name}`;
    try {
      const text = readFileSync(join(activeDir, name), "utf8");
      const parsed = parseActiveBrief(text);
      if (parsed === null) continue;
      out.push({
        relPath,
        planId: parsed.planId,
        status: parsed.status,
        data: parsed.data,
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

export function adoptPlanIdFromOwnedIssue(
  projectRoot: string,
  repoSlug: string,
  issueNumber: number,
): PrStoryAdoptionResult {
  const origin = issueOriginFromRepoSlug(repoSlug, issueNumber);
  if (origin === null) {
    return {
      kind: "config",
      message:
        `repository slug ${JSON.stringify(repoSlug)} is malformed for deft-story ownership; ` +
        "set GITHUB_REPOSITORY or pass --repo as owner/repo",
    };
  }
  const owned = listActiveBriefEntries(projectRoot).filter((e) => briefOwnsIssue(e.data, origin));
  if (owned.length === 0) {
    return {
      kind: "config",
      message:
        `deft-story: ${issueNumber} has no owner in xbrief/active with ingest origin or plan-id binding for this repository. ` +
        WHOLE_STORY_BIND_HINT,
    };
  }
  if (owned.length > 1) {
    return {
      kind: "config",
      message:
        `deft-story: ${issueNumber} matches multiple xbrief/active briefs; cannot adopt plan-id. ` +
        WHOLE_STORY_BIND_HINT,
    };
  }
  const brief = owned[0]!;
  if (brief.status !== "running") {
    return {
      kind: "config",
      message:
        `deft-story: ${issueNumber} has no running owner in xbrief/active; re-own or re-activate the story. ` +
        WHOLE_STORY_BIND_HINT,
    };
  }
  if (brief.planId === undefined || brief.planId.length === 0) {
    return {
      kind: "config",
      message:
        `deft-story: ${issueNumber} running owner has empty plan.id; cannot adopt (never synthesize from N). ` +
        WHOLE_STORY_BIND_HINT,
    };
  }
  return { kind: "id", id: brief.planId };
}

/**
 * Demand-site PR-story plan-id adoption. Call only when the gate would otherwise
 * config-refuse unresolved planId under multi-running or multi-mint.
 */
export function tryAdoptPlanIdFromPrStory(options: PrStoryAdoptionOptions): PrStoryAdoptionResult {
  const env = options.env ?? process.env;
  const prCtx = resolveDigitPrContext(options.pr, env);

  if (prCtx.kind === "malformed-pr") {
    return {
      kind: "config",
      message: `--pr ${JSON.stringify(prCtx.raw)} is not a positive digit string`,
    };
  }
  if (prCtx.kind === "none") {
    return { kind: "no-pr-context" };
  }

  if (options.suppressOnBadPin === true && options.badPin === true) {
    const suppressed = evaluateBadPinPrSuppress({
      badPin: true,
      hasPrContext: true,
    });
    if (suppressed !== null) {
      return { kind: "bad-pin-suppressed", message: suppressed.message };
    }
  }

  const slug = resolveRepoSlug(options.repo, env);
  if (slug === null || !isWellFormedRepoSlug(slug)) {
    return {
      kind: "config",
      message:
        "PR deft-story plan-id adoption requires repository identity (GITHUB_REPOSITORY or --repo as owner/repo)",
    };
  }

  const runGh = options.runGh ?? defaultRunGh;
  const pull = fetchPrBodyRest(prCtx.pr, slug, runGh);
  if (pull === null) {
    return {
      kind: "config",
      message: `failed to fetch PR #${prCtx.pr} body for deft-story plan-id adoption (REST null)`,
    };
  }

  const unparseable = findUnparseableDeftStoryMarks(pull.body);
  if (unparseable.length > 0) {
    return {
      kind: "config",
      message:
        `PR #${prCtx.pr} has unparseable deft-story mark value(s) ${unparseable
          .map((v) => JSON.stringify(v))
          .join(", ")}; ` +
        "deft-story requires a positive decimal issue number (plan-id shaped values are refused). " +
        WHOLE_STORY_BIND_HINT,
    };
  }

  // parseAllDeftStoryMarks already Set-dedupes; sole = exactly one distinct N.
  const marks = parseAllDeftStoryMarks(pull.body);
  if (marks.length === 0) {
    return {
      kind: "config",
      message:
        `PR #${prCtx.pr} has no deft-story: N mark for plan-id adoption under multi-running/multi-mint; ` +
        "add a sole deft-story: N (positive issue number) or pass --plan-id / pin DEFT_ACTIVE_SCOPE. " +
        WHOLE_STORY_BIND_HINT,
    };
  }
  if (marks.length > 1) {
    return {
      kind: "config",
      message:
        `PR #${prCtx.pr} has multiple distinct deft-story marks (${marks.join(", ")}); ` +
        "sole means exactly one distinct issue number after dedupe (duplicate identical lines are sole). " +
        WHOLE_STORY_BIND_HINT,
    };
  }

  return adoptPlanIdFromOwnedIssue(options.projectRoot, slug, marks[0]!);
}
