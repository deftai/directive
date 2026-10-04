/**
 * Honor-at-dispatch join for operator routing (#3703 Prefer-A).
 *
 * verify:routing proves a config decision exists. This module joins that
 * trusted snapshot to the actual spawn request (payload model or launcher
 * argv) before submit. Token-only / advisory-only / self-attested model:
 * leads are not P3 closure for builders.
 *
 * Requested-model conformance is separate from proof of the host's actual
 * serving model. Hosts that cannot rewrite PreToolUse input are scoped as
 * non-intercept for payload construction; launcher-argv is argv inspection
 * only.
 */
import { EXIT_OK } from "./constants.js";
import {
  HARNESS_BOUND_PROVIDERS,
  loadRoutingFile,
  ROUTING_GATED_DISPATCH_PROVIDERS,
  ROUTING_MODE_HARNESS_DEFAULT,
  type RouteResolution,
  resolveDispatchProvider,
  resolveModelRoute,
  resolveRoutingPath,
  SWARM_WORKER_ROLES,
} from "./routing.js";
import { DEFAULT_GATED_ROLES, verifyRouting } from "./routing-verify.js";

/** Spawn-class allow paths that must run the routing conjunct ahead of allow. */
export const ROUTING_SPAWN_CLASSES = [
  "explore",
  "process-only",
  "ephemeral",
  "implement",
  "launcher-argv",
] as const;

export type RoutingSpawnClass = (typeof ROUTING_SPAWN_CLASSES)[number];

/**
 * How the request surface can be constrained.
 * - payload-model: host PreToolUse can read/rewrite tool_input.model
 * - launcher-argv: Shell argv --model inspection only (no rewrite)
 * - non-intercept: host cannot rewrite; omitted/different model denies when pinned
 */
export type RoutingHonorSurface = "payload-model" | "launcher-argv" | "non-intercept";

export interface SpawnRoutingHonorRequest {
  readonly projectRoot: string;
  readonly environ?: NodeJS.ProcessEnv;
  /** Override resolved provider (tests). */
  readonly provider?: string | null;
  readonly spawnClass: RoutingSpawnClass;
  readonly surface: RoutingHonorSurface;
  /**
   * Structural worker_role from tool_input / top-level fields only.
   * Free-text prompt markers such as `[worker_role: leaf-implementation]` do
   * not count (#3703 inherit free-text refuse).
   */
  readonly structuralWorkerRole?: string | null;
  /** Structural requested model from payload or argv; null/undefined = omitted. */
  readonly requestedModel?: string | null;
  /** Explicit silent opt-out (verify:story-ready / swarm:launch --skip-routing). */
  readonly skipRouting?: boolean;
  /**
   * When true and surface is payload-model, omitted pinned model may be filled
   * from the trusted route into the binding (host accepts updatedInput).
   */
  readonly canRewriteRequest?: boolean;
}

export type SpawnRoutingHonorCode =
  | "routing-honor-ready"
  | "routing-honor-deny"
  | "routing-honor-skip"
  | "routing-honor-carve-out"
  | "routing-honor-ungated-provider";

export interface SpawnRoutingHonorResult {
  readonly ok: boolean;
  readonly code: SpawnRoutingHonorCode;
  readonly message: string;
  readonly provider: string;
  readonly role: string | null;
  readonly resolvedModel: string | null;
  readonly modelSource: string | null;
  /** Trusted resolution used to construct/validate the request (receipt). */
  readonly resolution: RouteResolution | null;
  /**
   * Model that must appear on the spawn request after honor.
   * Null means harness-default / no slug to pass.
   */
  readonly honoredModel: string | null;
  /** True when the caller should rewrite the request to honoredModel. */
  readonly rewriteRequest: boolean;
}

export interface HonoredSpawnBinding {
  readonly model: string | null;
  readonly modelSource: string | null;
  readonly provider: string;
  readonly role: string | null;
  readonly resolution: RouteResolution | null;
}

