import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createIssueComment, type RunGhApiFn } from "../intake/github-body.js";
import { provenanceIssueNumber, repoSlugFromUrl } from "../intake/issue-ingest.js";
import {
  extractReferencesFromVbrief,
  GITHUB_ISSUE_REF_TYPES,
  parseIssueNumber,
} from "../intake/reconcile-issues.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import { resolveProjectRepo } from "../slice/project-context.js";
import { isRepoMutationAllowed } from "../vbrief-reconcile/repo-guard.js";

export const SYNC_COMMENT_HEADER = "## xBRIEF sync (deft issue:sync-from-xbrief)";

export interface OriginIssueTarget {
  readonly repo: string;
  readonly number: number;
  readonly uri: string;
}

export interface SyncSnapshot {
  readonly status: string;
  readonly title: string;
  readonly acceptance: string;
  readonly items: readonly { title: string; status: string }[];
}

export interface ResolveOriginOptions {
  readonly fallbackRepo?: string | null;
}

export function resolveOriginIssue(
  data: Record<string, unknown>,
  options: ResolveOriginOptions = {},
): OriginIssueTarget | null {
  const refs = extractReferencesFromVbrief(data);
  const githubRefs: Array<{ ref: Record<string, unknown>; number: number }> = [];
  for (const ref of refs) {
    if (!GITHUB_ISSUE_REF_TYPES.has(String(ref.type ?? ""))) {
      continue;
    }
    const num = parseIssueNumber(ref);
    if (num !== null) {
      githubRefs.push({ ref, number: num });
    }
  }
  if (githubRefs.length === 0) {
    return null;
  }

  const provenanceNum = provenanceIssueNumber(data);
  let chosen = githubRefs[0] as { ref: Record<string, unknown>; number: number };
  if (provenanceNum !== null) {
    const match = githubRefs.find((entry) => entry.number === provenanceNum);
    if (match !== undefined) {
      chosen = match;
    }
  }

  const uri =
    (typeof chosen.ref.uri === "string" && chosen.ref.uri.length > 0 ? chosen.ref.uri : null) ??
    (typeof chosen.ref.url === "string" && chosen.ref.url.length > 0 ? chosen.ref.url : null) ??
    "";
  let repo = repoSlugFromUrl(uri);
  if (repo === null && options.fallbackRepo !== undefined && options.fallbackRepo !== null) {
    repo = options.fallbackRepo;
  }
  if (repo === null) {
    return null;
  }

  return {
    repo,
    number: chosen.number,
    uri: uri.length > 0 ? uri : `https://github.com/${repo}/issues/${chosen.number}`,
  };
}

export function extractSyncSnapshot(data: Record<string, unknown>): SyncSnapshot {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const narratives = (plan.narratives ?? {}) as Record<string, unknown>;
  const acceptance =
    typeof narratives.Acceptance === "string"
      ? narratives.Acceptance
      : typeof narratives.acceptance === "string"
        ? narratives.acceptance
        : "";

  const items: { title: string; status: string }[] = [];
  const walk = (raw: unknown): void => {
    if (!Array.isArray(raw)) {
      return;
    }
    for (const item of raw) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const obj = item as Record<string, unknown>;
      items.push({
        title: String(obj.title ?? ""),
        status: String(obj.status ?? "unknown"),
      });
      walk(obj.subItems);
      walk(obj.items);
    }
  };
  walk(plan.items);

  return {
    status: String(plan.status ?? "unknown"),
    title: String(plan.title ?? ""),
    acceptance,
    items,
  };
}

export function fingerprintSyncSnapshot(snapshot: SyncSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
}

export function readStoredFingerprint(data: Record<string, unknown>): string | null {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const metadata = plan.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const issueSync = (metadata as Record<string, unknown>).issueSync;
  if (issueSync === null || typeof issueSync !== "object" || Array.isArray(issueSync)) {
    return null;
  }
  const fp = (issueSync as Record<string, unknown>).fingerprint;
  return typeof fp === "string" && fp.length > 0 ? fp : null;
}

export function hasMaterialChanges(data: Record<string, unknown>): boolean {
  const current = fingerprintSyncSnapshot(extractSyncSnapshot(data));
  const stored = readStoredFingerprint(data);
  return stored === null || stored !== current;
}

export function sanitizeMarkdownInline(text: string): string {
  return text.replace(/\r?\n/g, " ");
}

export function buildSyncComment(data: Record<string, unknown>, xbriefPath: string): string {
  const snapshot = extractSyncSnapshot(data);
  const safeTitle = sanitizeMarkdownInline(snapshot.title);
  const lines: string[] = [
    SYNC_COMMENT_HEADER,
    "",
    `**Scope:** ${safeTitle}`,
    `**Status:** \`${sanitizeMarkdownInline(snapshot.status)}\``,
    `**xBRIEF:** \`${xbriefPath}\``,
  ];

  if (snapshot.items.length > 0) {
    lines.push("", "### Plan items", "");
    for (const item of snapshot.items) {
      lines.push(
        `- **${sanitizeMarkdownInline(item.status)}** — ${sanitizeMarkdownInline(item.title)}`,
      );
    }
  }

  if (snapshot.acceptance.length > 0) {
    lines.push("", "### Acceptance criteria", "", snapshot.acceptance);
  }

  lines.push("", "_Posted by `task issue:sync-from-xbrief`._");
  return lines.join("\n");
}

