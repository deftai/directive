import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import {
  ENV_EXPECTED_GITHUB_LOGIN,
  type ExpectedGithubWorkerPrincipal,
  FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE,
  FAILURE_MISSING_INJECTED_TOKEN,
  findInjectedToken,
  type GhRunner,
  GITHUB_AUTH_MODE_HOST_GH,
  GITHUB_AUTH_MODE_INJECTED_TOKEN,
  inferGithubAuthMode,
  validateGithubAuthForWorker,
} from "../intake/github-auth-modes.js";
import { getPlatformCapabilities } from "../intake/platform-capabilities.js";
import {
  hasArtifactSuffix,
  resolveLifecycleFolder,
  stripArtifactSuffix,
} from "../layout/resolve.js";
import { evaluate as preflightEvaluate } from "../preflight/evaluate.js";
import { applyWorktreeOccupancy, releaseOccupancy } from "../session/occupancy.js";
import { issueNumbersFromPlan, scopeMetadataRank } from "../triage/queue/scope-walk.js";
import { selectionOrderingKey } from "../triage/queue/selection.js";
import {
  DEFAULT_BASE_BRANCH,
  EXIT_CONFIG_ERROR,
  EXIT_GATE_FAILED,
  EXIT_OK,
  GATE_ADVISE,
  GATE_ENFORCE,
  LEAF_CODING_WORKER_ROLE,
} from "./constants.js";
import { readinessReport } from "./readiness.js";
import {
  loadRoutingFile,
  resolveDispatchProvider,
  resolveModelRoute,
  resolveRoutingPath,
} from "./routing.js";
import { dispatchProviderFor, enforceSubagentBackendPolicy } from "./subagent-backend.js";
import { resolveWorktreeMap, type WorktreeRecord } from "./worktrees.js";

export interface ResolvedStory {
  token: string;
  story_id: string;
  path: string;
  relpath: string;
}

export type PreflightGateFn = (vbriefPath: string) => { exitCode: number; message: string };
export type ReadinessGateFn = (
  vbriefPath: string,
  projectRoot: string,
) => { exitCode: number; report: string };
export type WorktreeResolverFn = (
  mapping: readonly Record<string, unknown>[],
  baseBranch: string,
  createMissing?: boolean,
  options?: { repoRoot?: string },
) => WorktreeRecord[];
export type RuntimeAuthProbeFn = () => [string, string];

export const defaultPreflightGate: PreflightGateFn = (vbriefPath) => {
  const result = preflightEvaluate(vbriefPath);
  return { exitCode: result.exitCode, message: result.message };
};

export const defaultReadinessGate: ReadinessGateFn = (vbriefPath, projectRoot) => {
  const { exitCode, report } = readinessReport(projectRoot, [vbriefPath]);
  return { exitCode, report };
};

export const defaultRuntimeAuthProbe: RuntimeAuthProbeFn = () => {
  const report = getPlatformCapabilities();
  return [report.runtimeMode, inferGithubAuthMode(report)];
};

export type WorkerCredentialDispatchPath = "grok-build" | "local-hybrid";

const CREDENTIAL_VALUE_PATTERN = /^(ghp_|gho_|ghu_|ghs_|github_pat_)/i;

const INJECTION_MISSING_CREDENTIAL = "GH_TOKEN (or GITHUB_TOKEN / GH_ENTERPRISE_TOKEN)";

const INJECTION_DISPATCHER_REMEDY =
  "Dispatcher-side remedy: load an approved user-bearing worker credential into the dispatcher environment, then call prepareWorkerCredentialInjection before spawn. Do not fall back to the host gh token or continue under the maintainer identity. Installation credentials are not injectable; see #3693.";

const HELD_WORKER_TOKEN_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

function looksLikeCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERN.test(value.trim());
}

function assertNoCredentialValue(value: string, label: string): void {
  if (looksLikeCredentialValue(value)) {
    throw new Error(`${label} must not contain a credential value`);
  }
}

function sanitizeEnvelopeField(value: string, label: string): string {
  const cleaned = value.replace(/\r?\n/g, " ").trim();
  assertNoCredentialValue(cleaned, label);
  return cleaned;
}

/**
 * Bind validation to the selected token. Stamp it into every gh token slot and
 * drop GH_CONFIG_DIR so a host/enterprise config cannot authenticate as someone
 * else. GH_HOST stays: it selects the API host, not the secret.
 */
function isolateHeldWorkerToken(environ: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = { ...environ };
  for (const name of HELD_WORKER_TOKEN_VARS) {
    isolated[name] = token;
  }
  delete isolated.GH_CONFIG_DIR;
  return isolated;
}

function boundWorkerSpawnEnv(
  token: string,
  expectedLogin: string,
): {
  GH_TOKEN: string;
  GITHUB_TOKEN: string;
  GH_ENTERPRISE_TOKEN: string;
  DEFT_EXPECTED_GITHUB_LOGIN: string;
} {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_ENTERPRISE_TOKEN: token,
    [ENV_EXPECTED_GITHUB_LOGIN]: expectedLogin,
  };
}

/**
 * Dispatch-envelope half of the runtime / GitHub auth-mode contract (#1557 / #1351).
 * Policy labels only — never a token value.
 */
