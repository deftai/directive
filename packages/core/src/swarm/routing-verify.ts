/**
 * verify:routing gate (#1739). Two postures over the same route file:
 *   - advise (session-start): surface unset routing as a disclosure line,
 *     never blocks (always exit 0).
 *   - enforce (pre-dispatch): a hard gate in the pre-`start_agent` /
 *     `swarm:launch` gate stack. Three-state exit:
 *       0 = every in-scope role is decided (pinned or explicit harness-default)
 *       1 = at least one in-scope role is undecided / not dispatchable
 *       2 = config error (unreadable / malformed route file)
 */
import { getPlatformCapabilities } from "../intake/platform-capabilities.js";
import { EXIT_CONFIG_ERROR, EXIT_GATE_FAILED, EXIT_OK } from "./constants.js";
import {
  dispatchProviderFromRuntime,
  HARNESS_BOUND_PROVIDERS,
  loadRoutingFile,
  ROUTING_MODE_HARNESS_DEFAULT,
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
  /** Inject the runtime descriptor (else getPlatformCapabilities().runtimeMode). */
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
  const probe = options.runtimeProbe ?? (() => getPlatformCapabilities().runtimeMode);
  let runtimeMode = "";
  try {
    runtimeMode = probe();
  } catch {
    runtimeMode = "";
  }
  return dispatchProviderFromRuntime(runtimeMode);
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

  if (invalid.length > 0 && !options.advise) {
    return {
      exitCode: EXIT_CONFIG_ERROR,
      report: `routing gate misconfigured for provider '${provider}':\n${invalid.map((l) => `  - ${l}`).join("\n")}`,
    };
  }

  if (options.advise) {
    if (undecided.length === 0 && invalid.length === 0) {
      return {
        exitCode: EXIT_OK,
        report: `[deft routing] provider '${provider}': all ${roles.length} gated role(s) decided.`,
      };
    }
    const parts: string[] = [];
    if (undecided.length > 0) {
      parts.push(`undecided role(s): ${undecided.join(", ")}`);
    }
    if (invalid.length > 0) {
      parts.push(`invalid: ${invalid.length}`);
    }
    return {
      exitCode: EXIT_OK,
      report: `[deft routing] provider '${provider}' -- ${parts.join("; ")}. Decide before swarm dispatch: ${ROUTING_SET_CMD}`,
    };
  }

  if (undecided.length > 0) {
    return {
      exitCode: EXIT_GATE_FAILED,
      report:
        `routing gate: provider '${provider}' has undecided role(s): ${undecided.join(", ")}.\n` +
        "Every dispatched role needs an explicit decision (pin a model or choose the harness default).\n" +
        `Decide: ${ROUTING_SET_CMD}`,
    };
  }

  return {
    exitCode: EXIT_OK,
    report: `routing gate: provider '${provider}' -- all gated role(s) decided.\n${resolvedLines.join("\n")}`,
  };
}
