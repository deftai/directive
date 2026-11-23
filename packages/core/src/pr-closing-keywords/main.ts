import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isChangelogEntryPath } from "../changelog/entry-path.js";
import { containedWrite } from "../fs/contained-write.js";
import { extractIntentCloserSet } from "../one-pr-unit/closer-set.js";
import { evaluateOnePrUnit } from "../one-pr-unit/evaluate.js";
import {
  enforceLiveOnePrUnitCheck,
  loadOnePrUnitGrant,
  resolveProductionAppStore,
} from "../one-pr-unit/store.js";
import { MISSING_ONE_PR_UNIT_CONSENT } from "../one-pr-unit/types.js";
import { collectGithubRefs } from "../orphan-active/refs.js";
import {
  type ActiveRunningBrief,
  isProductPullRequestUnset,
  listActiveRunningBriefs,
  productPullRequestFromPlan,
} from "../orphan-active/running-briefs.js";
import { isLandsWithProductPlan } from "../scope/lifecycle-write.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { parseGitHubRemoteRepo } from "../text/redos-safe.js";
import { resolveRepo } from "../triage/queue/repo.js";
import {
  briefLandHeadReader,
  evaluateBriefLandScopeRecord,
  isScopeRecordPath,
  type ReadHeadFileFn,
} from "./brief-land-records.js";
// Keep this import before ./story-issue.js: plan-id-adopter.ts (reached through it)
// reads WRITE_STORY_LINE_COMMAND at module load (#6468).
import {
  EXIT_CONFIG_ERROR,
  EXIT_HITS_FOUND,
  EXIT_OK,
  WRITE_STORY_LINE_COMMAND,
} from "./constants.js";
import { findAllClosingKeywordHits, findHits, renderHit } from "./detect.js";
import {
  defaultRunGh,
  fetchPrBody,
  fetchPrCommitMessages,
  fetchPrMergeBaseSha,
  fetchRepoFileAtRef,
} from "./gh.js";
import { readCommitsFile, readTextFile } from "./io.js";
import { briefForBodyRef, storyDemandResolver, storyIssuesOfBrief } from "./story-issue.js";
import type {
  ClosingKeywordMode,
  FullStoryCloseIntent,
  Hit,
  ParsedArgs,
  ReadMergeBaseFileFn,
  RunGhFn,
  WriteStoryLineResult,
} from "./types.js";

export interface PrDiffPath {
  readonly status: string;
  readonly path: string;
  /** GitHub rename source (`previous_filename`); used for brief-land identity (#5387 S3). */
  readonly previousFilename?: string;
}

function normalizeDiffPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isBriefLandAllowlistedPath(path: string): boolean {
  const p = normalizeDiffPath(path);
  if (isChangelogEntryPath(p)) {
    return true;
  }
  return /^(xbrief|vbrief)\/(proposed|pending|active)\//.test(p);
}

/**
 * Path B activation / membership-land shape (#5387): allowlist only.
 * Every path (and rename source) is nonterminal brief under proposed|pending|active
 * or a changelog entry path (root CHANGELOG.md or changelog.d/<name>.md).
 * Requires at least one non-removed nonterminal brief.
 * Denies completed/, packages/**, and all other product surfaces.
 *
 * Activation-PR record carry (#6937): `.deft/observable-scope/<f>.json` and
 * `.deft/intent-constraint/<f>.json` keep the shape only when `readHeadFile`
 * is given and each record matches a brief this diff adds or changes
 * (`evaluateBriefLandScopeRecord`). Without a reader they leave the PR not
 * brief-land shaped, as before.
 */
export function isBriefLandShapedDiff(
  files: readonly PrDiffPath[],
  readHeadFile?: ReadHeadFileFn,
): boolean {
  if (files.length === 0) {
    return false;
  }
  let hasNonRemovedNonterminal = false;
  for (const file of files) {
    const dest = normalizeDiffPath(file.path);
    if (isScopeRecordPath(dest)) {
      if (!evaluateBriefLandScopeRecord({ file, files, readHeadFile }).ok) {
        return false;
      }
      continue;
    }
    if (!isBriefLandAllowlistedPath(dest)) {
      return false;
    }
    if (
      typeof file.previousFilename === "string" &&
      file.previousFilename.length > 0 &&
      !isBriefLandAllowlistedPath(file.previousFilename)
    ) {
      return false;
    }
    if (/^(xbrief|vbrief)\/(proposed|pending|active)\//.test(dest)) {
      const status = file.status.toLowerCase();
      if (status !== "removed") {
        hasNonRemovedNonterminal = true;
      }
    }
  }
  return hasNonRemovedNonterminal;
}

/** Leftover-shaped: every path under xbrief|vbrief, active removed, completed added (#4919). */
export function isLeftoverShapedDiff(files: readonly PrDiffPath[]): boolean {
  if (files.length === 0) {
    return false;
  }
  let removedActive = false;
  let addedCompleted = false;
  for (const file of files) {
    const p = file.path.replace(/\\/g, "/");
    if (!(p.startsWith("xbrief/") || p.startsWith("vbrief/"))) {
      return false;
    }
    const status = file.status.toLowerCase();
    // Extra proposed/pending churn disqualifies the leftover exception (#4919).
    if (/\/(proposed|pending)\//.test(p)) {
      return false;
    }
    if (/\/active\//.test(p)) {
      if (status === "removed" || status === "renamed" || status.startsWith("r")) {
        removedActive = true;
      } else {
        return false;
      }
    }
    if (/\/completed\//.test(p)) {
      if (status === "added" || status === "renamed" || status.startsWith("r")) {
        addedCompleted = true;
      } else {
        return false;
      }
    }
  }
  return removedActive && addedCompleted;
}

/** proposed|pending → completed without active is refused at admission (#4919). */
export function isSkipActiveDeliveryShape(files: readonly PrDiffPath[]): boolean {
  let removedProposedOrPending = false;
  let removedActive = false;
  let addedCompleted = false;
  for (const file of files) {
    const p = file.path.replace(/\\/g, "/");
    if (!(p.startsWith("xbrief/") || p.startsWith("vbrief/"))) {
      // Mixed source+brief diffs still refuse skip-active; do not bypass admission (#4919).
      continue;
    }
    const status = file.status.toLowerCase();
    if (
      (status === "removed" || status === "renamed" || status.startsWith("r")) &&
      /\/(proposed|pending)\//.test(p)
    ) {
      removedProposedOrPending = true;
    }
    if (
      (status === "removed" || status === "renamed" || status.startsWith("r")) &&
      /\/active\//.test(p)
    ) {
      removedActive = true;
    }
    if (
      (status === "added" || status === "renamed" || status.startsWith("r")) &&
      /\/completed\//.test(p)
    ) {
      addedCompleted = true;
    }
  }
  return removedProposedOrPending && addedCompleted && !removedActive;
}

function mapGitNameStatus(letter: string): string {
  const ch = (letter[0] ?? "").toUpperCase();
  if (ch === "A") return "added";
  if (ch === "M") return "modified";
  if (ch === "D") return "removed";
  if (ch === "R") return "renamed";
  if (ch === "C") return "copied";
  return letter.toLowerCase();
}

/** Offline --body-file: name-status vs upstream merge-base (master|main). */
function collectLocalDiffFiles(projectRoot: string, runGit: RunGhFn): PrDiffPath[] | null {
  const prev = process.cwd();
  try {
    process.chdir(projectRoot);
  } catch {
    return null;
  }
  try {
    let base: string | null = null;
    for (const upstream of ["origin/master", "origin/main", "master", "main"] as const) {
      const mb = runGit(["merge-base", "HEAD", upstream]);
      if (mb.returncode === 0 && mb.stdout.trim().length > 0) {
        base = mb.stdout.trim();
        break;
      }
    }
    if (base === null) {
      // No delivery base — skip offline admission rather than diff HEAD..HEAD.
      return null;
    }
    const diff = runGit(["diff", "-z", "--name-status", "--find-renames", base, "HEAD"]);
    if (diff.returncode !== 0) {
      return [];
    }
    const out: PrDiffPath[] = [];
    const tokens = diff.stdout.split("\0");
    let i = 0;
    while (i < tokens.length) {
      const status = (tokens[i] ?? "").trim();
      if (status.length === 0) {
        i += 1;
        continue;
      }
      if (status.startsWith("R") || status.startsWith("C")) {
        const previousFilename = tokens[i + 1] ?? "";
        const path = tokens[i + 2] ?? "";
        if (path.length > 0) {
          out.push({
            status: mapGitNameStatus(status),
            path,
            ...(previousFilename.length > 0 ? { previousFilename } : {}),
          });
        }
        i += 3;
        continue;
      }
      const path = tokens[i + 1] ?? "";
      if (path.length > 0) {
        out.push({ status: mapGitNameStatus(status), path });
      }
      i += 2;
    }
    return out;
  } finally {
    try {
      process.chdir(prev);
    } catch {
      /* ignore */
    }
  }
}