export function formatDispatchAuthEnvelope(fields: {
  runtimeMode: string;
  githubAuthMode: string;
  expectedGithubLogin?: string | null;
}): string {
  const runtimeMode = sanitizeEnvelopeField(fields.runtimeMode, "runtime_mode");
  const githubAuthMode = sanitizeEnvelopeField(fields.githubAuthMode, "github_auth_mode");
  const lines = [
    "## Runtime and GitHub auth mode",
    "",
    `- runtime_mode: ${runtimeMode}`,
    `- github_auth_mode: ${githubAuthMode}`,
  ];
  if (fields.expectedGithubLogin !== undefined && fields.expectedGithubLogin !== null) {
    const login = sanitizeEnvelopeField(fields.expectedGithubLogin, "expected_github_login");
    if (login.length > 0) {
      lines.push(`- expected_github_login: ${login}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface WorkerCredentialInjectionRequest {
  environ?: NodeJS.ProcessEnv;
  githubAuthMode: string;
  runtimeMode?: string | null;
  dispatchPath?: WorkerCredentialDispatchPath;
  expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
  repo?: string;
  runGh?: GhRunner;
  cwd?: string;
}

export type WorkerCredentialInjectionResult =
  | {
      ok: true;
      injected: true;
      githubAuthMode: typeof GITHUB_AUTH_MODE_INJECTED_TOKEN;
      runtimeMode: string | null;
      expectedLogin: string;
      spawnEnv: {
        GH_TOKEN: string;
        GITHUB_TOKEN: string;
        GH_ENTERPRISE_TOKEN: string;
        DEFT_EXPECTED_GITHUB_LOGIN: string;
      };
      envelopeSection: string;
    }
  | {
      ok: true;
      injected: false;
      githubAuthMode: typeof GITHUB_AUTH_MODE_HOST_GH;
      runtimeMode: string | null;
      expectedLogin: string | null;
      spawnEnv: Record<string, never>;
      envelopeSection: string;
    }
  | {
      ok: false;
      blocked: true;
      githubAuthMode: string;
      runtimeMode: string | null;
      missingCredential: string;
      remedy: string;
      detail: string;
      failureKind: string | null;
      envelopeSection: string;
    };

function blockedInjection(fields: {
  githubAuthMode: string;
  runtimeMode: string | null;
  failureKind: string | null;
  detail: string;
  missingCredential?: string;
}): WorkerCredentialInjectionResult {
  const detail = fields.detail.startsWith("BLOCKED") ? fields.detail : `BLOCKED: ${fields.detail}`;
  return {
    ok: false,
    blocked: true,
    githubAuthMode: fields.githubAuthMode,
    runtimeMode: fields.runtimeMode,
    missingCredential: fields.missingCredential ?? INJECTION_MISSING_CREDENTIAL,
    remedy: INJECTION_DISPATCHER_REMEDY,
    detail,
    failureKind: fields.failureKind,
    envelopeSection: formatDispatchAuthEnvelope({
      runtimeMode: fields.runtimeMode ?? "unknown",
      githubAuthMode: fields.githubAuthMode,
    }),
  };
}

/**
 * Validate a held user-bearing worker credential and prepare spawn-time injection (#1351).
 *
 * Comparison is opt-in on the validator. This path always stamps
 * `DEFT_EXPECTED_GITHUB_LOGIN` after a successful user-principal check so the
 * worker envelope does not inherit "any user token is approved."
 *
 * Installation credentials fail closed via the existing validator (#3693).
 * Token values belong only in the returned `spawnEnv` — never in prompts,
 * transcripts, or manifest entries.
 */
export function prepareWorkerCredentialInjection(
  request: WorkerCredentialInjectionRequest,
): WorkerCredentialInjectionResult {
  const environ = request.environ ?? process.env;
  const runtimeMode = request.runtimeMode ?? null;
  const token = findInjectedToken(environ);
  const grokBuild = request.dispatchPath === "grok-build";
  const effectiveMode =
    grokBuild || token !== null ? GITHUB_AUTH_MODE_INJECTED_TOKEN : request.githubAuthMode;

  if (effectiveMode === GITHUB_AUTH_MODE_HOST_GH && token === null) {
    return {
      ok: true,
      injected: false,
      githubAuthMode: GITHUB_AUTH_MODE_HOST_GH,
      runtimeMode,
      expectedLogin: null,
      spawnEnv: {},
      envelopeSection: formatDispatchAuthEnvelope({
        runtimeMode: runtimeMode ?? "local-unsandboxed",
        githubAuthMode: GITHUB_AUTH_MODE_HOST_GH,
      }),
    };
  }

  if (token === null) {
    return blockedInjection({
      githubAuthMode: GITHUB_AUTH_MODE_INJECTED_TOKEN,
      runtimeMode,
      failureKind: FAILURE_MISSING_INJECTED_TOKEN,
      missingCredential: INJECTION_MISSING_CREDENTIAL,
      detail:
        "missing worker credential GH_TOKEN (or GITHUB_TOKEN / GH_ENTERPRISE_TOKEN) for a write-requiring injected-token dispatch",
    });
  }

  const isolatedEnviron = isolateHeldWorkerToken(environ, token);
  const validated = validateGithubAuthForWorker(GITHUB_AUTH_MODE_INJECTED_TOKEN, {
    environ: isolatedEnviron,
    runtimeReport: { runtimeMode: runtimeMode ?? "cloud-headless" },
    repo: request.repo,
    runGh: request.runGh,
    expectedPrincipal: request.expectedPrincipal,
    cwd: request.cwd,
  });

  if (!validated.ok || validated.login === null || validated.login.trim().length === 0) {
    const installation = validated.failureKind === FAILURE_INSTALLATION_IDENTITY_UNVERIFIABLE;
    return blockedInjection({
      githubAuthMode: GITHUB_AUTH_MODE_INJECTED_TOKEN,
      runtimeMode,
      failureKind: validated.failureKind,
      detail: installation
        ? `${validated.detail} Installation credentials are not injectable (#3693).`
        : validated.detail,
    });
  }

  const expectedLogin = validated.login.trim();
  assertNoCredentialValue(expectedLogin, "expected_github_login");
  const spawnEnv = boundWorkerSpawnEnv(token, expectedLogin);
  return {
    ok: true,
    injected: true,
    githubAuthMode: GITHUB_AUTH_MODE_INJECTED_TOKEN,
    runtimeMode,
    expectedLogin,
    spawnEnv,
    envelopeSection: formatDispatchAuthEnvelope({
      runtimeMode: runtimeMode ?? "cloud-headless",
      githubAuthMode: GITHUB_AUTH_MODE_INJECTED_TOKEN,
      expectedGithubLogin: expectedLogin,
    }),
  };
}

function loadJson(path: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function planOf(data: Record<string, unknown>): Record<string, unknown> {
  const plan = data.plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : {};
}

function storyId(path: string, plan: Record<string, unknown>): string {
  const value = plan.id;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  const name = basename(path);
  return hasArtifactSuffix(name) ? stripArtifactSuffix(name) : name.replace(/\.[^.]+$/, "");
}

function extractHashNumbers(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charAt(i) !== "#") {
      continue;
    }
    let j = i + 1;
    const digits: string[] = [];
    while (j < text.length) {
      const ch = text.charAt(j);
      if (ch >= "0" && ch <= "9") {
        digits.push(ch);
        j += 1;
      } else {
        break;
      }
    }
    if (digits.length > 0) {
      out.push(Number.parseInt(digits.join(""), 10));
    }
  }
  return out;
}