const SKIP_ROUTING_RECORD =
  "[deft routing] --skip-routing: honor-at-dispatch and pre-dispatch routing gate skipped (#3703).";

/**
 * Gated-role domain for pre-dispatch / honor (#3703 P2): explicit subset of
 * SWARM_WORKER_ROLES. Default remains leaf-implementation only. Critics are
 * not in SWARM_WORKER_ROLES; critic auditability stays on the model: lead.
 */
export const ROUTING_GATED_ROLE_DOMAIN: readonly string[] = [...DEFAULT_GATED_ROLES];

/** Providers listed for HELP_TEXT / docs; must match ROUTING_GATED_DISPATCH_PROVIDERS. */
export function routingGatedProvidersHelpList(): string {
  return [...ROUTING_GATED_DISPATCH_PROVIDERS].sort().join(", ");
}

/**
 * Honesty: ROUTING_GATED_DISPATCH_PROVIDERS is narrower than LAUNCHER_FAMILIES
 * (grok/claude/codex). Codex is a launcher family but not a gated dispatch
 * provider until deliberately added.
 */
export const ROUTING_GATED_PROVIDERS_NARROWER_THAN_LAUNCHER_FAMILIES =
  "ROUTING_GATED_DISPATCH_PROVIDERS is narrower than LAUNCHER_FAMILIES: codex is argv-class only, not a gated dispatch provider (#3703).";

export function extractStructuralWorkerRole(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const top = payload as Record<string, unknown>;
  const toolInput =
    top.tool_input !== null && typeof top.tool_input === "object" && !Array.isArray(top.tool_input)
      ? (top.tool_input as Record<string, unknown>)
      : top.toolInput !== null && typeof top.toolInput === "object" && !Array.isArray(top.toolInput)
        ? (top.toolInput as Record<string, unknown>)
        : null;
  const from = (obj: Record<string, unknown> | null): string | null => {
    if (obj === null) return null;
    for (const key of ["worker_role", "workerRole"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  };
  return from(toolInput) ?? from(top);
}

export function extractRequestedModelFromPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const top = payload as Record<string, unknown>;
  const toolInput =
    top.tool_input !== null && typeof top.tool_input === "object" && !Array.isArray(top.tool_input)
      ? (top.tool_input as Record<string, unknown>)
      : top.toolInput !== null && typeof top.toolInput === "object" && !Array.isArray(top.toolInput)
        ? (top.toolInput as Record<string, unknown>)
        : null;
  const from = (obj: Record<string, unknown> | null): string | null => {
    if (obj === null) return null;
    for (const key of ["model", "Model", "resolved_model", "resolvedModel"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  };
  return from(toolInput) ?? from(top);
}

/**
 * Linear argv tokenizer (quote-aware). Avoids nested-quantifier regex so
 * CodeQL js/polynomial-redos stays clean on untrusted launcher command text.
 */
export function tokenizeLauncherArgv(command: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    while (i < n && /\s/.test(command[i]!)) i += 1;
    if (i >= n) break;
    let token = "";
    while (i < n && !/\s/.test(command[i]!)) {
      const ch = command[i]!;
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i += 1;
        while (i < n && command[i] !== quote) {
          if (command[i] === "\\" && i + 1 < n) {
            token += command[i + 1]!;
            i += 2;
            continue;
          }
          token += command[i]!;
          i += 1;
        }
        if (i < n && command[i] === quote) i += 1;
        continue;
      }
      token += ch;
      i += 1;
    }
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}

function isModelFlagToken(token: string): boolean {
  return token === "--model" || token.startsWith("--model=");
}

/** Count `--model` / `--model=` flag tokens in launcher-family argv. */
export function countModelFlagsInLauncherArgv(command: string): number {
  const tokens = tokenizeLauncherArgv(command.trim());
  let count = 0;
  for (const token of tokens) {
    if (isModelFlagToken(token)) count += 1;
  }
  return count;
}

/** Parse `--model <slug>` / `--model=<slug>` from launcher-family argv. */
export function extractModelFromLauncherArgv(command: string): string | null {
  const raw = command.trim();
  if (raw.length === 0) return null;
  const tokens = tokenizeLauncherArgv(raw);
  const values: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("--model=")) {
      const value = token.slice("--model=".length).trim();
      if (value.length > 0) values.push(value);
      continue;
    }
    if (token === "--model") {
      const next = tokens[i + 1];
      if (next !== undefined && next.length > 0 && !next.startsWith("-")) {
        values.push(next);
        i += 1;
      }
    }
  }
  if (values.length !== 1) return null;
  return values[0]!;
}

