/**
 * verify:routing gate (#1739). Two postures over the same route file:
 *   - advise (session-start): surface unset routing as a disclosure line,
 *     never blocks (always exit 0).
 *   - enforce (pre-dispatch): a hard gate in the pre-`start_agent` /
 *     `swarm:launch` gate stack. Three-state exit:
 *       0 = every in-scope role is decided (pinned or explicit harness-default)
 *           OR provider is unrecognized (`unknown`) -- disclosure, not a gate (#3469)
 *       1 = at least one in-scope role is undecided / not dispatchable
 *       2 = config error (unreadable / malformed route file)
 *     Unrecognized host never exits 1/2 solely because the host was unknown.
 */
import { EXIT_CONFIG_ERROR, EXIT_GATE_FAILED, EXIT_OK } from "./constants.js";
import {
  dispatchProviderFromRuntime,
  emptyHostDetectProbes,
  HARNESS_BOUND_PROVIDERS,
  loadRoutingFile,
  ROUTING_MODE_HARNESS_DEFAULT,
  type RoutingFile,
  resolveDispatchProvider,
  resolveModelRoute,
  resolveRoutingPath,
} from "./routing.js";

export const ROUTING_SET_CMD =
  "task swarm:routing-set -- --role <role> --model <slug>   (or --harness-default)";

/** Roles the pre-dispatch gate checks by default: the actual model lever. */
export const DEFAULT_GATED_ROLES = ["leaf-implementation"] as const;

export interface VerifyRoutingOptions {
  projectRoot: string;
  environ?: NodeJS.ProcessEnv;
  roles?: readonly string[];
  /** Session-start posture: surface, never block. */
  advise?: boolean;
  /** Override the resolved provider (else derived from the runtime). */
  provider?: string | null;
  /** Inject the runtime descriptor (legacy test seam; else resolveDispatchProvider). */
  runtimeProbe?: () => string;
}

export interface VerifyRoutingResult {
  exitCode: number;
  report: string;
}

function resolveProvider(options: VerifyRoutingOptions): string {
  if (options.provider !== undefined && options.provider !== null && options.provider.length > 0) {
    return options.provider;
  }
  if (options.runtimeProbe !== undefined) {
    let runtimeMode = "";
    try {
      runtimeMode = options.runtimeProbe();
    } catch {
      runtimeMode = "";
    }
    return dispatchProviderFromRuntime(runtimeMode);
  }
  return resolveDispatchProvider(options.environ ?? process.env);
}

function isUnrecognizedHost(provider: string): boolean {
  return provider === "unknown";
}

function formatUsedPin(file: RoutingFile | null, provider: string, role: string): string {
  const resolution = resolveModelRoute(file, provider, role);
  if (resolution.decided && resolution.source !== "invalid") {
    const value = resolution.model ?? "harness-default";
    return `${provider}.${role}=${value}`;
  }
  return `inherit (no ${provider}.${role} pin)`;
}

/**
 * Dedicated host-unrecognized honesty line (#3469). Disclosure, not a gate:
 * names the empty probes, that dispatch is still allowed, and the pin or
 * inherit that will be used. Must not be folded into "all roles decided."
 */
export function formatHostUnrecognizedHonestyLine(options: {
  environ?: NodeJS.ProcessEnv;
  provider: string;
  roles: readonly string[];
  file: RoutingFile | null;
}): string {
  const empty = emptyHostDetectProbes(options.environ ?? process.env);
  const emptyText = empty.length > 0 ? empty.join(", ") : "(none)";
  const used = options.roles.map((role) => formatUsedPin(options.file, options.provider, role));
  return (
    `[deft routing] host unrecognized (#3469): empty probes: ${emptyText}. ` +
    `Dispatch still allowed. Using ${used.join("; ")}.`
  );
}

