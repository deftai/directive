import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import { hasArtifactSuffix } from "../layout/resolve.js";
import { CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE } from "../triage/queue/constants.js";
import { parseGithubIssueUri } from "../triage/reconcile/parse-uri.js";
import { collectPlanRefs, resolveVbriefRef } from "./vbrief-ref.js";

const OPEN_FOLDERS = ["proposed", "pending", "active"] as const;
const TRACKER_LABELS = new Set(["epic", "meta", "tracker", "type:tracker", "status:tracker"]);

export interface OpenUmbrellaReference {
  readonly repo: string | null;
  readonly issueNumber: number | null;
  readonly title: string;
  readonly path: string | null;
  readonly sources: readonly string[];
}

interface IssueRef {
  readonly repo: string | null;
  readonly number: number;
}

interface CachedIssue {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly subIssuesTotal: number;
}

interface MutableReference {
  repo: string | null;
  issueNumber: number | null;
  title: string;
  path: string | null;
  sources: Set<string>;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function planOf(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const plan = data?.plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

function issueRefsFromPlan(plan: Record<string, unknown> | null): IssueRef[] {
  const refs = plan?.references;
  if (!Array.isArray(refs)) {
    return [];
  }
  const out: IssueRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const typed = ref as Record<string, unknown>;
    if (!referenceTypeMatches(String(typed.type ?? ""), "github-issue")) {
      continue;
    }
    const [repo, number] = parseGithubIssueUri(typed.uri);
    if (number === null) {
      continue;
    }
    const key = repo === null ? `bare:${number}` : `${repo}:${number}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ repo, number });
  }
  return out;
}

function labelsFromRaw(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const label of raw) {
    if (typeof label === "string") {
      out.push(label);
    } else if (typeof label === "object" && label !== null && !Array.isArray(label)) {
      const name = (label as Record<string, unknown>).name;
      if (typeof name === "string") {
        out.push(name);
      }
    }
  }
  return out;
}

function subIssueTotal(raw: unknown): number {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return 0;
  }
  const total = (raw as Record<string, unknown>).total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function readTextIfPresent(path: string): string {
  if (!existsSync(path)) {
    return "";
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readCachedIssue(projectRoot: string, repo: string, number: number): CachedIssue | null {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    return null;
  }
  const issueDir = join(
    projectRoot,
    CACHE_DIR_NAME,
    CACHE_SOURCE_GITHUB_ISSUE,
    owner,
    name,
    String(number),
  );
  const rawPath = join(issueDir, "raw.json");
  const raw = readJson(rawPath);
  if (raw === null) {
    return null;
  }
  const body = typeof raw.body === "string" ? raw.body : "";
  const content = readTextIfPresent(join(issueDir, "content.md"));
  return {
    repo,
    number: typeof raw.number === "number" && Number.isFinite(raw.number) ? raw.number : number,
    title: typeof raw.title === "string" ? raw.title : `#${number}`,
    state: typeof raw.state === "string" ? raw.state.toLowerCase() : "open",
    body: content.length > 0 ? `${body}\n${content}` : body,
    labels: labelsFromRaw(raw.labels).map((label) => label.toLowerCase()),
    subIssuesTotal: subIssueTotal(raw.sub_issues_summary),
  };
}

function cachedState(projectRoot: string, ref: IssueRef): "open" | "closed" | null {
  if (ref.repo === null) {
    return null;
  }
  const cached = readCachedIssue(projectRoot, ref.repo, ref.number);
  if (cached === null) {
    return null;
  }
  return cached.state === "closed" ? "closed" : "open";
}

function chooseOpenIssueRef(projectRoot: string, refs: readonly IssueRef[]): IssueRef | null {
  if (refs.length === 0) {
    return null;
  }
  let firstUnknown: IssueRef | null = null;
  for (const ref of refs) {
    const state = cachedState(projectRoot, ref);
    if (state === "open") {
      return ref;
    }
    if (state === null && firstUnknown === null) {
      firstUnknown = ref;
    }
  }
  return firstUnknown;
}

function refUriMatchesPath(
  uri: unknown,
  targetPaths: ReadonlySet<string>,
  vbriefRoot: string,
): boolean {
  if (typeof uri !== "string" || uri.length === 0) {
    return false;
  }
  const resolved = resolveVbriefRef(uri, vbriefRoot);
  if (resolved === null) {
    return false;
  }
  return targetPaths.has(resolve(resolved));
}

function planReferenceMatchesTarget(
  ref: unknown,
  targetPaths: ReadonlySet<string>,
  vbriefRoot: string,
): boolean {
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
    return false;
  }
  const typed = ref as Record<string, unknown>;
  if (!referenceTypeMatches(String(typed.type ?? ""), "plan")) {
    return false;
  }
  return refUriMatchesPath(typed.uri, targetPaths, vbriefRoot);
}