function fetchPrFiles(pr: number, repo: string, runGh: RunGhFn): PrDiffPath[] | null {
  const out: PrDiffPath[] = [];
  // Paginate beyond page 1 so later nonterminal briefs cannot bypass admission (#4919).
  for (let page = 1; page <= 30; page += 1) {
    const result = runGh([
      "gh",
      "api",
      `repos/${repo}/pulls/${String(pr)}/files?per_page=100&page=${String(page)}`,
    ]);
    if (result.returncode !== 0) {
      process.stderr.write(
        `Error: gh REST failed fetching PR #${pr} files page ${String(page)}: ${result.stderr.trim()}\n`,
      );
      return null;
    }
    try {
      const payload: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(payload)) {
        process.stderr.write(`Error: PR #${pr} files payload is not an array\n`);
        return null;
      }
      if (payload.length === 0) {
        break;
      }
      for (const item of payload) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const path = typeof rec.filename === "string" ? rec.filename : "";
        const status = typeof rec.status === "string" ? rec.status : "";
        const previousFilename =
          typeof rec.previous_filename === "string" && rec.previous_filename.length > 0
            ? rec.previous_filename
            : undefined;
        if (path.length > 0) {
          out.push(
            previousFilename === undefined ? { path, status } : { path, status, previousFilename },
          );
        }
      }
      if (payload.length < 100) {
        break;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: failed to parse PR #${pr} files: ${message}\n`);
      return null;
    }
  }
  return out;
}

/** Exported for #5387 finalize-honesty regressions (activation PR never positive-matches). */
export function briefHasMatchingProductPr(
  projectRoot: string,
  issue: number,
  prNumber: number,
  repo: string,
): { ok: boolean; detail: string } {
  const folders = [
    "xbrief/proposed",
    "xbrief/pending",
    "xbrief/active",
    "xbrief/completed",
    "vbrief/proposed",
    "vbrief/pending",
    "vbrief/active",
    "vbrief/completed",
  ];
  for (const folder of folders) {
    const dir = join(projectRoot, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const full = join(dir, name);
      try {
        const raw: unknown = JSON.parse(readFileSync(full, "utf8"));
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
        const plan = (raw as Record<string, unknown>).plan;
        if (typeof plan !== "object" || plan === null || Array.isArray(plan)) continue;
        const planObj = plan as Record<string, unknown>;
        const { issues } = collectGithubRefs(planObj, repo);
        const matched = issues.some(
          (ref) => ref.repo.toLowerCase() === repo.toLowerCase() && ref.number === issue,
        );
        if (!matched) continue;
        if (productPullRequestFromPlan(planObj) === prNumber) {
          return { ok: true, detail: relative(projectRoot, full).replace(/\\/g, "/") };
        }
        return {
          ok: false,
          detail:
            `brief ${relative(projectRoot, full).replace(/\\/g, "/")} for #${String(issue)} ` +
            `lacks metadata.productPullRequest=${String(prNumber)}`,
        };
      } catch {
        /* skip unreadable */
      }
    }
  }
  return {
    ok: false,
    detail: `no TIP_NONTERMINAL/completed brief for #${String(issue)} with productPullRequest=${String(prNumber)}`,
  };
}

function changedNonterminalBriefPaths(files: readonly PrDiffPath[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const p = file.path.replace(/\\/g, "/");
    if (!/^(xbrief|vbrief)\/(proposed|pending|active)\//.test(p)) {
      continue;
    }
    const status = file.status.toLowerCase();
    if (status === "removed") {
      continue;
    }
    out.push(p);
  }
  return out;
}