function normalizeRole(role: string | null | undefined): string | null {
  if (role === undefined || role === null) return null;
  const trimmed = role.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSwarmWorkerRole(role: string): boolean {
  return (SWARM_WORKER_ROLES as readonly string[]).includes(role);
}

function isGatedRole(role: string, gatedRoles: readonly string[]): boolean {
  return gatedRoles.includes(role);
}

/**
 * Resolve which role the honor join gates for this spawn class.
 * Implement defaults to leaf-implementation. Explore / process-only /
 * ephemeral without a structural SWARM_WORKER_ROLES gated role are carve-outs
 * after the conjunct runs (subagent_type explore / process_only self-declaration).
 */
export function resolveHonorRole(
  spawnClass: RoutingSpawnClass,
  structuralWorkerRole: string | null | undefined,
  gatedRoles: readonly string[] = ROUTING_GATED_ROLE_DOMAIN,
): { role: string | null; carveOut: boolean; carveOutReason: string | null } {
  const structural = normalizeRole(structuralWorkerRole);
  if (structural !== null && isSwarmWorkerRole(structural) && isGatedRole(structural, gatedRoles)) {
    return { role: structural, carveOut: false, carveOutReason: null };
  }
  // review-monitor / merge-release / orchestrator are SWARM roles outside the
  // gated subset — carve out; do not leaf-fallback (#3703 Greptile P1).
  if (structural !== null && isSwarmWorkerRole(structural)) {
    return {
      role: structural,
      carveOut: true,
      carveOutReason: `non-gated SWARM_WORKER_ROLES role '${structural}' is outside ROUTING_GATED_ROLE_DOMAIN; not leaf-fallback (#3703).`,
    };
  }
  if (spawnClass === "implement" || spawnClass === "launcher-argv") {
    // launcher-argv without a gated structural role honors the leaf route so a
    // dest-bearing implementation CLI cannot skip the pin (#3703 Greptile P1).
    // Process-only critic CLI must pass spawnClass "process-only" instead.
    const fallback = gatedRoles[0] ?? "leaf-implementation";
    return { role: fallback, carveOut: false, carveOutReason: null };
  }
  // Explore / process-only / ephemeral without gated structural role.
  let reason: string;
  if (spawnClass === "explore") {
    reason =
      "explore carve-out: structural subagent_type/worker_role explore without a gated SWARM_WORKER_ROLES role (#3703).";
  } else if (spawnClass === "process-only") {
    reason =
      "process-only/critic carve-out: critics stay outside SWARM_WORKER_ROLES; auditability is the model: lead (#3703).";
  } else {
    reason =
      "ephemeral carve-out: non-lifecycle assist/docs spawn without a gated SWARM_WORKER_ROLES role (#3703).";
  }
  return { role: structural, carveOut: true, carveOutReason: reason };
}

function denyResult(
  partial: Omit<SpawnRoutingHonorResult, "ok" | "code"> & { message: string },
): SpawnRoutingHonorResult {
  return {
    ok: false,
    code: "routing-honor-deny",
    provider: partial.provider,
    role: partial.role,
    resolvedModel: partial.resolvedModel,
    modelSource: partial.modelSource,
    resolution: partial.resolution,
    honoredModel: partial.honoredModel,
    rewriteRequest: false,
    message: partial.message,
  };
}

/**
 * Evaluate whether a spawn request honors the trusted route snapshot.
 * Does not prove the host served that model — only requested-model conformance.
 */
export function evaluateSpawnRoutingHonor(
  request: SpawnRoutingHonorRequest,
): SpawnRoutingHonorResult {
  const environ = request.environ ?? process.env;
  const provider =
    request.provider !== undefined && request.provider !== null && request.provider.length > 0
      ? request.provider
      : resolveDispatchProvider(environ);

  if (request.skipRouting === true) {
    return {
      ok: true,
      code: "routing-honor-skip",
      message: SKIP_ROUTING_RECORD,
      provider,
      role: null,
      resolvedModel: null,
      modelSource: null,
      resolution: null,
      honoredModel: null,
      rewriteRequest: false,
    };
  }

  if (!ROUTING_GATED_DISPATCH_PROVIDERS.has(provider)) {
    return {
      ok: true,
      code: "routing-honor-ungated-provider",
      message: `routing honor: provider '${provider}' is outside ROUTING_GATED_DISPATCH_PROVIDERS; dispatch allowed without honor join.`,
      provider,
      role: null,
      resolvedModel: null,
      modelSource: null,
      resolution: null,
      honoredModel: null,
      rewriteRequest: false,
    };
  }

  const gatedRoles = ROUTING_GATED_ROLE_DOMAIN;
  const roleInfo = resolveHonorRole(request.spawnClass, request.structuralWorkerRole, gatedRoles);
  // Process-only / critic / explore carve-outs keep carve-out even when a
  // launcher argv carries --model; critics stay outside the gated leaf route
  // (model: lead auditability) (#3703 Greptile P1).
  if (roleInfo.carveOut) {
    return {
      ok: true,
      code: "routing-honor-carve-out",
      message: roleInfo.carveOutReason ?? "routing honor carve-out",
      provider,
      role: roleInfo.role,
      resolvedModel: null,
      modelSource: null,
      resolution: null,
      honoredModel: null,
      rewriteRequest: false,
    };
  }

  const role = roleInfo.role ?? gatedRoles[0] ?? "leaf-implementation";
  const gate = verifyRouting({
    projectRoot: request.projectRoot,
    environ,
    provider,
    roles: [role],
  });
  if (gate.exitCode !== EXIT_OK) {
    return denyResult({
      message: gate.report,
      provider,
      role,
      resolvedModel: null,
      modelSource: null,
      resolution: null,
      honoredModel: null,
      rewriteRequest: false,
    });
  }

  const routingPath = resolveRoutingPath(request.projectRoot, environ);
  const { data: routingFile, error } = loadRoutingFile(routingPath);
  if (error !== null) {
    return denyResult({
      message: `routing honor misconfigured: ${error}`,
      provider,
      role,
      resolvedModel: null,
      modelSource: null,
      resolution: null,
      honoredModel: null,
      rewriteRequest: false,
    });
  }

  const resolution = resolveModelRoute(routingFile, provider, role);
  if (!resolution.decided || resolution.source === "invalid") {
    return denyResult({
      message:
        resolution.source === "invalid"
          ? `routing honor misconfigured: ${resolution.error ?? "invalid decision"}`
          : `routing honor: provider '${provider}' role '${role}' is undecided. Decide before spawn.`,
      provider,
      role,
      resolvedModel: null,
      modelSource: null,
      resolution,
      honoredModel: null,
      rewriteRequest: false,
    });
  }

  const harnessBound = HARNESS_BOUND_PROVIDERS.has(provider);
  const harnessDefault =
    resolution.mode === ROUTING_MODE_HARNESS_DEFAULT || resolution.model === null;

  // Harness-bound / explicit harness-default: omit is the decision; a supplied
  // slug would override the operator's no-slug choice (#3703 Greptile P1).
  if (harnessBound || harnessDefault) {
    const requestedHarness =
      request.requestedModel !== undefined && request.requestedModel !== null
        ? request.requestedModel.trim()
        : "";
    if (requestedHarness.length > 0) {
      return denyResult({
        message: `routing honor: provider '${provider}' role '${role}' is harness-default; requested model '${requestedHarness}' is not allowed.`,
        provider,
        role,
        resolvedModel: null,
        modelSource: resolution.source,
        resolution,
        honoredModel: null,
        rewriteRequest: false,
      });
    }
    return {
      ok: true,
      code: "routing-honor-ready",
      message: `routing honor: provider '${provider}' role '${role}' harness-default — requested slug not required (requested≠served still unproven).`,
      provider,
      role,
      resolvedModel: null,
      modelSource: resolution.source,
      resolution,
      honoredModel: null,
      rewriteRequest: false,
    };
  }

  const pinned = resolution.model;
  if (pinned === null || pinned.trim().length === 0) {
    return denyResult({
      message: `routing honor: pinned route for '${provider}.${role}' has empty model.`,
      provider,
      role,
      resolvedModel: null,
      modelSource: resolution.source,
      resolution,
      honoredModel: null,
      rewriteRequest: false,
    });
  }

  const requested =
    request.requestedModel !== undefined && request.requestedModel !== null
      ? request.requestedModel.trim()
      : "";
  const omitted = requested.length === 0;
  const canRewrite = request.canRewriteRequest === true && request.surface === "payload-model";

  if (omitted) {
    if (canRewrite) {
      return {
        ok: true,
        code: "routing-honor-ready",
        message: `routing honor: filling omitted model with pinned '${pinned}' from trusted route (${resolution.source}).`,
        provider,
        role,
        resolvedModel: pinned,
        modelSource: resolution.source,
        resolution,
        honoredModel: pinned,
        rewriteRequest: true,
      };
    }
    const surfaceNote =
      request.surface === "launcher-argv"
        ? "launcher-argv has no --model (argv inspection only; cannot rewrite)."
        : request.surface === "non-intercept"
          ? "host cannot intercept/rewrite spawn model (non-intercept scope)."
          : "spawn omitted model and host cannot rewrite the request.";
    return denyResult({
      message:
        `routing honor denied: pinned route ${provider}.${role}=${pinned} but ${surfaceNote} ` +
        "Silent parent inherit is refused (#3703).",
      provider,
      role,
      resolvedModel: pinned,
      modelSource: resolution.source,
      resolution,
      honoredModel: pinned,
      rewriteRequest: false,
    });
  }

  if (requested !== pinned) {
    return denyResult({
      message:
        `routing honor denied: requested model '${requested}' diverges from pinned ` +
        `${provider}.${role}=${pinned} (resolved-via ${resolution.source}).`,
      provider,
      role,
      resolvedModel: pinned,
      modelSource: resolution.source,
      resolution,
      honoredModel: pinned,
      rewriteRequest: false,
    });
  }

  return {
    ok: true,
    code: "routing-honor-ready",
    message: `routing honor: requested model '${requested}' matches pinned ${provider}.${role} (requested≠served still unproven).`,
    provider,
    role,
    resolvedModel: pinned,
    modelSource: resolution.source,
    resolution,
    honoredModel: pinned,
    rewriteRequest: false,
  };
}

/**
 * P3 interceptor: only invoke submit when the request honors the trusted route.
 * Pinned + omitted/different model never reaches submit on covered paths.
 */
export function submitHonoredSpawn<T>(
  request: SpawnRoutingHonorRequest,
  submit: (binding: HonoredSpawnBinding) => T,
):
  | { readonly reachedSubmit: false; readonly honor: SpawnRoutingHonorResult }
  | {
      readonly reachedSubmit: true;
      readonly honor: SpawnRoutingHonorResult;
      readonly value: T;
    } {
  const honor = evaluateSpawnRoutingHonor(request);
  if (!honor.ok) {
    return { reachedSubmit: false, honor };
  }
  const value = submit({
    model: honor.honoredModel,
    modelSource: honor.modelSource,
    provider: honor.provider,
    role: honor.role,
    resolution: honor.resolution,
  });
  return { reachedSubmit: true, honor, value };
}

export { SKIP_ROUTING_RECORD };