function issueNumbers(plan: Record<string, unknown>): Set<number> {
  const out = new Set<number>();
  const refs = plan.references;
  if (Array.isArray(refs)) {
    for (const ref of refs) {
      if (typeof ref === "object" && ref !== null && !Array.isArray(ref)) {
        const uri = (ref as Record<string, unknown>).uri;
        if (typeof uri === "string") {
          for (const n of issueNumbersFromPlan({
            references: [{ uri, type: "x-vbrief/github-issue" }],
          })) {
            out.add(n);
          }
        }
      }
    }
  }
  const narratives = plan.narratives;
  if (typeof narratives === "object" && narratives !== null && !Array.isArray(narratives)) {
    const traces = (narratives as Record<string, unknown>).Traces;
    if (typeof traces === "string") {
      for (const n of extractHashNumbers(traces)) {
        out.add(n);
      }
    }
  }
  const items = plan.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const narrative = (item as Record<string, unknown>).narrative;
        if (typeof narrative === "object" && narrative !== null && !Array.isArray(narrative)) {
          const traces = (narrative as Record<string, unknown>).Traces;
          if (typeof traces === "string") {
            for (const n of extractHashNumbers(traces)) {
              out.add(n);
            }
          }
        }
      }
    }
  }
  return out;
}

interface ActiveStory {
  path: string;
  story_id: string;
  issues: Set<number>;
}

