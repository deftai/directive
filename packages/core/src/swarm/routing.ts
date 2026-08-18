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
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { assertWriteTargetSafe } from "../fs/projection-containment.js";

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

/**
 * Live routing key for Grok Build. A `grok-build` file key is a trap (#3469):
 * read it as `grok` when the live provider is grok, or ignore it without
 * blocking launch.
 */
export const GROK_ROUTING_KEY = "grok";
export const GROK_BUILD_FILE_KEY = "grok-build";

/**
 * Env / probe names that identify Grok Build. Same set `probeMonitoringTier`
 * already uses, plus `GROK_BUILD` / `DEFT_AGENT_RUNTIME=grok-build`.
 * Named on the host-unrecognized honesty line when empty (#3469).
 */
export const HOST_DETECT_PROBE_NAMES = [
  "GROK_BUILD",
  "DEFT_AGENT_RUNTIME",
  "DEFT_HAS_SPAWN_SUBAGENT",
  "DEFT_PROBE_GROK_BUILD",
  "DEFT_PROBE_SPAWN_SUBAGENT",
] as const;

/** Providers whose per-role model must be decided before sub-agent dispatch (#1739 / #1877 / #2875 / #3134). */
export const ROUTING_GATED_DISPATCH_PROVIDERS = new Set<string>([
  "cursor",
  "grok",
  "openclaw",
  "claude",
]);

const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);

function envTruthy(environ: NodeJS.ProcessEnv, name: string): boolean {
  return TRUTHY_ENV.has((environ[name] ?? "").trim().toLowerCase());
}

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

export function emptyHostDetectProbes(environ: NodeJS.ProcessEnv = process.env): string[] {
  return HOST_DETECT_PROBE_NAMES.filter((name) => (environ[name] ?? "").trim().length === 0);
}