function planReferencesTarget(
  plan: Record<string, unknown>,
  targetPaths: ReadonlySet<string>,
  vbriefRoot: string,
): boolean {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return false;
  }
  return refs.some((ref) => planReferenceMatchesTarget(ref, targetPaths, vbriefRoot));
}

function planRefsTarget(
  plan: Record<string, unknown>,
  targetPaths: ReadonlySet<string>,
  vbriefRoot: string,
): boolean {
  return collectPlanRefs(plan).some((uri) => refUriMatchesPath(uri, targetPaths, vbriefRoot));
}

function relToRoot(path: string, root: string): string {
  return relative(resolve(root), resolve(path)).replace(/\\/g, "/");
}

function addReference(
  out: Map<string, MutableReference>,
  ref: {
    readonly repo: string | null;
    readonly issueNumber: number | null;
    readonly title: string;
    readonly path: string | null;
    readonly source: string;
  },
): void {
  const key =
    ref.repo !== null && ref.issueNumber !== null
      ? `${ref.repo}#${ref.issueNumber}`
      : (ref.path ?? ref.title);
  const existing = out.get(key);
  if (existing !== undefined) {
    existing.sources.add(ref.source);
    if (existing.title.startsWith("#") && !ref.title.startsWith("#")) {
      existing.title = ref.title;
    }
    return;
  }
  out.set(key, {
    repo: ref.repo,
    issueNumber: ref.issueNumber,
    title: ref.title,
    path: ref.path,
    sources: new Set([ref.source]),
  });
}

function titleForLocalCandidate(
  plan: Record<string, unknown>,
  issueRef: IssueRef | null,
  projectRoot: string,
): string {
  if (issueRef?.repo !== null && issueRef?.repo !== undefined) {
    const cached = readCachedIssue(projectRoot, issueRef.repo, issueRef.number);
    if (cached !== null) {
      return cached.title;
    }
  }
  return typeof plan.title === "string" && plan.title.length > 0
    ? plan.title
    : issueRef !== null
      ? `#${issueRef.number}`
      : "open scope";
}

function findLocalReferences(
  projectRoot: string,
  completedScopePath: string,
  completedPlan: Record<string, unknown>,
  out: Map<string, MutableReference>,
): void {
  const vbriefRoot = dirname(dirname(resolve(completedScopePath)));
  const targetScopePaths = new Set(
    [
      completedScopePath,
      ...OPEN_FOLDERS.map((folder) => join(vbriefRoot, folder, basename(completedScopePath))),
    ].map((path) => resolve(path)),
  );
  const targetParentPaths = collectPlanRefs(completedPlan)
    .map((uri) => resolveVbriefRef(uri, vbriefRoot))
    .filter((path): path is string => path !== null)
    .map((path) => resolve(path));

  for (const folder of OPEN_FOLDERS) {
    const folderPath = join(vbriefRoot, folder);
    if (!existsSync(folderPath)) {
      continue;
    }
    for (const name of readdirSync(folderPath)
      .filter((entry) => hasArtifactSuffix(entry))
      .sort()) {
      const path = join(folderPath, name);
      const plan = planOf(readJson(path));
      if (plan === null) {
        continue;
      }
      const sources: string[] = [];
      if (planReferencesTarget(plan, targetScopePaths, vbriefRoot)) {
        sources.push("plan.references");
      }
      if (planRefsTarget(plan, targetScopePaths, vbriefRoot)) {
        sources.push("planRef");
      }
      if (targetParentPaths.includes(resolve(path))) {
        sources.push("completed planRef");
      }
      if (sources.length === 0) {
        continue;
      }
      const issueRefs = issueRefsFromPlan(plan);
      const issueRef = chooseOpenIssueRef(projectRoot, issueRefs);
      if (issueRefs.length > 0 && issueRef === null) {
        continue;
      }
      const relPath = relToRoot(path, projectRoot);
      for (const source of sources) {
        addReference(out, {
          repo: issueRef?.repo ?? null,
          issueNumber: issueRef?.number ?? null,
          title: titleForLocalCandidate(plan, issueRef, projectRoot),
          path: relPath,
          source,
        });
      }
    }
  }
}

function cachedRepoDirs(projectRoot: string): string[] {
  const base = join(projectRoot, CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE);
  if (!existsSync(base)) {
    return [];
  }
  const repos: string[] = [];
  for (const ownerEntry of readdirSync(base, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!ownerEntry.isDirectory()) {
      continue;
    }
    const owner = ownerEntry.name;
    const ownerPath = join(base, owner);
    for (const repoEntry of readdirSync(ownerPath, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!repoEntry.isDirectory()) {
        continue;
      }
      const name = repoEntry.name;
      repos.push(`${owner}/${name}`);
    }
  }
  return repos;
}