function projectRel(projectRoot: string, path: string): string {
  try {
    return resolve(path)
      .slice(resolve(projectRoot).length + 1)
      .replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

function indexStoriesInFolder(projectRoot: string, folder: string): ActiveStory[] {
  const dir = resolveLifecycleFolder(projectRoot, folder);
  const index: ActiveStory[] = [];
  if (!existsSync(dir)) {
    return index;
  }
  for (const name of readdirSync(dir).sort()) {
    if (!hasArtifactSuffix(name)) {
      continue;
    }
    const path = join(dir, name);
    const data = loadJson(path);
    if (data === null) {
      continue;
    }
    const plan = planOf(data);
    index.push({ path, story_id: storyId(path, plan), issues: issueNumbers(plan) });
  }
  return index;
}

function indexActiveStories(projectRoot: string): ActiveStory[] {
  return indexStoriesInFolder(projectRoot, "active");
}

/**
 * True when a brief in `xbrief/completed/` (or the legacy `vbrief/completed/`)
 * references the given issue number in its `references[]` / `Traces`. Used by
 * finalize-cohort (#2247) to classify an incidental closing ref to an
 * already-completed issue as a benign skip rather than a hard error.
 */
export function completedBriefReferencesIssue(projectRoot: string, issue: number): boolean {
  return indexStoriesInFolder(projectRoot, "completed").some((s) => s.issues.has(issue));
}

export function looksLikePath(token: string): boolean {
  return (
    token.endsWith(".json") ||
    token.includes("/") ||
    token.includes("\\") ||
    (existsSync(token) && hasArtifactSuffix(basename(token)))
  );
}

function resolveOne(
  token: string,
  projectRoot: string,
  idMap: Map<string, ActiveStory[]>,
  issueMap: Map<number, ActiveStory[]>,
): { story: ResolvedStory | null; error: string | null } {
  if (looksLikePath(token)) {
    const candidate = isAbsolute(token) ? token : join(projectRoot, token);
    if (!existsSync(candidate)) {
      return {
        story: null,
        error: `${JSON.stringify(token)}: vBRIEF path not found (${candidate}).`,
      };
    }
    const data = loadJson(candidate);
    if (data === null) {
      return {
        story: null,
        error: `${JSON.stringify(token)}: vBRIEF is unreadable or not valid JSON.`,
      };
    }
    const sid = storyId(candidate, planOf(data));
    return {
      story: {
        token,
        story_id: sid,
        path: candidate,
        relpath: projectRel(projectRoot, candidate),
      },
      error: null,
    };
  }

  if (/^\d+$/.test(token)) {
    const num = Number.parseInt(token, 10);
    const matches = issueMap.get(num) ?? [];
    if (matches.length === 1) {
      const match = matches[0];
      if (match === undefined) {
        return { story: null, error: `${JSON.stringify(token)}: could not resolve.` };
      }
      return {
        story: {
          token,
          story_id: match.story_id,
          path: match.path,
          relpath: projectRel(projectRoot, match.path),
        },
        error: null,
      };
    }
    if (matches.length === 0) {
      return { story: null, error: `#${token}: no active story references this issue.` };
    }
    const ids = matches
      .map((m) => m.story_id)
      .sort()
      .join(", ");
    return {
      story: null,
      error: `#${token}: ambiguous -- ${matches.length} active stories match (${ids}).`,
    };
  }

  const idMatches = idMap.get(token) ?? [];
  if (idMatches.length === 1) {
    const match = idMatches[0];
    if (match === undefined) {
      return { story: null, error: `${JSON.stringify(token)}: could not resolve.` };
    }
    return {
      story: {
        token,
        story_id: match.story_id,
        path: match.path,
        relpath: projectRel(projectRoot, match.path),
      },
      error: null,
    };
  }
  if (idMatches.length === 0) {
    return { story: null, error: `${JSON.stringify(token)}: no active story with this id.` };
  }
  const paths = idMatches
    .map((m) => projectRel(projectRoot, m.path))
    .sort()
    .join(", ");
  return {
    story: null,
    error: `${JSON.stringify(token)}: ambiguous -- ${idMatches.length} active stories share this id (${paths}).`,
  };
}

export function resolveStories(
  projectRoot: string,
  tokens: readonly string[],
): { resolved: ResolvedStory[]; errors: string[] } {
  const index = indexActiveStories(projectRoot);
  const idMap = new Map<string, ActiveStory[]>();
  const issueMap = new Map<number, ActiveStory[]>();
  for (const story of index) {
    const idList = idMap.get(story.story_id) ?? [];
    idList.push(story);
    idMap.set(story.story_id, idList);
    for (const issue of story.issues) {
      const issueList = issueMap.get(issue) ?? [];
      issueList.push(story);
      issueMap.set(issue, issueList);
    }
  }

  const resolved: ResolvedStory[] = [];
  const errors: string[] = [];
  const seenPaths = new Set<string>();
  for (const raw of tokens) {
    const token = raw.trim();
    if (token.length === 0) {
      continue;
    }
    const { story, error } = resolveOne(token, projectRoot, idMap, issueMap);
    if (error !== null || story === null) {
      errors.push(error ?? `${JSON.stringify(token)}: could not resolve.`);
      continue;
    }
    const resolvedPath = resolve(story.path);
    if (seenPaths.has(resolvedPath)) {
      continue;
    }
    seenPaths.add(resolvedPath);
    resolved.push(story);
  }
  return { resolved, errors };
}

export function enforceGates(
  resolved: readonly ResolvedStory[],
  projectRoot: string,
  preflightGate: PreflightGateFn = defaultPreflightGate,
  readinessGate: ReadinessGateFn = defaultReadinessGate,
): { story: ResolvedStory; reason: string } | null {
  for (const story of resolved) {
    const pre = preflightGate(story.path);
    if (pre.exitCode !== 0) {
      return { story, reason: `preflight gate failed: ${pre.message.trim()}` };
    }
    const ready = readinessGate(story.path, projectRoot);
    if (ready.exitCode !== 0) {
      return { story, reason: `swarm:readiness gate failed:\n${ready.report.trim()}` };
    }
  }
  return null;
}

function safeSegment(text: string): string {
  let cleaned = "";
  for (const ch of text.trim()) {
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "." ||
      ch === "_" ||
      ch === "-"
    ) {
      cleaned += ch;
    } else {
      cleaned += "-";
    }
  }
  let start = 0;
  let end = cleaned.length;
  while (start < end && (cleaned[start] === "-" || cleaned[start] === ".")) {
    start += 1;
  }
  while (end > start && (cleaned[end - 1] === "-" || cleaned[end - 1] === ".")) {
    end -= 1;
  }
  cleaned = cleaned.slice(start, end);
  return cleaned.length > 0 ? cleaned : "story";
}

function deriveBranch(group: string | null, sid: string): string {
  const leaf = safeSegment(sid);
  return group !== null && group.length > 0
    ? `swarm/${safeSegment(group)}/${leaf}`
    : `swarm/${leaf}`;
}

function defaultWorktree(projectRoot: string, sid: string): string {
  return join(projectRoot, ".deft-scratch", "worktrees", safeSegment(sid)).replace(/\\/g, "/");
}

export const SWARM_LAUNCH_MANIFEST_RELPATH = [".deft", "swarm-launch-manifest.json"] as const;
export const SWARM_LAUNCH_OCCUPANCY_DIR = [".deft", "swarm-launch-occupancy"] as const;

export function swarmLaunchManifestPath(projectRoot: string): string {
  return join(resolve(projectRoot), ...SWARM_LAUNCH_MANIFEST_RELPATH);
}

export interface LaunchOccupancyRecord {
  readonly allocation_plan_id: string | null;
  readonly occupancy_session_id: string;
  readonly story_ids: readonly string[];
  readonly cohort_key: string;
}

export interface LaunchOccupancyQuery {
  readonly allocationPlanId?: string | null;
  readonly storyIds?: readonly string[];
}

export type LaunchOccupancyLookupReason = "ok" | "missing" | "wrong-cohort";

export function occupancyCohortKey(
  allocationPlanId: string | null | undefined,
  storyIds: readonly string[] = [],
): string {
  const plan = allocationPlanId?.trim() ?? "";
  if (plan.length > 0) return `plan:${plan}`;
  const stories = [...storyIds].map((id) => id.trim()).filter((id) => id.length > 0);
  stories.sort();
  return `stories:${stories.join(",")}`;
}

export function launchOccupancyRecordRelpath(cohortKey: string): string[] {
  return [...SWARM_LAUNCH_OCCUPANCY_DIR, `${safeSegment(cohortKey)}.json`];
}

function parseLaunchOccupancyRecord(payload: unknown): LaunchOccupancyRecord | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  const sessionId =
    typeof obj.occupancy_session_id === "string" ? obj.occupancy_session_id.trim() : "";
  if (sessionId.length === 0) return null;
  const cohortKey = typeof obj.cohort_key === "string" ? obj.cohort_key.trim() : "";
  if (cohortKey.length === 0) return null;
  const planRaw = obj.allocation_plan_id;
  const allocationPlanId =
    typeof planRaw === "string" && planRaw.trim().length > 0 ? planRaw.trim() : null;
  const storyIds = Array.isArray(obj.story_ids)
    ? obj.story_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  return {
    allocation_plan_id: allocationPlanId,
    occupancy_session_id: sessionId,
    story_ids: storyIds,
    cohort_key: cohortKey,
  };
}

