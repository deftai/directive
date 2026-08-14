import { GITHUB_ISSUE_REF_TYPES, parseIssueNumber } from "../intake/reconcile-issues.js";
import { type CallOptions, type CompletedProcess, call } from "../scm/call.js";

const ISSUE_URL_PATTERN = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/;

export const ORIGIN_FRESHNESS_REMEDIATION =
  "Re-read the issue body and comments (#2143), then either refresh the brief or record intentional divergence and bump xBRIEFInfo.updated. Do not auto-write origin text onto the brief (#309 D12).";

export type OriginFreshnessKind = "no-origin" | "current" | "stale" | "uncomparable";

export interface GithubIssueOrigin {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly uri: string;
  readonly type: string;
}

export type FetchOriginUpdatedAt = (
  origin: GithubIssueOrigin,
) => { updatedAt: string } | { error: string };

export interface EvaluateOriginFreshnessOptions {
  readonly fetchOriginUpdatedAt?: FetchOriginUpdatedAt;
  readonly cwd?: string;
  readonly skip?: boolean;
}

export type OriginFreshnessResult =
  | { readonly ok: true; readonly kind: OriginFreshnessKind }
  | { readonly ok: false; readonly kind: OriginFreshnessKind; readonly message: string };

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
  const plan = payload.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return [];
  }
  const refs = (plan as Record<string, unknown>).references;
  if (!Array.isArray(refs)) {
    return [];
  }
  const origins: GithubIssueOrigin[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
      continue;
    }
    const rec = ref as Record<string, unknown>;
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
    const key = `${origin.owner}/${origin.repo}#${origin.number}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    origins.push(origin);
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
    const match = ISSUE_URL_PATTERN.exec(value);
    if (match?.[1] && match[2] && match[3]) {
      return {
        owner: match[1],
        repo: match[2],
        number: Number.parseInt(match[3], 10),
        uri: value,
      };
    }
  }
  return null;
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

export function fetchGithubIssueUpdatedAt(
  origin: GithubIssueOrigin,
  options: { scmCall?: ScmCallFn; cwd?: string } = {},
): { updatedAt: string } | { error: string } {
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
    return { updatedAt: updatedAt.trim() };
  } catch {
    return { error: "origin issue payload is not valid JSON" };
  }
}

export function evaluateOriginFreshness(
  payload: Record<string, unknown>,
  options: EvaluateOriginFreshnessOptions = {},
): OriginFreshnessResult {
  if (options.skip === true) {
    return { ok: true, kind: "no-origin" };
  }
  const origins = extractGithubIssueOrigins(payload);
  if (origins.length === 0) {
    return { ok: true, kind: "no-origin" };
  }
  const fetch =
    options.fetchOriginUpdatedAt ??
    ((next) => fetchGithubIssueUpdatedAt(next, { cwd: options.cwd }));
  const briefUpdated = briefUpdatedOf(payload);
  for (const origin of origins) {
    const fetched = fetch(origin);
    if ("error" in fetched) {
      return {
        ok: false,
        kind: "uncomparable",
        message:
          `Could not fetch origin GitHub issue #${origin.number} for freshness check: ${fetched.error}. ` +
          ORIGIN_FRESHNESS_REMEDIATION,
      };
    }
    const kind = compareOriginFreshness(briefUpdated, fetched.updatedAt);
    if (kind === "stale") {
      return {
        ok: false,
        kind,
        message: formatOriginStaleMessage(origin, fetched.updatedAt, briefUpdated),
      };
    }
    if (kind === "uncomparable") {
      return {
        ok: false,
        kind,
        message:
          `Could not compare origin GitHub issue #${origin.number} updated_at=${fetched.updatedAt} ` +
          `to brief updated=${briefUpdated ?? "(missing)"}. ${ORIGIN_FRESHNESS_REMEDIATION}`,
      };
    }
  }
  return { ok: true, kind: "current" };
}