function decisionLooksPinned(decision: RouteDecision): boolean {
  return typeof decision.model === "string" && decision.model.trim().length > 0;
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
  let block = providerBlockOf(file, provider);
  if ((block === null || !(role in block)) && provider === GROK_ROUTING_KEY) {
    const alias = providerBlockOf(file, GROK_BUILD_FILE_KEY);
    if (alias !== null && role in alias) {
      const aliasDecision = alias[role];
      // Dead `grok-build` pins must not fail-close a harness-bound grok
      // provider (#3469). Read harness-default; ignore a pin.
      if (
        typeof aliasDecision === "object" &&
        aliasDecision !== null &&
        !Array.isArray(aliasDecision) &&
        decisionLooksPinned(aliasDecision)
      ) {
        return { decided: false, model: null, mode: null, source: "undecided", error: null };
      }
      block = alias;
    }
  }
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
  if (normalized.includes("openclaw")) {
    return "openclaw";
  }
  if (normalized.includes("claude")) {
    return "claude";
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
 * Resolve the `dispatch_provider` routing key from the active runtime envelope.
 * Separate from `runtime_mode` (#1557): Cursor sessions may carry
 * `runtime_mode=cloud-headless` for gh-auth purposes but route under provider
 * `cursor` for model selection (#1877). OpenClaw routes under `openclaw` when
 * `sessions_spawn` / OPENCLAW signals are present (#2875). Claude Code routes
 * under `claude` when Claude-unique signals are present (#3134) — never via bare
 * Task (that would misclassify as cursor).
 */
export function resolveDispatchProvider(environ: NodeJS.ProcessEnv = process.env): string {
  if (envTruthy(environ, "CURSOR_COMPOSER") || envTruthy(environ, "CURSOR_AGENT")) {
    return "cursor";
  }
  const runtime = (environ.DEFT_AGENT_RUNTIME ?? "").trim().toLowerCase();
  // Claude Code before OpenClaw/CI so CLAUDECODE / DEFT_PROBE_CLAUDE_CODE win (#3134).
  if (
    envTruthy(environ, "DEFT_PROBE_CLAUDE_CODE") ||
    envTruthy(environ, "DEFT_HAS_CLAUDE_AGENT") ||
    envTruthy(environ, "CLAUDECODE") ||
    envTruthy(environ, "CLAUDE_CODE") ||
    runtime === "claude-code" ||
    runtime === "claude"
  ) {
    return "claude";
  }
  if (
    envTruthy(environ, "OPENCLAW") ||
    envTruthy(environ, "DEFT_HAS_SESSIONS_SPAWN") ||
    envTruthy(environ, "DEFT_PROBE_SESSIONS_SPAWN") ||
    runtime === "openclaw"
  ) {
    return "openclaw";
  }
  if (
    envTruthy(environ, "GROK_BUILD") ||
    envTruthy(environ, "DEFT_HAS_SPAWN_SUBAGENT") ||
    envTruthy(environ, "DEFT_PROBE_GROK_BUILD") ||
    envTruthy(environ, "DEFT_PROBE_SPAWN_SUBAGENT") ||
    runtime === "grok-build"
  ) {
    return GROK_ROUTING_KEY;
  }
  if (runtime === "cloud" || runtime === "headless") {
    return "cloud-headless";
  }
  if (
    envTruthy(environ, "GITHUB_ACTIONS") ||
    envTruthy(environ, "BUILDKITE") ||
    (envTruthy(environ, "CI") &&
      !envTruthy(environ, "CURSOR_COMPOSER") &&
      !envTruthy(environ, "CURSOR_AGENT") &&
      !envTruthy(environ, "OPENCLAW") &&
      !envTruthy(environ, "DEFT_HAS_SESSIONS_SPAWN") &&
      !envTruthy(environ, "CLAUDECODE") &&
      !envTruthy(environ, "CLAUDE_CODE") &&
      !envTruthy(environ, "DEFT_PROBE_CLAUDE_CODE"))
  ) {
    return "cloud-headless";
  }
  return "unknown";
}

/**
 * Keys that would mutate the prototype chain rather than set an own property
 * if used as a computed object key. Rejected for provider/role names so a
 * malicious routing input cannot pollute `Object.prototype` (CodeQL
 * js/prototype-polluting-assignment). This validation guard produces the
 * caller-facing error; the null-prototype write targets in
 * `writeModelDecision` are the structural backstop CodeQL recognizes.
 */
const FORBIDDEN_ROUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeRoutingKey(kind: "provider" | "role", key: string): void {
  if (FORBIDDEN_ROUTING_KEYS.has(key)) {
    throw new Error(`routing ${kind} name "${key}" is not allowed`);
  }
}

/**
 * Write a decision back to the route file (create-if-missing). Stamps
 * `decidedAt` when the caller did not supply one. Used by the interactive
 * resolver path (resolver step 5) and the `swarm:routing-set` task.
 */
export function writeModelDecision(
  projectRoot: string,
  path: string,
  provider: string,
  role: string,
  decision: RouteDecision,
): void {
  assertSafeRoutingKey("provider", provider);
  assertSafeRoutingKey("role", role);
  assertWriteTargetSafe(projectRoot, path);
  const { data } = loadRoutingFile(path);
  // Null-prototype write targets so a computed provider/role key can only ever
  // set an own property and can never reach `Object.prototype`, even if the
  // validation guard above regresses. CodeQL's js/prototype-polluting-assignment
  // barrier does not track the interprocedural `assertSafeRoutingKey` guard, so
  // this structural sink is what closes alert #52.
  const file: RoutingFile = Object.assign(Object.create(null) as RoutingFile, data ?? {});
  const existing = providerBlockOf(file, provider);
  const block: Record<string, RouteDecision> = Object.assign(
    Object.create(null) as Record<string, RouteDecision>,
    existing ?? {},
  );
  block[role] = {
    model: decision.model,
    mode:
      decision.mode ??
      (decision.model === null ? ROUTING_MODE_HARNESS_DEFAULT : ROUTING_MODE_PINNED),
    decidedAt: decision.decidedAt ?? new Date().toISOString(),
  };
  file[provider] = block;
  // #2980 wave D: product write sink routes through containedWrite.
  containedWrite({
    root: resolve(projectRoot),
    target: path,
    data: `${JSON.stringify(file, null, 2)}\n`,
    mode: "replace",
  });
}