export function verifyRouting(options: VerifyRoutingOptions): VerifyRoutingResult {
  const roles = options.roles && options.roles.length > 0 ? options.roles : DEFAULT_GATED_ROLES;
  const provider = resolveProvider(options);
  const routingPath = resolveRoutingPath(options.projectRoot, options.environ);
  const { data, error } = loadRoutingFile(routingPath);

  if (error !== null) {
    if (options.advise) {
      return {
        exitCode: EXIT_OK,
        report: `[deft routing] route file unreadable (${error}); pre-dispatch gate will block until fixed.`,
      };
    }
    return { exitCode: EXIT_CONFIG_ERROR, report: `routing gate misconfigured: ${error}` };
  }

  const undecided: string[] = [];
  const invalid: string[] = [];
  const resolvedLines: string[] = [];
  const harnessBound = HARNESS_BOUND_PROVIDERS.has(provider);

  for (const role of roles) {
    const resolution = resolveModelRoute(data, provider, role);
    if (!resolution.decided) {
      undecided.push(role);
      continue;
    }
    if (resolution.source === "invalid") {
      invalid.push(`${role}: ${resolution.error ?? "invalid decision"}`);
      continue;
    }
    if (harnessBound && resolution.mode !== ROUTING_MODE_HARNESS_DEFAULT) {
      invalid.push(
        `${role}: provider '${provider}' is harness-bound -- only mode=harness-default is recordable (cannot pin model '${resolution.model ?? ""}').`,
      );
      continue;
    }
    const modelText = resolution.model ?? "<runtime default>";
    resolvedLines.push(`  ${role}: model ${modelText} (resolved-via ${resolution.source})`);
  }

  const unrecognized = isUnrecognizedHost(provider);
  const honesty = unrecognized
    ? formatHostUnrecognizedHonestyLine({
        environ: options.environ ?? process.env,
        provider,
        roles,
        file: data,
      })
    : "";

  if (invalid.length > 0 && !options.advise) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      report: `routing gate misconfigured for provider '${provider}':\n${invalid.map((l) => `  - ${l}`).join("\n")}`,
    };
  }

  if (options.advise) {
    const note =
      "[deft routing] NOTE: plan.policy.swarmSubagentBackend enum is deprecated (#1891); use 'task swarm:routing-set' / .deft/routing.local.json instead.";
    let body: string;
    if (undecided.length === 0 && invalid.length === 0) {
      body = `[deft routing] provider '${provider}': all ${roles.length} gated role(s) decided.`;
    } else {
      const parts: string[] = [];
      if (undecided.length > 0) {
        parts.push(`undecided role(s): ${undecided.join(", ")}`);
      }
      if (invalid.length > 0) {
        parts.push(`invalid: ${invalid.length}`);
      }
      // Unrecognized host is disclosure: do not force routing-set (#3469).
      const decide = unrecognized
        ? "Dispatch still allowed."
        : `Decide before swarm dispatch: ${ROUTING_SET_CMD}`;
      body = `[deft routing] provider '${provider}' -- ${parts.join("; ")}. ${decide}`;
    }
    const report = honesty.length > 0 ? `${honesty}\n${body}\n${note}` : `${body}\n${note}`;
    return { exitCode: EXIT_OK, report };
  }

  if (undecided.length > 0 && !unrecognized) {
    return {
      exitCode: EXIT_GATE_FAILED,
      report:
        `routing gate: provider '${provider}' has undecided role(s): ${undecided.join(", ")}.\n` +
        "Every dispatched role needs an explicit decision (pin a model or choose the harness default).\n" +
        `Decide: ${ROUTING_SET_CMD}`,
    };
  }

  const decidedBody =
    undecided.length > 0
      ? `routing gate: provider '${provider}' -- dispatch allowed (host unrecognized is disclosure, not a gate).`
      : `routing gate: provider '${provider}' -- all gated role(s) decided.\n${resolvedLines.join("\n")}`;
  const report = honesty.length > 0 ? `${honesty}\n${decidedBody}` : decidedBody;
  return { exitCode: EXIT_OK, report };
}