function storySetEquals(left: readonly string[], right: ReadonlySet<string>): boolean {
  if (left.length !== right.size) return false;
  return left.every((id) => right.has(id));
}

function readLaunchOccupancyFile(
  projectRoot: string,
  cohortKey: string,
): LaunchOccupancyRecord | null {
  const path = join(resolve(projectRoot), ...launchOccupancyRecordRelpath(cohortKey));
  try {
    if (!existsSync(path)) return null;
    return parseLaunchOccupancyRecord(JSON.parse(readFileSync(path, { encoding: "utf8" })));
  } catch {
    return null;
  }
}

function listLaunchOccupancyRecords(projectRoot: string): LaunchOccupancyRecord[] {
  const dir = join(resolve(projectRoot), ...SWARM_LAUNCH_OCCUPANCY_DIR);
  if (!existsSync(dir)) return [];
  const out: LaunchOccupancyRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parseLaunchOccupancyRecord(
        JSON.parse(readFileSync(join(dir, name), { encoding: "utf8" })),
      );
      if (parsed !== null) out.push(parsed);
    } catch {
      /* skip unreadable cohort slot */
    }
  }
  return out;
}

export function persistLaunchOccupancyRecord(
  projectRoot: string,
  record: LaunchOccupancyRecord,
): void {
  const relpath = launchOccupancyRecordRelpath(record.cohort_key);
  const absDir = join(resolve(projectRoot), ...SWARM_LAUNCH_OCCUPANCY_DIR);
  mkdirSync(absDir, { recursive: true });
  containedWrite({
    root: projectRoot,
    target: join(...relpath),
    data: `${JSON.stringify(record, null, 2)}\n`,
    mode: "replace",
  });
}

