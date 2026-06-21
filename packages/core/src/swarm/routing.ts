/**
 * Operator-specifiable coding sub-agent model routing (#1739).
 *
 * The selection lives in a per-project, per-machine, gitignored route file
 * (`.deft/routing.local.json`) keyed by (dispatch_provider, worker_role) -> a
 * decision object. Unlike the superseded `swarmSubagentBackend` enum (#1531 /
 * #1735), which recorded intent but was never threaded into the spawn call,
 * the resolved model is stamped into the launch manifest so the dispatch path
 * can actually honor it.
 *
 * Load-bearing rule: "decided?" is tested by KEY PRESENCE, never by value
 * truthiness -- an explicit `model: null` (mode: harness-default) is a
 * decision, not absence. Testing truthiness would re-nag every session on an
 * explicit default.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The fixed worker-role vocabulary (reused from #1531). No separate tier
 * vocabulary to start; decisions are strictly per-role.
 */
export const SWARM_WORKER_ROLES = [
  "leaf-implementation",
  "orchestrator",
  "review-monitor",
  "merge-release",
] as const;

export type SwarmWorkerRole = (typeof SWARM_WORKER_ROLES)[number];

export const ROUTING_MODE_PINNED = "pinned";
export const ROUTING_MODE_HARNESS_DEFAULT = "harness-default";

export const ROUTING_FILENAME = "routing.local.json";

/** Providers whose model is harness-bound -- deft cannot pin or verify a slug. */
export const HARNESS_BOUND_PROVIDERS = new Set<string>(["grok"]);

export interface RouteDecision {
  model: string | null;
  mode?: string;
  decidedAt?: string;
}

export type RoutingFile = Record<string, Record<string, RouteDecision>>;

export interface RouteResolution {
  /** true when the (provider, role) key is present -- a decision exists. */
  decided: boolean;
  /** pinned slug, or null for an explicit harness-default / undecided. */
  model: string | null;
  /** "pinned" | "harness-default" | null (undecided/invalid). */
  mode: string | null;
  /** "<provider>-route" | "harness-default explicit" | "undecided" | "invalid". */
  source: string;
  error: string | null;
}

/**
 * Resolve the route-file path. Honors the `DEFT_ROUTING_PATH` override first
 * (keeps both maintainer and consumer testable), then reads from the MAIN
 * worktree root via `git rev-parse --git-common-dir` -> parent. The main-root
 * read is deliberate: gitignored/untracked files are NOT copied into
 * `git worktree add` directories, and swarm dispatches leaf coders from
 * worktrees, so every worktree in a cohort must share the one local file.
 */
export function resolveRoutingPath(
  startDir: string,
  environ: NodeJS.ProcessEnv = process.env,
): string {
  const override = environ.DEFT_ROUTING_PATH;
  if (override !== undefined && override.trim().length > 0) {
    return resolve(override.trim());
  }
  let root = resolve(startDir);
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out.length > 0) {
      const commonDir = isAbsolute(out) ? out : resolve(startDir, out);
      root = dirname(commonDir);
    }
  } catch {
    // Not a git work tree -- fall back to startDir.
  }
  return join(root, ".deft", ROUTING_FILENAME);
}

export function loadRoutingFile(path: string): { data: RoutingFile | null; error: string | null } {
  if (!existsSync(path)) {
    return { data: null, error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (exc: unknown) {
    return { data: null, error: `${path}: invalid JSON (${String(exc)}).` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { data: null, error: `${path}: routing file must be a JSON object.` };
  }
  return { data: parsed as RoutingFile, error: null };
}

function providerBlockOf(
  file: RoutingFile | null,
  provider: string,
): Record<string, RouteDecision> | null {
  if (file === null) {
    return null;
  }
  const block = file[provider];
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return null;
  }
  return block;
}

/**
 * Resolve a (provider, role) route. Tri-state by KEY PRESENCE:
 *   - key present, model "<slug>"      -> pinned
 *   - key present, model null          -> explicit harness-default (a decision)
 *   - key absent                       -> undecided (fail loud upstream)
 */
export function resolveModelRoute(
  file: RoutingFile | null,
  provider: string,
  role: string,
): RouteResolution {
  const block = providerBlockOf(file, provider);
  if (block === null || !(role in block)) {
    return { decided: false, model: null, mode: null, source: "undecided", error: null };
  }
  const decision = block[role];
  if (typeof decision !== "object" || decision === null || Array.isArray(decision)) {
    return {
      decided: true,
      model: null,
      mode: null,
      source: "invalid",
      error: `routing[${provider}][${role}] must be a decision object.`,
    };
  }
  const model = decision.model;
  const mode = typeof decision.mode === "string" && decision.mode.length > 0 ? decision.mode : null;
  if (model === null) {
    return {
      decided: true,
      model: null,
      mode: mode ?? ROUTING_MODE_HARNESS_DEFAULT,
      source: "harness-default explicit",
      error: null,
    };
  }
  if (typeof model === "string" && model.trim().length > 0) {
    return {
      decided: true,
      model: model.trim(),
      mode: mode ?? ROUTING_MODE_PINNED,
      source: `${provider}-route`,
      error: null,
    };
  }
  return {
    decided: true,
    model: null,
    mode,
    source: "invalid",
    error: `routing[${provider}][${role}].model must be a non-empty string or explicit null.`,
  };
}

/** Map a runtime descriptor (platform-capabilities.runtimeMode) to a route key. */
export function dispatchProviderFromRuntime(runtimeMode: string): string {
  const normalized = runtimeMode.trim().toLowerCase();
  if (normalized.length === 0) {
    return "unknown";
  }
  if (normalized.includes("grok")) {
    return "grok";
  }
  if (normalized.includes("cursor")) {
    return "cursor";
  }
  return normalized;
}

/**
 * Write a decision back to the route file (create-if-missing). Stamps
 * `decidedAt` when the caller did not supply one. Used by the interactive
 * resolver path (resolver step 5) and the `swarm:routing-set` task.
 */
export function writeModelDecision(
  path: string,
  provider: string,
  role: string,
  decision: RouteDecision,
): void {
  const { data } = loadRoutingFile(path);
  const file: RoutingFile = data ?? {};
  const existing = providerBlockOf(file, provider);
  const block: Record<string, RouteDecision> = existing ?? {};
  block[role] = {
    model: decision.model,
    mode:
      decision.mode ??
      (decision.model === null ? ROUTING_MODE_HARNESS_DEFAULT : ROUTING_MODE_PINNED),
    decidedAt: decision.decidedAt ?? new Date().toISOString(),
  };
  file[provider] = block;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}