function bindChangedBriefPath(args: {
  readonly projectRoot: string;
  readonly relPath: string;
  readonly prNumber: number;
  readonly repo: string;
  readonly marks: readonly number[];
}): { ok: boolean; detail: string } {
  const full = join(args.projectRoot, args.relPath);
  if (!existsSync(full)) {
    return {
      ok: false,
      detail: `changed nonterminal brief ${args.relPath} missing on checkout`,
    };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(full, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, detail: `changed brief ${args.relPath} is not a JSON object` };
    }
    const plan = (raw as Record<string, unknown>).plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      return { ok: false, detail: `changed brief ${args.relPath} lacks plan` };
    }
    const planObj = plan as Record<string, unknown>;
    const { issues } = collectGithubRefs(planObj, args.repo);
    const matchedIssues = issues
      .filter((ref) => ref.repo.toLowerCase() === args.repo.toLowerCase())
      .map((ref) => ref.number);
    if (matchedIssues.length === 0) {
      return {
        ok: false,
        detail: `changed brief ${args.relPath} has no issue ref for ${args.repo}`,
      };
    }
    const stamped = productPullRequestFromPlan(planObj);
    if (stamped !== args.prNumber) {
      return {
        ok: false,
        detail: `changed brief ${args.relPath} lacks metadata.productPullRequest=${String(args.prNumber)}`,
      };
    }
    const bound = matchedIssues.some((n) => args.marks.includes(n));
    if (!bound) {
      return {
        ok: false,
        detail: `changed brief ${args.relPath} issue #${String(matchedIssues[0])} is not covered by deft-story marks`,
      };
    }
    return { ok: true, detail: args.relPath };
  } catch (err: unknown) {
    return {
      ok: false,
      detail: `changed brief ${args.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Nonterminal brief paths with status=removed (activation must not skip these). */
function removedNonterminalBriefPaths(files: readonly PrDiffPath[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const p = normalizeDiffPath(file.path);
    if (!/^(xbrief|vbrief)\/(proposed|pending|active)\//.test(p)) {
      continue;
    }
    if (file.status.toLowerCase() === "removed") {
      out.push(p);
    }
  }
  return out;
}

/**
 * Path B activation admit witness (#5387 / #5792): brief-land shape + no deleted
 * nonterminals + productPullRequest unset on every changed brief. When PR
 * bodyText is a non-null string (live/file body, including empty), deft-story
 * marks must cover each changed nonterminal. When bodyText is null (local check),
 * inventory brief issue-ref identity substitutes for mark coverage (#5792 Recut-1).
 * Empty live bodies must not take the local fallback (Greptile P1 on #5792).
 * Malformed stamps are not unset.
 */
export function evaluatePathBActivationAdmit(args: {
  readonly bodyText: string | null;
  readonly prNumber: number | null;
  readonly projectRoot: string;
  readonly repo: string;
  readonly files: readonly PrDiffPath[];
}): { ok: boolean; detail: string } {
  // Offline (#5736): brief-land identity (marks ↔ changed-brief issue refs +
  // unset productPullRequest) runs with prNumber null. Live stamp binding still
  // needs a PR number on the product path below.
  if (!isBriefLandShapedDiff(args.files, briefLandHeadReader(args.projectRoot))) {
    return { ok: false, detail: "not brief-land shaped" };
  }
  const removedNonterminal = removedNonterminalBriefPaths(args.files);
  if (removedNonterminal.length > 0) {
    return {
      ok: false,
      detail:
        `Path B activation refuses deleted nonterminal brief(s): ${removedNonterminal.join(", ")} ` +
        "(use leftover-shaped land or keep the brief)",
    };
  }
  const changedNonterminal = changedNonterminalBriefPaths(args.files);
  if (changedNonterminal.length === 0) {
    return { ok: false, detail: "no nonterminal brief land" };
  }
  // #5792: null bodyText → local issue-ref identity; "" / whitespace live body still needs marks.
  // #7083: a `deft-story-part: N` line counts as mark coverage, offline and live, so one
  // brief-only PR activates a cohort with the line each per-story activation carries.
  const bodyText = args.bodyText;
  const marks =
    typeof bodyText === "string" && bodyText.trim().length > 0
      ? [
          ...new Set([
            ...parseAllDeftStoryMarks(bodyText),
            ...parseAllDeftStoryPartLines(bodyText),
          ]),
        ].sort((a, b) => a - b)
      : [];
  if (bodyText !== null && marks.length === 0) {
    return { ok: false, detail: "missing deft-story marks or deft-story-part lines" };
  }
  const coveredIssues = new Set<number>();
  for (const relPath of changedNonterminal) {
    const full = join(args.projectRoot, relPath);
    if (!existsSync(full)) {
      return { ok: false, detail: `changed nonterminal brief ${relPath} missing on checkout` };
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(full, "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, detail: `changed brief ${relPath} is not a JSON object` };
      }
      const plan = (raw as Record<string, unknown>).plan;
      if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
        return { ok: false, detail: `changed brief ${relPath} lacks plan` };
      }
      const planObj = plan as Record<string, unknown>;
      if (!isProductPullRequestUnset(planObj)) {
        return {
          ok: false,
          detail: `changed brief ${relPath} has metadata.productPullRequest (activation requires unset)`,
        };
      }
      const { issues } = collectGithubRefs(planObj, args.repo);
      const matchedIssues = issues
        .filter((ref) => ref.repo.toLowerCase() === args.repo.toLowerCase())
        .map((ref) => ref.number);
      if (matchedIssues.length === 0) {
        return {
          ok: false,
          detail: `changed brief ${relPath} has no issue ref for ${args.repo}`,
        };
      }
      for (const n of matchedIssues) {
        coveredIssues.add(n);
      }
      if (bodyText !== null && !matchedIssues.some((n) => marks.includes(n))) {
        return {
          ok: false,
          detail: `changed brief ${relPath} issue #${String(matchedIssues[0])} is not covered by deft-story marks`,
        };
      }
    } catch (err: unknown) {
      return {
        ok: false,
        detail: `changed brief ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (bodyText !== null) {
    for (const issue of marks) {
      if (!coveredIssues.has(issue)) {
        return {
          ok: false,
          detail: `deft-story: ${String(issue)} has no matching changed nonterminal brief on Path B activation`,
        };
      }
    }
  } else if (coveredIssues.size === 0) {
    return { ok: false, detail: "no inventory brief issue-ref identity for local Path B witness" };
  }
  const offlineNote =
    bodyText === null
      ? " (local issue-ref identity #5792)"
      : args.prNumber === null
        ? " (offline identity #5736)"
        : "";
  return {
    ok: true,
    detail: `Path B brief-land activation admitted (#5387)${offlineNote}`,
  };
}

/** Raw `metadata.productPullRequest` for equality; `undefined` when unset (#6316). */
function productPullRequestRaw(plan: Record<string, unknown>): string | undefined {
  if (isProductPullRequestUnset(plan)) {
    return undefined;
  }
  const metadata = plan.metadata as Record<string, unknown>;
  return JSON.stringify(metadata.productPullRequest ?? null);
}

function planFromBriefText(text: string): Record<string, unknown> | null {
  const raw: unknown = JSON.parse(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const plan = (raw as Record<string, unknown>).plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

/**
 * Part-line admission for one changed nonterminal brief (#6316 / #6310 Bound 1).
 * A brief covered by a mark keeps the mark's rules. A brief covered only by a part
 * line passes when its `metadata.productPullRequest` on the head equals the merge
 * base (unset or unchanged); it fails when the head names this PR or otherwise differs.
 */
function bindPartLineBriefPath(args: {
  readonly projectRoot: string;
  readonly relPath: string;
  readonly previousFilename: string | undefined;
  readonly prNumber: number;
  readonly repo: string;
  readonly marks: readonly number[];
  readonly parts: readonly number[];
  readonly readMergeBaseFile: ReadMergeBaseFileFn | undefined;
}): { ok: boolean; detail: string } {
  const full = join(args.projectRoot, args.relPath);
  if (!existsSync(full)) {
    return { ok: false, detail: `changed nonterminal brief ${args.relPath} missing on checkout` };
  }
  let headPlan: Record<string, unknown> | null;
  try {
    headPlan = planFromBriefText(readFileSync(full, "utf8"));
  } catch (err: unknown) {
    return {
      ok: false,
      detail: `changed brief ${args.relPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (headPlan === null) {
    return { ok: false, detail: `changed brief ${args.relPath} lacks plan` };
  }
  const issues = storyIssuesOfBrief(headPlan, args.repo);
  if (issues.some((n) => args.marks.includes(n))) {
    return bindChangedBriefPath(args);
  }
  const partIssue = issues.find((n) => args.parts.includes(n));
  if (partIssue === undefined) {
    return {
      ok: false,
      detail:
        `changed brief ${args.relPath} issue #${String(issues[0] ?? "?")} is not covered by ` +
        "deft-story or deft-story-part lines",
    };
  }
  if (productPullRequestFromPlan(headPlan) === args.prNumber) {
    return {
      ok: false,
      detail:
        `part-line PR #${String(args.prNumber)} sets metadata.productPullRequest to itself on ` +
        `${args.relPath}; only the PR that completes #${String(partIssue)} (deft-story: ` +
        `${String(partIssue)}) is the story's product PR (#6316)`,
    };
  }
  if (args.readMergeBaseFile === undefined) {
    return {
      ok: false,
      detail: `cannot read merge-base ${args.relPath} for part-line admission (#6316)`,
    };
  }
  const base = args.readMergeBaseFile(args.previousFilename ?? args.relPath);
  if (base.kind === "error") {
    return { ok: false, detail: `merge-base read for part-line admission failed: ${base.detail}` };
  }
  let baseRaw: string | undefined;
  if (base.kind === "ok") {
    try {
      const basePlan = planFromBriefText(base.text);
      baseRaw = basePlan === null ? undefined : productPullRequestRaw(basePlan);
    } catch (err: unknown) {
      return {
        ok: false,
        detail: `merge-base ${args.relPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const headRaw = productPullRequestRaw(headPlan);
  if (headRaw !== baseRaw) {
    return {
      ok: false,
      detail:
        `part-line PR #${String(args.prNumber)} changes metadata.productPullRequest on ` +
        `${args.relPath} (merge base: ${baseRaw ?? "unset"}, head: ${headRaw ?? "unset"}); ` +
        "a part PR leaves that stamp as it was (#6316)",
    };
  }
  return { ok: true, detail: args.relPath };
}

/**
 * Pre-merge full-story mark producer/admission (#4919 / #4864 / #5387).
 * Order: leftover-admit → skip-active-refuse → Path B activation early-return → stamp gates.
 * Product PRs that touch nonterminal briefs require deft-story + matching metadata, or
 * a `deft-story-part: N` line that leaves the product-PR stamp as it was (#6316).
 */
export function evaluateFullStoryMarkAdmission(args: {
  readonly bodyText: string | null;
  readonly prNumber: number | null;
  readonly projectRoot: string;
  readonly repo: string;
  readonly files: readonly PrDiffPath[];
  /** Merge-base reader for part-line admission (#6316); absent fails a part-line PR closed. */
  readonly readMergeBaseFile?: ReadMergeBaseFileFn;
}): { ok: boolean; messages: string[] } {
  const messages: string[] = [];
  if (isLeftoverShapedDiff(args.files)) {
    return { ok: true, messages: ["leftover-shaped diff admitted (#4919)"] };
  }
  if (isSkipActiveDeliveryShape(args.files)) {
    return {
      ok: false,
      messages: [
        "FAIL: skip-active delivery shape (proposed|pending → completed without active) refused (#4919). " +
          "Route the brief through active/ or use a leftover-shaped rename from active/.",
      ],
    };
  }
  const activation = evaluatePathBActivationAdmit(args);
  if (activation.ok) {
    return { ok: true, messages: [activation.detail] };
  }
  // Offline brief-land (#5736): hard-fail missing/wrong/partial marks and other
  // activation identity refuses. Live stamped product PRs that also delete a
  // brief still fall through to product stamp gates (#5388).
  if (
    args.prNumber === null &&
    isBriefLandShapedDiff(args.files, briefLandHeadReader(args.projectRoot))
  ) {
    return { ok: false, messages: [`FAIL: ${activation.detail}`] };
  }
  if (
    activation.detail.includes("has no matching changed nonterminal brief on Path B activation")
  ) {
    return { ok: false, messages: [`FAIL: ${activation.detail}`] };
  }
  const changedNonterminal = changedNonterminalBriefPaths(args.files);
  if (changedNonterminal.length === 0) {
    return { ok: true, messages };
  }
  // Product stamp binding needs a live PR number (#5736 leaves that to live admission).
  if (args.prNumber === null) {
    return { ok: true, messages };
  }
  const marks = parseAllDeftStoryMarks(args.bodyText ?? "");
  const parts = parseAllDeftStoryPartLines(args.bodyText ?? "");
  const conflicts = marks.filter((n) => parts.includes(n));
  if (conflicts.length > 0) {
    return { ok: false, messages: [formatStoryLineConflict(conflicts)] };
  }
  if (marks.length === 0 && parts.length === 0) {
    return {
      ok: false,
      messages: [
        "FAIL: product pull request touches nonterminal xBRIEF without `deft-story: N` (#4864 / #4919). " +
          storyLineAdvice(null),
      ],
    };
  }
  // Each changed nonterminal path must itself bind; a stamped sibling cannot satisfy (#4919).
  for (const relPath of changedNonterminal) {
    const bind =
      parts.length === 0
        ? bindChangedBriefPath({
            projectRoot: args.projectRoot,
            relPath,
            prNumber: args.prNumber,
            repo: args.repo,
            marks,
          })
        : bindPartLineBriefPath({
            projectRoot: args.projectRoot,
            relPath,
            previousFilename: args.files.find((f) => normalizeDiffPath(f.path) === relPath)
              ?.previousFilename,
            prNumber: args.prNumber,
            repo: args.repo,
            marks,
            parts,
            readMergeBaseFile: args.readMergeBaseFile,
          });
    if (!bind.ok) {
      messages.push(`FAIL: ${bind.detail}`);
    }
  }
  for (const issue of marks) {
    const bind = briefHasMatchingProductPr(args.projectRoot, issue, args.prNumber, args.repo);
    if (!bind.ok) {
      messages.push(`FAIL: ${bind.detail}`);
    }
  }
  return { ok: messages.length === 0, messages };
}

/**
 * Parse PR-body full-story close intent (#4864): a line `deft-story: N` (digits only).
 * Not an authorization path for Closes/Fixes/Resolves; `--allow-close` stays CLI-only.
 * `deft-close-intent: full` is intentionally ignored here (stays unauthorized).
 */
export function parseDeftStoryMark(text: string): number | null {
  const re = /^\s*deft-story:\s*(\d+)\s*$/gim;
  const match = re.exec(text);
  if (match === null) {
    return null;
  }
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** All distinct `deft-story: N` marks in text (#4864). */
export function parseAllDeftStoryMarks(text: string): number[] {
  const re = /^\s*deft-story:\s*(\d+)\s*$/gim;
  const out = new Set<number>();
  let match = re.exec(text);
  while (match !== null) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) {
      out.add(n);
    }
    match = re.exec(text);
  }
  return [...out].sort((a, b) => a - b);
}

export function fullStoryCloseIntentFromBody(text: string): FullStoryCloseIntent | null {
  const issue = parseDeftStoryMark(text);
  return issue === null ? null : { issue, source: "deft-story" };
}

/**
 * All distinct `deft-story-part: N` lines (#6316): line start, digits only, like the
 * mark. A part line says the PR belongs to story N and does not complete it. It is
 * never a finalize close signal (`parseAllDeftStoryMarks` does not match it).
 */
const STORY_PART_PREFIX = "deft-story-part:";

/**
 * Values of every `deft-story-part:` line, trimmed. Line-based scan with no
 * backtracking regex, so long whitespace runs stay linear (CodeQL js/polynomial-redos).
 */
function storyPartLineValues(text: string): string[] {
  const values: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.slice(0, STORY_PART_PREFIX.length).toLowerCase() === STORY_PART_PREFIX) {
      values.push(line.slice(STORY_PART_PREFIX.length).trim());
    }
  }
  return values;
}

export function parseAllDeftStoryPartLines(text: string): number[] {
  const out = new Set<number>();
  for (const value of storyPartLineValues(text)) {
    if (!/^\d+$/.test(value)) continue;
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) {
      out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Present `deft-story-part:` lines whose value is not a positive decimal issue number. */
export function findUnparseableDeftStoryPartLines(text: string): string[] {
  const bad: string[] = [];
  for (const value of storyPartLineValues(text)) {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      bad.push(value.length > 0 ? value : "(empty)");
    }
  }
  return bad;
}

/** Issues that carry both `deft-story: N` and `deft-story-part: N` in one body (#6316). */
export function findStoryLineConflicts(text: string): number[] {
  const parts = new Set(parseAllDeftStoryPartLines(text));
  return parseAllDeftStoryMarks(text).filter((n) => parts.has(n));
}

/** Defined in constants.ts so it is initialized before plan-id-adopter.ts loads (#6468). */
export { WRITE_STORY_LINE_COMMAND };

/**
 * Shared advice for an active story's PR body (#6316): the two lines, which one to
 * use, and the command that writes it. Used by refusals and advisories.
 */
export function storyLineAdvice(issue: number | null): string {
  const n = issue === null ? "N" : String(issue);
  return (
    `For an active story, do not use Closes #${n}. Put \`deft-story: ${n}\` on the PR that ` +
    `completes the story and \`deft-story-part: ${n}\` on any other product PR of it, ` +
    `including an authority-record PR (for example an intent-constraint mint, #6335); ` +
    `\`Refs #${n}\` alone is not a completion basis. Write the line with ${WRITE_STORY_LINE_COMMAND}.`
  );
}

const STORY_REF_KEYWORD_RE = /\b(?:refs?|tracking|related)\b/gi;
const STORY_REF_TOKEN_RE =
  /^(?:https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)|(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#(\d+))/;
const STORY_REF_FENCE_RE = /^\s*(`{3,}|~{3,})/;

function backticksBefore(line: string, index: number): number {
  let count = 0;
  for (let i = 0; i < index; i += 1) {
    if (line[i] === "`") count += 1;
  }
  return count;
}

/**
 * Issue numbers a PR body names with `Refs` / `Tracking` / `Related` (#6316).
 * Accepts `#N`, `owner/repo#N` and issue URLs; lists like `Refs #1, #2`. Other
 * repositories, fenced code blocks and inline code spans are ignored.
 */
export function parseStoryRefIssues(text: string, repo: string): number[] {
  const out = new Set<number>();
  const repoLower = repo.toLowerCase();
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = STORY_REF_FENCE_RE.exec(line);
    if (fenceMatch !== null) {
      const ch = (fenceMatch[1] ?? "`")[0] ?? "`";
      if (fence === null) fence = ch;
      else if (fence === ch) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const keywordRe = new RegExp(STORY_REF_KEYWORD_RE.source, "gi");
    let keyword = keywordRe.exec(line);
    while (keyword !== null) {
      if (backticksBefore(line, keyword.index) % 2 === 0) {
        let rest = line.slice(keyword.index + keyword[0].length).replace(/^[ \t]*:?[ \t]*/, "");
        for (;;) {
          const token = STORY_REF_TOKEN_RE.exec(rest);
          if (token === null) break;
          const owner = token[1] ?? token[4];
          const name = token[2] ?? token[5];
          const number = Number(token[3] ?? token[6]);
          const sameRepo =
            owner === undefined || `${owner}/${name ?? ""}`.toLowerCase() === repoLower;
          if (sameRepo && Number.isInteger(number) && number > 0) {
            out.add(number);
          }
          rest = rest.slice(token[0].length).replace(/^[ \t]*(?:,|\band\b)?[ \t]*/i, "");
        }
      }
      keyword = keywordRe.exec(line);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Product-shaped diff for the story-line check: not a lifecycle-only land (#6316). */
export function isProductShapedDiff(
  files: readonly PrDiffPath[],
  readHeadFile?: ReadHeadFileFn,
): boolean {
  return (
    files.length > 0 && !isLeftoverShapedDiff(files) && !isBriefLandShapedDiff(files, readHeadFile)
  );
}

/** One required story line: why it is asked for, and the brief's issues that need none (#6468). */
interface StoryLineDemand {
  readonly why: string;
  readonly others: readonly number[];
}

function formatStoryLineMissing(prNumber: number, issue: number, demand: StoryLineDemand): string {
  const others =
    demand.others.length > 0
      ? [
          `  The other issues the brief names (${demand.others.map((n) => `#${String(n)}`).join(", ")}) ` +
            `need no line: one line, for story issue #${String(issue)}, serves the brief (#6468).`,
        ]
      : [];
  return [
    `FAIL: PR #${String(prNumber)} is a product PR of running story #${String(issue)} (${demand.why}) ` +
      "but carries neither story line (#6316).",
    ...others,
    "  Add exactly one of these lines to the PR body:",
    `    deft-story: ${String(issue)}        on the PR that completes the story`,
    `    deft-story-part: ${String(issue)}   on any other product PR of the story`,
    `  An authority-record PR (for example an intent-constraint mint) is not the completing ` +
      `delivery: it carries \`deft-story-part: ${String(issue)}\` (#6335).`,
    `  \`Refs #${String(issue)}\` alone is not a completion basis. Write the line, then update the PR body:`,
    `    ${WRITE_STORY_LINE_COMMAND}`,
    `    gh pr edit ${String(prNumber)} --body-file <path>`,
  ].join("\n");
}

function formatStoryLineConflict(issues: readonly number[]): string {
  const list = issues.map((n) => `#${String(n)}`).join(", ");
  return (
    `FAIL: PR body carries both \`deft-story: N\` and \`deft-story-part: N\` for ${list} (#6316). ` +
    "Keep one: the mark on the PR that completes the story, the part line on any other."
  );
}

/**
 * Story issues of the briefs this change set completes in-PR (#6277): a
 * `completed/` brief added or renamed in `files` whose plan on disk is stamped
 * `lands-with-product`.
 */
export function landsWithProductIssues(
  projectRoot: string,
  repo: string,
  files: readonly PrDiffPath[],
): number[] {
  const out = new Set<number>();
  for (const file of files) {
    const path = normalizeDiffPath(file.path);
    const status = file.status.toLowerCase();
    if (status === "removed" || status === "deleted") continue;
    if (!/^(?:xbrief|vbrief)\/completed\/[^/]+$/.test(path)) continue;
    let plan: Record<string, unknown> | null = null;
    try {
      const data = JSON.parse(readFileSync(join(projectRoot, path), "utf8")) as {
        plan?: unknown;
      };
      plan =
        typeof data.plan === "object" && data.plan !== null && !Array.isArray(data.plan)
          ? (data.plan as Record<string, unknown>)
          : null;
    } catch {
      plan = null;
    }
    if (plan === null || !isLandsWithProductPlan(plan)) continue;
    for (const issue of storyIssuesOfBrief(plan, repo)) out.add(issue);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Live pre-merge story-line check (#6316 / #6310 Bound 1). Any body with both lines
 * for one N fails. A product PR fails when it carries neither a sole `deft-story: N`
 * nor a sole `deft-story-part: N` and either its body names N with Refs / Tracking /
 * Related while N has a running brief in `active/`, or a running brief on the head
 * names this PR as `metadata.productPullRequest`. The mark keeps its own rules.
 * One line per running brief, for its story issue (#6468): the issue the completion
 * identity join anchors on; the brief's other issues need none. A brief whose story
 * issue the plan-id adopter's owner list contradicts (case A / case B) fails.
 */
export function evaluateStoryLineRequirement(args: {
  readonly bodyText: string;
  readonly prNumber: number;
  readonly projectRoot: string;
  readonly repo: string;
  readonly files: readonly PrDiffPath[];
}): { ok: boolean; messages: string[]; required: number[] } {
  const conflicts = findStoryLineConflicts(args.bodyText);
  if (conflicts.length > 0) {
    return { ok: false, messages: [formatStoryLineConflict(conflicts)], required: [] };
  }
  if (!isProductShapedDiff(args.files, briefLandHeadReader(args.projectRoot))) {
    return { ok: true, messages: [], required: [] };
  }
  // #6277 Bound 6: a PR that completes its story in-PR (a completed/ brief stamped
  // lands-with-product) cannot carry the part line: the identity join after
  // merge refuses a part-line PR on every basis (#6317).
  const parts = new Set(parseAllDeftStoryPartLines(args.bodyText));
  const landingMessages: string[] = [];
  for (const issue of landsWithProductIssues(args.projectRoot, args.repo, args.files)) {
    if (parts.has(issue)) {
      landingMessages.push(
        `FAIL: PR #${String(args.prNumber)} completes story #${String(issue)} in-PR ` +
          `(lands-with-product, #6277) but carries \`deft-story-part: ${String(issue)}\`. ` +
          "A part line cannot complete the story (#6317); remove it, and keep the closing keyword.",
      );
    }
  }
  if (landingMessages.length > 0) {
    return { ok: false, messages: landingMessages, required: [] };
  }
  const running = listActiveRunningBriefs(args.projectRoot);
  const required = new Map<number, StoryLineDemand>();
  const blocked = new Map<string, string>();
  const demandFor = storyDemandResolver(args.projectRoot, args.repo);
  const requireFor = (
    brief: ActiveRunningBrief,
    fallback: readonly number[],
    why: (rel: string) => string,
  ) => {
    const demand = demandFor(brief, fallback);
    if (demand.kind === "blocked") {
      blocked.set(demand.rel, demand.message);
      return;
    }
    const lines =
      demand.kind === "line"
        ? [{ issue: demand.issue, others: demand.others }]
        : demand.issues.map((issue) => ({ issue, others: [] as readonly number[] }));
    for (const line of lines) {
      if (!required.has(line.issue)) {
        required.set(line.issue, { why: why(demand.rel), others: line.others });
      }
    }
  };
  // #6468 Bound item 3: a body reference to N asks for the story line of N's brief.
  for (const issue of parseStoryRefIssues(args.bodyText, args.repo)) {
    const target = briefForBodyRef(running, args.repo, issue);
    if (target === null) continue;
    if (target === "today") {
      if (!required.has(issue)) {
        required.set(issue, {
          why: `body names #${String(issue)}; several running briefs name it`,
          others: [],
        });
      }
      continue;
    }
    requireFor(target, [issue], (rel) => `body names #${String(issue)}; running brief ${rel}`);
  }
  for (const brief of running) {
    if (productPullRequestFromPlan(brief.plan) !== args.prNumber) continue;
    requireFor(
      brief,
      storyIssuesOfBrief(brief.plan, args.repo),
      (rel) => `running brief ${rel} names this PR as metadata.productPullRequest`,
    );
  }
  const marks = new Set(parseAllDeftStoryMarks(args.bodyText));
  // Case A / case B (#6468 Bound item 2): no line satisfies these briefs.
  const messages: string[] = [...blocked.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, message]) => message);
  for (const [issue, demand] of [...required.entries()].sort((a, b) => a[0] - b[0])) {
    if (!marks.has(issue) && !parts.has(issue)) {
      messages.push(formatStoryLineMissing(args.prNumber, issue, demand));
    }
  }
  return {
    ok: messages.length === 0,
    messages,
    required: [...required.keys()].sort((a, b) => a - b),
  };
}

function resolveOfflineRepo(
  projectRoot: string,
  repoArg: string | null,
  runGit: RunGhFn,
): string | null {
  if (repoArg !== null && repoArg.trim().length > 0) {
    return repoArg.trim();
  }
  const origin = runGit(["-C", projectRoot, "remote", "get-url", "origin"]);
  // Shared remote parser keeps dotted repository names (owner/my.app) intact.
  return origin.returncode === 0 ? parseGitHubRemoteRepo(origin.stdout) : null;
}

/**
 * True when the branch name carries `planId` as a whole token: the characters on
 * both sides are not id characters, so `github.issue.123` does not match a branch
 * for `github.issue.1234`.
 */
function branchNamesPlanId(branch: string, planId: string): boolean {
  const idChar = /[A-Za-z0-9._-]/;
  let from = 0;
  for (;;) {
    const at = branch.indexOf(planId, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (branch[at - 1] ?? "");
    const after = branch[at + planId.length] ?? "";
    const boundedBefore = before === "" || before === "/" || !idChar.test(before);
    const boundedAfter = after === "" || after === "/" || !idChar.test(after);
    if (boundedBefore && boundedAfter) return true;
    from = at + 1;
  }
}

/**
 * Running-story issues for the current branch (#6316): a running brief the branch
 * changes, a running brief whose plan id the branch name carries, or a running
 * brief for an issue the body names with Refs / Tracking / Related.
 */
export function storyIssuesForBranch(args: {
  readonly projectRoot: string;
  readonly repo: string;
  readonly bodyText: string;
  readonly runGit: RunGhFn;
}): number[] {
  return storyLinesForBranch(args).issues;
}

/**
 * Story lines for the current branch (#6468 Bound item 5): one issue per running
 * brief, its story issue, and the case A / case B message of each brief no line
 * can serve. Briefs with no same-repository anchor keep today's per-issue rule.
 */
export function storyLinesForBranch(args: {
  readonly projectRoot: string;
  readonly repo: string;
  readonly bodyText: string;
  readonly runGit: RunGhFn;
}): { issues: number[]; blocked: string[] } {
  const running = listActiveRunningBriefs(args.projectRoot);
  if (running.length === 0) {
    return { issues: [], blocked: [] };
  }
  const changed = new Set(
    (collectLocalDiffFiles(args.projectRoot, args.runGit) ?? [])
      .filter((f) => f.status.toLowerCase() !== "removed")
      .map((f) => normalizeDiffPath(f.path)),
  );
  const branchResult = args.runGit(["-C", args.projectRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.returncode === 0 ? branchResult.stdout.trim() : "";
  const bodyRefs = parseStoryRefIssues(args.bodyText, args.repo);
  const out = new Set<number>();
  const blocked = new Map<string, string>();
  const demandFor = storyDemandResolver(args.projectRoot, args.repo);
  const lineFor = (brief: ActiveRunningBrief, fallback: readonly number[]) => {
    const demand = demandFor(brief, fallback);
    if (demand.kind === "blocked") {
      blocked.set(demand.rel, demand.message);
    } else if (demand.kind === "line") {
      out.add(demand.issue);
    } else {
      for (const issue of demand.issues) out.add(issue);
    }
  };
  for (const brief of running) {
    const rel = relBriefPath(brief.path, args.projectRoot);
    const planId = typeof brief.plan.id === "string" ? brief.plan.id.trim() : "";
    const named = changed.has(rel) || (planId.length > 0 && branchNamesPlanId(branch, planId));
    if (named) {
      lineFor(brief, storyIssuesOfBrief(brief.plan, args.repo));
    }
  }
  for (const issue of bodyRefs) {
    const target = briefForBodyRef(running, args.repo, issue);
    if (target === "today") {
      out.add(issue);
    } else if (target !== null) {
      lineFor(target, [issue]);
    }
  }
  return {
    issues: [...out].sort((a, b) => a - b),
    blocked: [...blocked.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, m]) => m),
  };
}

/**
 * #6934 Bound item 7: the note for each running story issue N of the branch whose
 * resulting body carries `deft-story-part: N`, on a product-shaped branch only.
 * Written now or already present; the body is never rewritten here.
 */
function partLineNotes(args: {
  readonly projectRoot: string;
  readonly runGit: RunGhFn;
  readonly bodyText: string;
  readonly issues: readonly number[];
}): string[] {
  const parts = new Set(parseAllDeftStoryPartLines(args.bodyText));
  const hits = args.issues.filter((n) => parts.has(n));
  if (hits.length === 0) return [];
  const diff = collectLocalDiffFiles(args.projectRoot, args.runGit);
  if (diff === null || !isProductShapedDiff(diff)) return [];
  return hits.map((n) => formatPartLineNote(n));
}

/** #6934 Bound item 7 note text for one story issue. */
export function formatPartLineNote(issue: number): string {
  const n = String(issue);
  return (
    `\`deft-story-part: ${n}\` on a product PR: this PR does not complete story #${n}; ` +
    `a later PR with \`deft-story: ${n}\` must. If this PR delivers the whole story, ` +
    `replace the line with \`deft-story: ${n}\` (dropping --part does not remove a line ` +
    "already in the body)."
  );
}

function withNotes(message: string, notes: readonly string[]): string {
  return notes.length === 0 ? message : [message, ...notes.map((n) => `NOTE: ${n}`)].join("\n");
}

/**
 * `--body-file <path> --write-story-line [--part]` (#6316 amendment): append
 * `deft-story: N` (or `deft-story-part: N`) for each running story of the branch
 * whose line the body lacks: one line per brief, for its story issue (#6468). A body
 * that already has one of the lines for N is left unchanged; a body with both lines
 * for one N fails as the live check does; a case A / case B brief writes nothing.
 * On a product branch, a resulting body with `deft-story-part: N` for a running
 * story issue adds the part-line note to the OK message (#6934).
 */
export function writeStoryLineToBodyFile(args: {
  readonly bodyFile: string;
  readonly projectRoot: string;
  readonly repo: string | null;
  readonly part: boolean;
  readonly runGit?: RunGhFn;
}): WriteStoryLineResult {
  const runGit = args.runGit ?? defaultRunGit;
  let text: string;
  try {
    text = readFileSync(args.bodyFile, "utf8");
  } catch (err: unknown) {
    return {
      code: 2,
      message: `Error: failed to read ${args.bodyFile}: ${err instanceof Error ? err.message : String(err)}`,
      issues: [],
      written: [],
    };
  }
  const conflicts = findStoryLineConflicts(text);
  if (conflicts.length > 0) {
    return { code: 1, message: formatStoryLineConflict(conflicts), issues: [], written: [] };
  }
  const repo = resolveOfflineRepo(args.projectRoot, args.repo, runGit);
  if (repo === null) {
    return {
      code: 2,
      message:
        "FAIL: --write-story-line needs --repo OWNER/REPO (or a github.com origin remote) to match running briefs.",
      issues: [],
      written: [],
    };
  }
  const { issues, blocked } = storyLinesForBranch({
    projectRoot: args.projectRoot,
    repo,
    bodyText: text,
    runGit,
  });
  if (blocked.length > 0) {
    // #6468 Bound item 5: a brief no line can serve gets no line; nothing is written.
    return { code: 1, message: blocked.join("\n"), issues, written: [] };
  }
  if (issues.length === 0) {
    return {
      code: 0,
      message: "OK: no running story for this branch; body file unchanged (#6316).",
      issues,
      written: [],
    };
  }
  const marks = new Set(parseAllDeftStoryMarks(text));
  const parts = new Set(parseAllDeftStoryPartLines(text));
  const label = args.part ? "deft-story-part" : "deft-story";
  const written = issues
    .filter((n) => !marks.has(n) && !parts.has(n))
    .map((n) => `${label}: ${String(n)}`);
  if (written.length === 0) {
    const notes = partLineNotes({ projectRoot: args.projectRoot, runGit, bodyText: text, issues });
    return {
      code: 0,
      message: withNotes("OK: body file already carries the story line; unchanged (#6316).", notes),
      issues,
      written,
    };
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let next = text;
  if (next.length > 0 && !next.endsWith("\n")) {
    next += eol;
  }
  if (next.trim().length > 0 && !/(?:\r?\n){2}$/.test(next)) {
    next += eol;
  }
  next += written.map((line) => `${line}${eol}`).join("");
  try {
    // Contained write under the operator-named body file's parent (#2951 / #2980 pattern).
    const abs = resolve(args.bodyFile);
    containedWrite({ root: dirname(abs), target: abs, data: next, mode: "replace" });
  } catch (err: unknown) {
    return {
      code: 2,
      message: `Error: failed to write ${args.bodyFile}: ${err instanceof Error ? err.message : String(err)}`,
      issues,
      written: [],
    };
  }
  const notes = partLineNotes({ projectRoot: args.projectRoot, runGit, bodyText: next, issues });
  return {
    code: 0,
    message: withNotes(`OK: wrote ${written.join(", ")} to ${args.bodyFile} (#6316).`, notes),
    issues,
    written,
  };
}

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
    fromGitRange: null,
    repo: null,
    allowKnownFalsePositives: [],
    allowClose: [],
    mode: "both",
    onePrUnit: null,
    projectRoot: null,
    writeStoryLine: false,
    part: false,
    error,
  };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let pr: number | null = null;
  let bodyFile: string | null = null;
  let commitsFile: string | null = null;
  let fromGitRange: string | null = null;
  let repo: string | null = null;
  let mode: ClosingKeywordMode = "both";
  const allowKnownFalsePositives: string[] = [];
  const allowClose: string[] = [];
  let onePrUnit: string | null = null;
  let projectRoot: string | null = null;
  let writeStoryLine = false;
  let part = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write-story-line") {
      writeStoryLine = true;
    } else if (arg === "--part") {
      part = true;
    } else if (arg === "--pr") {
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
    } else if (arg === "--from-git-range") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --from-git-range: expected one argument");
      }
      fromGitRange = value;
      i += 1;
    } else if (arg?.startsWith("--from-git-range=")) {
      fromGitRange = arg.slice("--from-git-range=".length);
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
    } else if (arg === "--one-pr-unit") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --one-pr-unit: expected one argument");
      }
      onePrUnit = value;
      i += 1;
    } else if (arg?.startsWith("--one-pr-unit=")) {
      onePrUnit = arg.slice("--one-pr-unit=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return emptyParsed("argument --project-root: expected one argument");
      }
      projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg?.startsWith("-")) {
      return emptyParsed(`unrecognized arguments: ${arg}`);
    } else {
      return emptyParsed(`unrecognized arguments: ${arg}`);
    }
  }

  return {
    pr,
    bodyFile,
    commitsFile,
    fromGitRange,
    repo,
    allowKnownFalsePositives,
    allowClose,
    mode,
    onePrUnit,
    projectRoot,
    writeStoryLine,
    part,
  };
}

export interface RunOptions {
  readonly runGh?: RunGhFn;
  readonly runGit?: RunGhFn;
  readonly env?: NodeJS.ProcessEnv;
}

function defaultRunGit(cmd: readonly string[]): {
  returncode: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync("git", [...cmd], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      returncode: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}

function readGitRange(range: string, runGit: RunGhFn): string[] | null {
  const result = runGit(["log", range, "--format=%B%n--END--"]);
  if (result.returncode !== 0) {
    process.stderr.write(
      "Error: git log " +
        range +
        " failed: " +
        result.stderr.trim() +
        ". Recovery: git fetch origin master.\n",
    );
    return null;
  }
  return result.stdout
    .split("\n--END--\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
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
      notes.push(`${intentSuppressed} intent hit(s) suppressed by --allow-close`);
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
        "issue DoD is met, then pass --allow-close <N,M> on the lint (body trailers are not an authorization path). " +
        "Conditional prose (Phase A / only if / partial) does NOT prevent GitHub auto-close. " +
        `${storyLineAdvice(null)}\n`,
    );
    for (const h of intentFiltered) {
      process.stderr.write(`${renderHit(h)}\n`);
    }
  }
  return EXIT_HITS_FOUND;
}

function relBriefPath(path: string, projectRoot: string): string {
  try {
    return relative(resolve(projectRoot), resolve(path)).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

function refuseAllowCloseWhileRunning(
  closeAllow: Set<number>,
  projectRoot: string,
  repoArg: string | null,
): number | null {
  if (closeAllow.size === 0) {
    return null;
  }
  const repo = resolveRepo(repoArg, projectRoot);
  if (repo === null || repo.length === 0) {
    process.stderr.write(
      "Error: --allow-close requires OWNER/REPO to match running briefs. " +
        "Pass --repo OWNER/REPO, set DEFT_TRIAGE_REPO, or run inside a checkout with a GitHub origin remote.\n",
    );
    return EXIT_CONFIG_ERROR;
  }
  const briefs = listActiveRunningBriefs(projectRoot);
  const hits: { issue: number; briefPath: string }[] = [];
  for (const issue of [...closeAllow].sort((a, b) => a - b)) {
    for (const brief of briefs) {
      const { issues } = collectGithubRefs(brief.plan, repo);
      const matched = issues.some(
        (ref) => ref.repo.toLowerCase() === repo.toLowerCase() && ref.number === issue,
      );
      if (matched) {
        hits.push({ issue, briefPath: relBriefPath(brief.path, projectRoot) });
        break;
      }
    }
  }
  if (hits.length === 0) {
    return null;
  }
  process.stderr.write(
    "FAIL: --allow-close names issue(s) whose brief is still running in xbrief/active/. " +
      "Use Refs / Tracking until leftover-complete. --allow-close is the #3015 intent-mode allowlist, not leftover-complete consent. " +
      `${storyLineAdvice(hits.length === 1 ? (hits[0]?.issue ?? null) : null)}\n`,
  );
  for (const hit of hits) {
    process.stderr.write(`  --allow-close ${String(hit.issue)} running brief: ${hit.briefPath}\n`);
  }
  return EXIT_HITS_FOUND;
}

const LIVE_PR_REQUIRES_REPO =
  "live PR one-PR-unit check requires repository identity (--repo or GITHUB_REPOSITORY)";

/** Resolve owner/repo from `--repo` then GITHUB_REPOSITORY (empty-as-absent). */
export function resolveLiveRepoSlug(
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const fromArgs = repo?.trim() ?? "";
  if (fromArgs.length > 0) return fromArgs;
  const fromEnv = env.GITHUB_REPOSITORY?.trim() ?? "";
  if (fromEnv.length > 0) return fromEnv;
  return null;
}

function resolveLiveRepo(args: ParsedArgs, env: NodeJS.ProcessEnv): string | null {
  return resolveLiveRepoSlug(args.repo ?? undefined, env);
}

function fetchPrNodeId(pr: number, repo: string, runGh: RunGhFn): string | null {
  const result = runGh(["gh", "api", `repos/${repo}/pulls/${pr}`]);
  if (result.returncode !== 0) {
    process.stderr.write(
      `Error: gh REST failed fetching PR #${pr} node id: ${result.stderr.trim()}\n`,
    );
    return null;
  }
  try {
    const payload: unknown = JSON.parse(result.stdout);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      process.stderr.write(`Error: PR #${pr} REST payload missing node_id\n`);
      return null;
    }
    const node = (payload as { node_id?: unknown }).node_id;
    if (typeof node === "string" && node.trim().length > 0) return node.trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: failed to parse PR #${pr} REST node id: ${message}\n`);
    return null;
  }
  process.stderr.write(`Error: PR #${pr} REST payload missing node_id\n`);
  return null;
}

export function run(argv: readonly string[], options: RunOptions = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`Error: ${args.error}\n`);
    return EXIT_CONFIG_ERROR;
  }
  if (args.part && !args.writeStoryLine) {
    process.stderr.write("Error: --part requires --write-story-line.\n");
    return EXIT_CONFIG_ERROR;
  }
  if (args.writeStoryLine) {
    if (args.pr !== null || args.bodyFile === null) {
      process.stderr.write(
        "Error: --write-story-line is offline only: pass --body-file <path> and no --pr.\n",
      );
      return EXIT_CONFIG_ERROR;
    }
    const written = writeStoryLineToBodyFile({
      bodyFile: args.bodyFile,
      projectRoot: args.projectRoot ?? ".",
      repo: args.repo,
      part: args.part,
      runGit: options.runGit ?? defaultRunGit,
    });
    process.stderr.write(`${written.message}\n`);
    return written.code === 0 ? EXIT_OK : written.code === 1 ? EXIT_HITS_FOUND : EXIT_CONFIG_ERROR;
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

  const runningRefuse = refuseAllowCloseWhileRunning(
    closeAllow,
    args.projectRoot ?? ".",
    args.repo,
  );
  if (runningRefuse !== null) {
    return runningRefuse;
  }

  const runGh = options.runGh ?? defaultRunGh;
  const envBag = options.env ?? process.env;
  let bodyText: string | null = null;
  let commitMessages: string[] = [];

  if (args.pr !== null) {
    const liveRepo = resolveLiveRepo(args, envBag);
    if (liveRepo === null) {
      process.stderr.write(`FAIL: ${LIVE_PR_REQUIRES_REPO}\n`);
      return EXIT_CONFIG_ERROR;
    }
    bodyText = fetchPrBody(args.pr, liveRepo, runGh);
    if (bodyText === null) {
      return EXIT_CONFIG_ERROR;
    }
    const msgs = fetchPrCommitMessages(args.pr, liveRepo, runGh);
    if (msgs === null) {
      return EXIT_CONFIG_ERROR;
    }
    commitMessages = msgs;
  } else {
    if (args.bodyFile === null && args.commitsFile === null && args.fromGitRange === null) {
      process.stderr.write(
        "Error: must specify --pr OR --body-file / --commits-file / --from-git-range.\n",
      );
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
    if (args.fromGitRange !== null) {
      const msgs = readGitRange(args.fromGitRange, options.runGit ?? defaultRunGit);
      if (msgs === null) {
        return EXIT_CONFIG_ERROR;
      }
      commitMessages = [...commitMessages, ...msgs];
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
      // Intent = class D only (bare/conditional real closes). Class A FP-context
      // hits (negation/quote/example/code) stay exclusive to FP mode so operators
      // do not need --allow-close for quoted fixtures (#3015 / SLizard).
      intentHits.push(
        ...findAllClosingKeywordHits(bodyText, "pr-body").filter((h) => h.reason === "intent"),
      );
    }
  }
  for (let idx = 0; idx < commitMessages.length; idx += 1) {
    const msg = commitMessages[idx] ?? "";
    if (runFp) {
      fpHits.push(...findHits(msg, `commit:${idx}`));
    }
    if (runIntent) {
      intentHits.push(
        ...findAllClosingKeywordHits(msg, `commit:${idx}`).filter((h) => h.reason === "intent"),
      );
    }
  }

  // Intent allowlist is CLI --allow-close only (#3015). Body trailers are not
  // an authorization path (Markdown example/fence false-authorization class).
  // Live `--pr` forge reads (branch-gate / merge-gate) cannot carry that
  // allowlist. Skip intent-fail there unless the caller passed --allow-close.
  // FP + one-PR-unit still run. Local --body-file / --from-git-range still
  // require --allow-close for real Closes.
  const fpFiltered = filterHits(fpHits, fpAllow);
  const intentFiltered =
    args.pr !== null && closeAllow.size === 0 ? [] : filterHits(intentHits, closeAllow);

  // #4919 / #4864 / #5736: full-story mark admission on live PR diffs and offline --body-file.
  if (args.pr !== null) {
    const liveRepo = resolveLiveRepo(args, envBag);
    if (liveRepo === null) {
      process.stderr.write(`FAIL: ${LIVE_PR_REQUIRES_REPO}\n`);
      return EXIT_CONFIG_ERROR;
    }
    const files = fetchPrFiles(args.pr, liveRepo, runGh);
    if (files === null) {
      return EXIT_CONFIG_ERROR;
    }
    const prNumber = args.pr;
    let mergeBase: string | null | undefined;
    const readMergeBaseFile: ReadMergeBaseFileFn = (path) => {
      if (mergeBase === undefined) {
        mergeBase = fetchPrMergeBaseSha(prNumber, liveRepo, runGh);
      }
      if (mergeBase === null) {
        return { kind: "error", detail: `cannot resolve PR #${String(prNumber)} merge base` };
      }
      return fetchRepoFileAtRef(liveRepo, path, mergeBase, runGh);
    };
    const admission = evaluateFullStoryMarkAdmission({
      bodyText,
      prNumber,
      projectRoot: args.projectRoot ?? ".",
      repo: liveRepo,
      files,
      readMergeBaseFile,
    });
    // #6316: pre-merge story-line check for a product PR of a running story.
    const storyLine = evaluateStoryLineRequirement({
      bodyText: bodyText ?? "",
      prNumber,
      projectRoot: args.projectRoot ?? ".",
      repo: liveRepo,
      files,
    });
    if (!admission.ok || !storyLine.ok) {
      const admissionMessages = admission.ok ? [] : admission.messages;
      for (const message of [...admissionMessages, ...storyLine.messages]) {
        process.stderr.write(`${message}\n`);
      }
      return EXIT_HITS_FOUND;
    }
  } else if (args.bodyFile !== null) {
    const conflicts = findStoryLineConflicts(bodyText ?? "");
    if (conflicts.length > 0) {
      process.stderr.write(`${formatStoryLineConflict(conflicts)}\n`);
      return EXIT_HITS_FOUND;
    }
    const projectRoot = args.projectRoot ?? ".";
    const files = collectLocalDiffFiles(projectRoot, options.runGit ?? defaultRunGit);
    if (files !== null) {
      // Prefer explicit --repo; else origin remote owner/name; never invent "local"
      // (Path B URL identity compares against the forge repo string).
      let offlineRepo = args.repo;
      if (offlineRepo === null || offlineRepo.trim().length === 0) {
        const origin = (options.runGit ?? defaultRunGit)([
          "-C",
          projectRoot,
          "remote",
          "get-url",
          "origin",
        ]);
        const m = origin.stdout.match(/github\.com[:/]([^/]+\/[^/.]+)/i);
        offlineRepo = m?.[1]?.replace(/\.git$/i, "") ?? null;
      }
      if (offlineRepo === null || offlineRepo.trim().length === 0) {
        process.stderr.write(
          "FAIL: offline --body-file story admission needs --repo OWNER/REPO (or a github.com origin remote).\n",
        );
        return EXIT_CONFIG_ERROR;
      }
      const admission = evaluateFullStoryMarkAdmission({
        bodyText,
        prNumber: null,
        projectRoot,
        repo: offlineRepo.trim(),
        files,
      });
      if (!admission.ok) {
        for (const message of admission.messages) {
          process.stderr.write(`${message}\n`);
        }
        return EXIT_HITS_FOUND;
      }
    }
  }

  // FP-only is false-positive detection, not the closer-set gate. Negated
  // "not Closes #N" must not mint a multi-origin unit. Intent/both run the gate.
  if (runIntent) {
    const texts: string[] = [];
    if (bodyText !== null) {
      texts.push(bodyText);
    }
    texts.push(...commitMessages);
    const env = envBag;
    if (args.pr !== null) {
      const repo = resolveLiveRepo(args, env);
      if (repo === null) {
        process.stderr.write(`FAIL: ${LIVE_PR_REQUIRES_REPO}\n`);
        return EXIT_CONFIG_ERROR;
      }
      const closerSet = extractIntentCloserSet(texts, repo);
      if (closerSet.length <= 1) {
        const unit = evaluateOnePrUnit({
          closerSet,
          grant: null,
          binding: { repo },
          phase: "enforce",
        });
        if (!unit.ok) {
          process.stderr.write(`FAIL: ${unit.message}\n`);
          return EXIT_HITS_FOUND;
        }
      } else {
        const resolved = resolveProductionAppStore(env);
        if (!resolved.ok) {
          process.stderr.write(`FAIL: ${resolved.message}\n`);
          return EXIT_CONFIG_ERROR;
        }
        const prNodeId = fetchPrNodeId(args.pr, repo, runGh);
        if (prNodeId === null) {
          return EXIT_CONFIG_ERROR;
        }
        // Find via membershipOf/listActive; exact-set match; phase declare only when code === "allow-granted" (not declare.ok); then bind, resolveClaimFromStore({ prNodeId }), enforce with { repo, prNodeId }.
        const unit = enforceLiveOnePrUnitCheck({
          store: resolved.store,
          closerSet,
          repo,
          prNodeId,
        });
        if (!unit.ok) {
          process.stderr.write(`FAIL: ${unit.message}\n`);
          if (!unit.message.includes("missing one-PR-unit consent") && closerSet.length > 1) {
            process.stderr.write(`${MISSING_ONE_PR_UNIT_CONSENT}\n`);
          }
          return EXIT_HITS_FOUND;
        }
      }
    } else {
      const grant =
        args.onePrUnit === null
          ? null
          : loadOnePrUnitGrant(args.projectRoot ?? ".", args.onePrUnit);
      const repo = args.repo ?? grant?.repo ?? "unknown/unknown";
      const closerSet = extractIntentCloserSet(texts, repo);
      const unit = evaluateOnePrUnit({
        closerSet,
        grant,
        binding: { repo: args.repo ?? grant?.repo },
        presentedIdWithoutStore: args.onePrUnit !== null && grant === null,
        phase: "declare",
      });
      if (!unit.ok) {
        process.stderr.write(`FAIL: ${unit.message}\n`);
        if (!unit.message.includes("missing one-PR-unit consent") && closerSet.length > 1) {
          process.stderr.write(`${MISSING_ONE_PR_UNIT_CONSENT}\n`);
        }
        return EXIT_HITS_FOUND;
      }
    }
  }
  return emitResult(
    args.mode,
    fpFiltered,
    intentFiltered,
    fpHits.length - fpFiltered.length,
    intentHits.length - intentFiltered.length,
  );
}

export function cmdPrCheckClosingKeywords(
  argv: readonly string[],
  options: RunOptions = {},
): number {
  return run(argv, options);
}