export function resolveLaunchOccupancySessionId(
  projectRoot: string,
  query: LaunchOccupancyQuery = {},
): { sessionId: string; reason: LaunchOccupancyLookupReason } {
  const storyIds = (query.storyIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  const requestedKey = occupancyCohortKey(query.allocationPlanId, storyIds);
  const exact = readLaunchOccupancyFile(projectRoot, requestedKey);
  if (exact !== null) {
    const wantedPlan = query.allocationPlanId?.trim() ?? "";
    if (exact.cohort_key !== requestedKey) {
      return { sessionId: "", reason: "wrong-cohort" };
    }
    if (wantedPlan.length > 0 && exact.allocation_plan_id !== wantedPlan) {
      return { sessionId: "", reason: "wrong-cohort" };
    }
    return { sessionId: exact.occupancy_session_id, reason: "ok" };
  }
  if ((query.allocationPlanId?.trim() ?? "").length > 0) {
    return { sessionId: "", reason: "missing" };
  }
  if (storyIds.length === 0) {
    return { sessionId: "", reason: "missing" };
  }
  const wanted = new Set(storyIds);
  const matches = listLaunchOccupancyRecords(projectRoot).filter((rec) =>
    storySetEquals(rec.story_ids, wanted),
  );
  if (matches.length === 0) {
    return { sessionId: "", reason: "missing" };
  }
  const sessionIds = new Set(matches.map((rec) => rec.occupancy_session_id));
  if (sessionIds.size !== 1) {
    return { sessionId: "", reason: "wrong-cohort" };
  }
  return { sessionId: matches[0]?.occupancy_session_id ?? "", reason: "ok" };
}

export function buildManifest(
  resolved: readonly ResolvedStory[],
  options: {
    projectRoot: string;
    group?: string | null;
    worktreeRecords?: Map<string, WorktreeRecord>;
    dispatchKind: string;
    allocationPlanId: string | null;
    batchingRationale: string | null;
    operatorApprovalEvidence: string | null;
    gateClearances?: readonly Record<string, unknown>[];
    subagentBackend?: string | null;
    dispatchProvider?: string | null;
    workerRole?: string | null;
    resolvedModel?: string | null;
    modelSource?: string | null;
    runtimeMode?: string | null;
    githubAuthMode?: string | null;
    expectedGithubLogin?: string | null;
    occupancySessionId?: string | null;
  },
): Record<string, unknown>[] {
  const cohortVbriefs = resolved.map((s) => s.relpath);
  const records = options.worktreeRecords ?? new Map<string, WorktreeRecord>();
  const manifest: Record<string, unknown>[] = [];

  for (const story of resolved) {
    const record = records.get(story.story_id);
    const worktreePath =
      record !== undefined && typeof record.worktree_path === "string"
        ? record.worktree_path
        : defaultWorktree(options.projectRoot, story.story_id);

    const allocationContext: Record<string, unknown> = {
      dispatch_kind: options.dispatchKind,
      allocation_plan_id: options.allocationPlanId,
      batching_rationale: options.batchingRationale,
      cohort_vbriefs: cohortVbriefs,
      operator_approval_evidence: options.operatorApprovalEvidence,
    };
    if (options.gateClearances !== undefined && options.gateClearances.length > 0) {
      allocationContext.gate_clearances = options.gateClearances;
    }

    const entry: Record<string, unknown> = {
      story_id: story.story_id,
      vbrief_path: story.relpath,
      worktree_path: worktreePath,
      branch: deriveBranch(options.group ?? null, story.story_id),
      allocation_context: allocationContext,
    };
    if (options.occupancySessionId !== undefined && options.occupancySessionId !== null) {
      entry.occupancy_session_id = options.occupancySessionId;
    }
    if (options.subagentBackend !== undefined && options.subagentBackend !== null) {
      entry.subagent_backend = options.subagentBackend;
    }
    if (options.dispatchProvider !== undefined && options.dispatchProvider !== null) {
      entry.dispatch_provider = options.dispatchProvider;
    }
    if (options.workerRole !== undefined && options.workerRole !== null) {
      entry.worker_role = options.workerRole;
    }
    if (options.modelSource !== undefined && options.modelSource !== null) {
      entry.resolved_model = options.resolvedModel ?? null;
      entry.model_source = options.modelSource;
    }
    if (options.runtimeMode !== undefined && options.runtimeMode !== null) {
      entry.runtime_mode = options.runtimeMode;
    }
    if (options.githubAuthMode !== undefined && options.githubAuthMode !== null) {
      entry.github_auth_mode = options.githubAuthMode;
    }
    if (options.expectedGithubLogin !== undefined && options.expectedGithubLogin !== null) {
      assertNoCredentialValue(options.expectedGithubLogin, "expected_github_login");
      entry.expected_github_login = options.expectedGithubLogin;
    }
    manifest.push(entry);
  }
  return manifest;
}

export function orderCohort(
  resolved: readonly ResolvedStory[],
  _projectRoot: string,
): ResolvedStory[] {
  return [...resolved].sort((a, b) => {
    const planA = planOf(loadJson(a.path) ?? {});
    const planB = planOf(loadJson(b.path) ?? {});
    const keyA = selectionOrderingKey({
      labelIndex: 0,
      isContinuation: false,
      rank: scopeMetadataRank(planA),
      dateKey: [0, a.relpath],
    });
    const keyB = selectionOrderingKey({
      labelIndex: 0,
      isContinuation: false,
      rank: scopeMetadataRank(planB),
      dateKey: [0, b.relpath],
    });
    return JSON.stringify(keyA).localeCompare(JSON.stringify(keyB));
  });
}

function splitCsv(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    for (const piece of value.split(",")) {
      if (piece.trim().length > 0) {
        out.push(piece.trim());
      }
    }
  }
  return out;
}

export interface LaunchArgs {
  stories?: readonly string[];
  paths?: readonly string[];
  group?: string | null;
  worktreeMap?: string | null;
  baseBranch?: string;
  autonomous?: boolean;
  allocationPlanId?: string | null;
  batchingRationale?: string | null;
  operatorApproval?: string | null;
  noCreateWorktrees?: boolean;
  output?: string | null;
  gateClearancesPath?: string | null;
  enforceGatesFlag?: boolean;
  noAudit?: boolean;
  projectRoot?: string;
  preflightGate?: PreflightGateFn;
  readinessGate?: ReadinessGateFn;
  worktreeResolver?: WorktreeResolverFn;
  runtimeAuthProbe?: RuntimeAuthProbeFn;
  /**
   * Injection seam for the routing-provider environment lookup, mirroring
   * `resolveRoutingPath`'s `environ` parameter (#1877 Greptile follow-up).
   * Defaults to `process.env` when unset.
   */
  environ?: NodeJS.ProcessEnv;
  /** Optional gh runner for identity-bound credential injection (#1351). */
  runGh?: GhRunner;
  expectedPrincipal?: ExpectedGithubWorkerPrincipal | null;
}