export interface SyncFromXbriefOptions {
  readonly xbriefPath: string;
  readonly dryRun?: boolean;
  readonly projectRoot?: string;
  readonly repo?: string;
  readonly allowCrossRepo?: boolean;
  readonly repoAllowlist?: readonly string[];
  readonly runFn?: RunGhApiFn;
  readonly writeErr?: (message: string) => void;
  readonly writeOut?: (message: string) => void;
  readonly writeFingerprint?: (absPath: string, data: Record<string, unknown>) => void;
}

export function stampIssueSyncFingerprint(
  data: Record<string, unknown>,
  origin: OriginIssueTarget,
): Record<string, unknown> {
  const plan = (data.plan ?? {}) as Record<string, unknown>;
  const metadata = { ...((plan.metadata as Record<string, unknown> | undefined) ?? {}) };
  metadata.issueSync = {
    fingerprint: fingerprintSyncSnapshot(extractSyncSnapshot(data)),
    syncedAt: new Date().toISOString(),
    issueNumber: origin.number,
    repo: origin.repo,
  };
  plan.metadata = metadata;
  return { ...data, plan };
}

export function syncFromXbrief(options: SyncFromXbriefOptions): number {
  const writeErr = options.writeErr ?? ((message) => process.stderr.write(`${message}\n`));
  const writeOut = options.writeOut ?? ((message) => process.stdout.write(`${message}\n`));
  const absPath = resolve(options.xbriefPath);

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(absPath, "utf8")) as Record<string, unknown>;
  } catch (exc) {
    writeErr(
      `issue:sync-from-xbrief: cannot read ${options.xbriefPath}: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
    return 1;
  }

  const projectRoot = resolveProjectRoot(options.projectRoot) ?? process.cwd();
  const fallbackRepo = resolveProjectRepo(options.repo, projectRoot);
  const origin = resolveOriginIssue(data, { fallbackRepo });
  if (origin === null) {
    writeErr(
      "issue:sync-from-xbrief: no linked GitHub issue origin in xBRIEF references (x-xbrief/github-issue); skip or add origin reference.",
    );
    return 1;
  }

  if (!hasMaterialChanges(data)) {
    writeOut(
      `issue:sync-from-xbrief: no material AC/status changes since last sync for #${origin.number}; nothing to post.`,
    );
    return 0;
  }

  const mutateGate = isRepoMutationAllowed(origin.repo, projectRoot, {
    allowCrossRepo: options.allowCrossRepo,
    allowlist: options.repoAllowlist,
    explicitRepo: fallbackRepo,
  });
  if (!mutateGate.allowed) {
    writeErr(
      `issue:sync-from-xbrief: ${mutateGate.reason ?? `refusing cross-repo mutation on ${origin.repo}`}`,
    );
    return 1;
  }

  const relPath = options.xbriefPath.replace(/\\/g, "/");
  const comment = buildSyncComment(data, relPath);

  if (options.dryRun) {
    writeOut(
      `issue:sync-from-xbrief: dry-run would post comment to ${origin.repo}#${origin.number}:\n`,
    );
    writeOut(comment);
    return 0;
  }

  let commentResult: Record<string, unknown>;
  try {
    commentResult = createIssueComment(origin.repo, origin.number, {
      body: comment,
      runFn: options.runFn,
    });
  } catch (exc) {
    writeErr(
      `issue:sync-from-xbrief: failed to post comment: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
    return 1;
  }

  writeOut(
    `issue:sync-from-xbrief: posted comment to ${origin.repo}#${origin.number} (id: ${commentResult.id}).`,
  );

  const writeFingerprint =
    options.writeFingerprint ??
    ((targetPath, stamped) => {
      writeFileSync(targetPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
    });

  try {
    writeFingerprint(absPath, stampIssueSyncFingerprint(data, origin));
  } catch (exc) {
    writeErr(
      `issue:sync-from-xbrief: comment posted (id: ${commentResult.id}) but failed to persist sync fingerprint in ${options.xbriefPath}: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
    return 1;
  }
  return 0;
}

export interface SyncFromXbriefCliArgs {
  readonly path?: string;
  readonly dryRun?: boolean;
  readonly projectRoot?: string;
  readonly repo?: string;
  readonly allowCrossRepo?: boolean;
  readonly repoAllowlist?: readonly string[];
}

export function syncFromXbriefMain(args: SyncFromXbriefCliArgs): number {
  if (args.path === undefined || args.path.length === 0) {
    process.stderr.write("issue:sync-from-xbrief: xBRIEF path required\n");
    return 2;
  }
  return syncFromXbrief({
    xbriefPath: args.path,
    dryRun: args.dryRun,
    projectRoot: args.projectRoot,
    repo: args.repo,
    allowCrossRepo: args.allowCrossRepo,
    repoAllowlist: args.repoAllowlist,
  });
}