function issueNumberToken(issueNumber: number): string | null {
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? String(issueNumber) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMentionsIssue(text: string, ref: IssueRef, cachedRepo: string): boolean {
  const token = issueNumberToken(ref.number);
  if (token === null) {
    return false;
  }
  const hash = new RegExp(`(^|[^A-Za-z0-9_#])#${token}(?!\\d)`);
  if (ref.repo === cachedRepo && hash.test(text)) {
    return true;
  }
  if (ref.repo === null) {
    return false;
  }
  const repo = escapeRegExp(ref.repo);
  const qualifiedUrl = new RegExp(
    `(?:github\\.com|api\\.github\\.com/repos)/${repo}/issues/${token}(?:\\D|$)`,
  );
  return qualifiedUrl.test(text);
}

function looksLikeTracker(issue: CachedIssue): boolean {
  if (issue.subIssuesTotal > 0) {
    return true;
  }
  if (issue.labels.some((label) => TRACKER_LABELS.has(label) || label.includes("umbrella"))) {
    return true;
  }
  return /\b(epic|omnibus|tracker|umbrella)\b/i.test(issue.title);
}

function findCachedIssueBodyReferences(
  projectRoot: string,
  targetIssueRefs: readonly IssueRef[],
  out: Map<string, MutableReference>,
): void {
  const targetNumbers = new Set(targetIssueRefs.map((ref) => ref.number));
  if (targetNumbers.size === 0) {
    return;
  }
  if (!targetIssueRefs.some((ref) => ref.repo !== null)) {
    return;
  }
  for (const repo of cachedRepoDirs(projectRoot)) {
    const [owner, name] = repo.split("/", 2);
    if (!owner || !name) {
      continue;
    }
    const repoDir = join(projectRoot, CACHE_DIR_NAME, CACHE_SOURCE_GITHUB_ISSUE, owner, name);
    for (const entry of readdirSync(repoDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
        continue;
      }
      const issueNumber = Number(entry.name);
      if (targetNumbers.has(issueNumber)) {
        continue;
      }
      const issue = readCachedIssue(projectRoot, repo, issueNumber);
      if (issue === null || issue.state !== "open" || !looksLikeTracker(issue)) {
        continue;
      }
      const haystack = `${issue.title}\n${issue.body}`;
      if (!targetIssueRefs.some((ref) => textMentionsIssue(haystack, ref, repo))) {
        continue;
      }
      addReference(out, {
        repo,
        issueNumber: issue.number,
        title: issue.title,
        path: null,
        source: "cached issue body",
      });
    }
  }
}

/** Find open umbrella/tracker surfaces that still mention a just-completed scope. */
export function findOpenUmbrellaReferences(
  projectRoot: string,
  completedScopePath: string,
): OpenUmbrellaReference[] {
  const data = readJson(completedScopePath);
  const completedPlan = planOf(data);
  if (completedPlan === null) {
    return [];
  }

  const out = new Map<string, MutableReference>();
  findLocalReferences(projectRoot, completedScopePath, completedPlan, out);
  findCachedIssueBodyReferences(projectRoot, issueRefsFromPlan(completedPlan), out);

  return [...out.values()]
    .map((ref) => ({
      repo: ref.repo,
      issueNumber: ref.issueNumber,
      title: ref.title,
      path: ref.path,
      sources: [...ref.sources].sort(),
    }))
    .sort((a, b) => {
      const aKey =
        a.issueNumber !== null
          ? a.repo === null
            ? `bare:#${a.issueNumber}`
            : `${a.repo}#${a.issueNumber}`
          : (a.path ?? "");
      const bKey =
        b.issueNumber !== null
          ? b.repo === null
            ? `bare:#${b.issueNumber}`
            : `${b.repo}#${b.issueNumber}`
          : (b.path ?? "");
      return aKey.localeCompare(bKey);
    });
}

function displayReference(ref: OpenUmbrellaReference): string {
  const issue =
    ref.issueNumber !== null ? `#${ref.issueNumber}${ref.repo ? ` (${ref.repo})` : ""}` : null;
  const path = ref.path !== null ? ref.path : null;
  const name = issue ?? path ?? ref.title;
  return `${name}: ${ref.title}`;
}

export function renderOpenUmbrellaWarning(refs: readonly OpenUmbrellaReference[]): string {
  if (refs.length === 0) {
    return "";
  }
  const names = refs.map(displayReference).join("; ");
  return (
    `Warning: scope:complete found open umbrella/tracker reference(s) to the completed scope: ${names}. ` +
    "Run `task vbrief:reconcile:umbrellas` to refresh current-shape comments."
  );
}

export function completedPathForScopeMove(filePath: string): string {
  const resolved = resolve(filePath);
  return join(dirname(dirname(resolved)), "completed", basename(resolved));
}
