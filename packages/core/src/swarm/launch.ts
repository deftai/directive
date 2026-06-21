import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { inferGithubAuthMode } from "../intake/github-auth-modes.js";
import { getPlatformCapabilities } from "../intake/platform-capabilities.js";
import { evaluate as preflightEvaluate } from "../preflight/evaluate.js";
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
  dispatchProviderFromRuntime,
  loadRoutingFile,
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
  return name.endsWith(".vbrief.json")
    ? name.slice(0, -".vbrief.json".length)
    : name.replace(/\.[^.]+$/, "");
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

function indexActiveStories(projectRoot: string): ActiveStory[] {
  const activeDir = join(projectRoot, "vbrief", "active");
  const index: ActiveStory[] = [];
  if (!existsSync(activeDir)) {
    return index;
  }
  for (const name of readdirSync(activeDir).sort()) {
    if (!name.endsWith(".vbrief.json")) {
      continue;
    }
    const path = join(activeDir, name);
    const data = loadJson(path);
    if (data === null) {
      continue;
    }
    const plan = planOf(data);
    index.push({ path, story_id: storyId(path, plan), issues: issueNumbers(plan) });
  }
  return index;
}

export function looksLikePath(token: string): boolean {
  return (
    token.endsWith(".json") ||
    token.includes("/") ||
    token.includes("\\") ||
    (existsSync(token) && basename(token).endsWith(".vbrief.json"))
  );
}

function resolveOne(
  token: string,
  projectRoot: string,
  idMap: Map<string, ActiveStory[]>,
  issueMap: Map<number, ActiveStory[]>,
): { story: ResolvedStory | null; error: string | null } {
  if (looksLikePath(token)) {
    const candidate = token.startsWith("/") ? token : join(projectRoot, token);
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

  if (!existsSync(join(projectRoot, "vbrief", "active"))) {
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

  let worktreeRecordMap = new Map<string, WorktreeRecord>();
  if (args.worktreeMap !== undefined && args.worktreeMap !== null) {
    const resolver = args.worktreeResolver ?? resolveWorktreeMap;
    try {
      const payload = JSON.parse(readFileSync(args.worktreeMap, "utf8")) as unknown;
      if (!Array.isArray(payload)) {
        return {
          exitCode: EXIT_CONFIG_ERROR,
          stdout: "",
          stderr: `Error: --worktree-map ${args.worktreeMap} must contain a JSON array of records.\n`,
        };
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
      return {
        exitCode: EXIT_CONFIG_ERROR,
        stdout: "",
        stderr: `Error: worktree map resolution failed: ${String(exc)}\n`,
      };
    }
  }

  let runtimeMode: string;
  let githubAuthMode: string;
  try {
    const probe = args.runtimeAuthProbe ?? defaultRuntimeAuthProbe;
    [runtimeMode, githubAuthMode] = probe();
  } catch (exc: unknown) {
    return { exitCode: EXIT_CONFIG_ERROR, stdout: "", stderr: `Error: ${String(exc)}\n` };
  }

  let resolvedModel: string | null = null;
  let modelSource: string | null = null;
  let routingProvider: string | null = null;
  if (routingFile !== null) {
    routingProvider = dispatchProviderFromRuntime(runtimeMode);
    const route = resolveModelRoute(routingFile, routingProvider, LEAF_CODING_WORKER_ROLE);
    // A malformed decision object must fail loud here: the legacy backend gate
    // was already bypassed above (routingFile !== null), so silently continuing
    // would emit an exit-0 manifest with no model and no error to follow. Match
    // verify:routing, which treats the same state as a config error (#1739).
    if (route.source === "invalid") {
      return {
        exitCode: EXIT_CONFIG_ERROR,
        stdout: "",
        stderr: `Error: routing gate misconfigured: ${route.error ?? "invalid routing decision"}\n`,
      };
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
  });

  const rendered = `${JSON.stringify(manifest, null, 2)}\n`;

  if (args.output !== undefined && args.output !== null) {
    try {
      writeFileSync(args.output, rendered, "utf8");
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