export function swarmLaunch(args: LaunchArgs): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const projectRoot = resolve(args.projectRoot ?? process.cwd());
  const tokens = [...splitCsv(args.stories ?? []), ...splitCsv(args.paths ?? [])];

  if (tokens.length === 0) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      stdout: "",
      stderr: "Error: no stories supplied. Pass --stories <ids|paths> and/or --paths <paths>.\n",
    };
  }

  if (!existsSync(resolveLifecycleFolder(projectRoot, "active"))) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      stdout: "",
      stderr:
        `Error: no vbrief/active directory under --project-root ${projectRoot}. ` +
        "Point --project-root at a deft project with activated stories.\n",
    };
  }

  let gateClearances: Record<string, unknown>[] = [];
  if (args.gateClearancesPath !== undefined && args.gateClearancesPath !== null) {
    try {
      const payload = JSON.parse(readFileSync(args.gateClearancesPath, "utf8")) as unknown;
      if (!Array.isArray(payload)) {
        return {
          exitCode: EXIT_CONFIG_ERROR,
          stdout: "",
          stderr: `Error: --gate-clearances ${args.gateClearancesPath} must be a JSON array of clearance objects.\n`,
        };
      }
      gateClearances = payload.filter(
        (e): e is Record<string, unknown> =>
          e !== null && typeof e === "object" && !Array.isArray(e),
      );
    } catch (exc: unknown) {
      return {
        exitCode: EXIT_CONFIG_ERROR,
        stdout: "",
        stderr: `Error: could not read --gate-clearances ${args.gateClearancesPath}: ${String(exc)}\n`,
      };
    }
  }

  const { resolved, errors } = resolveStories(projectRoot, tokens);
  if (errors.length > 0) {
    let stderr = "Error: could not resolve every cohort member:\n";
    for (const error of errors) {
      stderr += `  - ${error}\n`;
    }
    return { exitCode: EXIT_GATE_FAILED, stdout: "", stderr };
  }

  const gateFailure = enforceGates(resolved, projectRoot, args.preflightGate, args.readinessGate);
  if (gateFailure !== null) {
    return {
      exitCode: EXIT_GATE_FAILED,
      stdout: "",
      stderr:
        `Error: story '${gateFailure.story.story_id}' (${gateFailure.story.relpath}) ` +
        `is not launch-ready -- ${gateFailure.reason}\n`,
    };
  }

  const routingPath = resolveRoutingPath(projectRoot);
  const { data: routingFile, error: routingError } = loadRoutingFile(routingPath);
  if (routingError !== null) {
    return { exitCode: EXIT_CONFIG_ERROR, stdout: "", stderr: `Error: ${routingError}\n` };
  }

  // When an operator route file (#1739) is present it is authoritative for
  // model selection, so the legacy swarmSubagentBackend enum gate (#1531 /
  // #1735) only runs as the fallback when no route file exists.
  let backend: ReturnType<typeof enforceSubagentBackendPolicy>["backend"] = null;
  if (routingFile === null) {
    const { backend: resolvedBackend, error: backendError } =
      enforceSubagentBackendPolicy(projectRoot);
    if (backendError !== null) {
      return { exitCode: EXIT_GATE_FAILED, stdout: "", stderr: `Error: ${backendError}\n` };
    }
    backend = resolvedBackend;
  }

  const ordered = orderCohort(resolved, projectRoot);
  const gatePosture = args.enforceGatesFlag ? GATE_ENFORCE : GATE_ADVISE;
  void gatePosture;

  const dispatchKind =
    ordered.length > 1 || (args.group !== undefined && args.group !== null && args.group.length > 0)
      ? "swarm-cohort"
      : "solo";
  const allocationPlanId = args.allocationPlanId ?? args.group ?? null;
  let batchingRationale = args.batchingRationale ?? null;
  if (batchingRationale === null && args.autonomous) {
    const plural = ordered.length === 1 ? "story" : "stories";
    const suffix = args.group ? ` (group ${args.group})` : "";
    batchingRationale = `Headless launch of ${ordered.length} pre-approved cohort ${plural}${suffix}.`;
  }
  const operatorApproval =
    args.operatorApproval ??
    `task swarm:launch (${args.autonomous ? "autonomous" : "interactive"})`;

  const occupancy = applyWorktreeOccupancy(projectRoot, {
    env: args.environ ?? process.env,
    intent: "swarm",
  });
  if (occupancy.code !== 0) {
    return {
      exitCode: EXIT_GATE_FAILED,
      stdout: "",
      stderr: `${occupancy.message}\n`,
    };
  }
  // Heartbeat on an existing owner is not a new claim -- only release a lease
  // this process just minted (#3649 paired failure clause).
  const newlyClaimed = occupancy.action === "claimed";
  const failAfterClaim = (
    exitCode: number,
    stderr: string,
  ): { exitCode: number; stdout: string; stderr: string } => {
    if (newlyClaimed) {
      releaseOccupancy(projectRoot, {
        sessionId: occupancy.sessionId,
        env: args.environ ?? process.env,
      });
    }
    return { exitCode, stdout: "", stderr };
  };

  let worktreeRecordMap = new Map<string, WorktreeRecord>();
  if (args.worktreeMap !== undefined && args.worktreeMap !== null) {
    const resolver = args.worktreeResolver ?? resolveWorktreeMap;
    try {
      const payload = JSON.parse(readFileSync(args.worktreeMap, "utf8")) as unknown;
      if (!Array.isArray(payload)) {
        return failAfterClaim(
          EXIT_CONFIG_ERROR,
          `Error: --worktree-map ${args.worktreeMap} must contain a JSON array of records.\n`,
        );
      }
      const records = resolver(
        payload as Record<string, unknown>[],
        args.baseBranch ?? DEFAULT_BASE_BRANCH,
        !(args.noCreateWorktrees ?? false),
        {
          repoRoot: projectRoot,
        },
      );
      worktreeRecordMap = new Map(records.map((r) => [r.story_id, r]));
    } catch (exc: unknown) {
      return failAfterClaim(
        EXIT_CONFIG_ERROR,
        `Error: worktree map resolution failed: ${String(exc)}\n`,
      );
    }
  }

  let runtimeMode: string;
  let githubAuthMode: string;
  try {
    const probe = args.runtimeAuthProbe ?? defaultRuntimeAuthProbe;
    [runtimeMode, githubAuthMode] = probe();
  } catch (exc: unknown) {
    return failAfterClaim(EXIT_CONFIG_ERROR, `Error: ${String(exc)}\n`);
  }

  let resolvedModel: string | null = null;
  let modelSource: string | null = null;
  let routingProvider: string | null = null;
  if (routingFile !== null) {
    routingProvider = resolveDispatchProvider(args.environ ?? process.env);
    const route = resolveModelRoute(routingFile, routingProvider, LEAF_CODING_WORKER_ROLE);
    // A malformed decision object must fail loud here: the legacy backend gate
    // was already bypassed above (routingFile !== null), so silently continuing
    // would emit an exit-0 manifest with no model and no error to follow. Match
    // verify:routing, which treats the same state as a config error (#1739).
    if (route.source === "invalid") {
      return failAfterClaim(
        EXIT_CONFIG_ERROR,
        `Error: routing gate misconfigured: ${route.error ?? "invalid routing decision"}\n`,
      );
    }
    if (route.decided) {
      resolvedModel = route.model;
      modelSource = route.source;
    }
  }

  const dispatchProviderValue =
    routingFile !== null
      ? routingProvider
      : backend !== null
        ? dispatchProviderFor(backend.backend_id)
        : null;
  const workerRoleValue = routingFile !== null || backend !== null ? LEAF_CODING_WORKER_ROLE : null;

  const launchEnviron = args.environ ?? process.env;
  let expectedGithubLogin: string | null = null;
  // Only the injected-token launch path auto-validates (and fail-closes on a
  // missing token). An ambient GH_TOKEN on a host-gh probe is often the
  // maintainer workaround, not a worker credential; local-hybrid injection is
  // the explicit prepareWorkerCredentialInjection call.
  if (githubAuthMode === GITHUB_AUTH_MODE_INJECTED_TOKEN) {
    const injection = prepareWorkerCredentialInjection({
      environ: launchEnviron,
      githubAuthMode,
      runtimeMode,
      dispatchPath: "grok-build",
      runGh: args.runGh,
      expectedPrincipal: args.expectedPrincipal,
      cwd: projectRoot,
    });
    if (!injection.ok) {
      return failAfterClaim(EXIT_GATE_FAILED, `${injection.detail}\n${injection.remedy}\n`);
    }
    if (injection.injected) {
      expectedGithubLogin = injection.expectedLogin;
    }
  }

  const manifest = buildManifest(ordered, {
    projectRoot,
    group: args.group ?? null,
    worktreeRecords: worktreeRecordMap,
    dispatchKind,
    allocationPlanId,
    batchingRationale,
    operatorApprovalEvidence: operatorApproval,
    gateClearances,
    subagentBackend: backend?.backend_id ?? null,
    dispatchProvider: dispatchProviderValue,
    workerRole: workerRoleValue,
    resolvedModel,
    modelSource,
    runtimeMode,
    githubAuthMode,
    expectedGithubLogin,
    occupancySessionId: occupancy.sessionId,
  });

  const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
  const storyIds = ordered.map((story) => story.story_id);
  const cohortKey = occupancyCohortKey(allocationPlanId, storyIds);

  try {
    mkdirSync(dirname(swarmLaunchManifestPath(projectRoot)), { recursive: true });
    containedWrite({
      root: projectRoot,
      target: join(...SWARM_LAUNCH_MANIFEST_RELPATH),
      data: rendered,
      mode: "replace",
    });
    persistLaunchOccupancyRecord(projectRoot, {
      allocation_plan_id: allocationPlanId,
      occupancy_session_id: occupancy.sessionId,
      story_ids: storyIds,
      cohort_key: cohortKey,
    });
  } catch (exc: unknown) {
    return failAfterClaim(
      EXIT_CONFIG_ERROR,
      `Error: could not persist launch occupancy_session_id: ${String(exc)}\n`,
    );
  }

  if (args.output !== undefined && args.output !== null) {
    try {
      // #2980 wave D: product write sink routes through containedWrite.
      const abs = resolve(args.output);
      const dir = dirname(abs);
      mkdirSync(dir, { recursive: true });
      containedWrite({
        root: dir,
        target: basename(abs),
        data: rendered,
        mode: "replace",
      });
    } catch (exc: unknown) {
      return {
        exitCode: EXIT_CONFIG_ERROR,
        stdout: "",
        stderr: `Error: could not write --output ${args.output}: ${String(exc)}\n`,
      };
    }
  }

  void args.noAudit;
  return { exitCode: EXIT_OK, stdout: rendered, stderr: "" };
}

export { EXIT_CONFIG_ERROR, EXIT_GATE_FAILED, EXIT_OK };
