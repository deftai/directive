/**
 * @deprecated This module is superseded by per-role operator model routing
 * (`.deft/routing.local.json`) introduced in #1739 / #1863.
 *
 * Use `task swarm:routing-set` and `task verify:routing` instead.
 * See `packages/core/src/swarm/routing.ts` for the current implementation.
 *
 * The enum and associated helpers remain functional for consumers that have not
 * yet migrated; they will be removed in a future major cleanup tracked by #1860.
 *
 * @see {@link https://github.com/deftai/directive/issues/1739} Superseding PR
 * @see {@link https://github.com/deftai/directive/issues/1860} Hard deletion tracking
 */

import { loadProjectDefinition } from "../policy/resolve.js";
import { LEAF_CODING_WORKER_ROLE, SUBAGENT_BACKEND_SET_CMD } from "./constants.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** @deprecated Superseded by `.deft/routing.local.json` routing (#1739). Use `task swarm:routing-set`. */
export const KNOWN_SUBAGENT_BACKEND_IDS = new Set(["composer", "grok-build", "cursor-cloud"]);

const SUBAGENT_BACKEND_CATALOG: Record<string, { display_name: string; roles: readonly string[] }> =
  {
    composer: {
      display_name: "Composer-class coding agent",
      roles: ["leaf-implementation"],
    },
    "grok-build": {
      display_name: "Grok Build (spawn_subagent)",
      roles: ["leaf-implementation", "review-monitor"],
    },
    "cursor-cloud": {
      display_name: "Cursor / cloud agent",
      roles: ["leaf-implementation", "orchestrator", "review-monitor"],
    },
  };

/** @deprecated Superseded by `.deft/routing.local.json` routing (#1739). Use `task swarm:routing-set`. */
export interface SubagentBackendDescriptor {
  readonly backend_id: string;
  readonly display_name: string;
  readonly roles: readonly string[];
  readonly available: boolean;
}

/** @deprecated Superseded by `.deft/routing.local.json` routing (#1739). Use `task swarm:routing-set`. */
export interface SwarmSubagentBackendResult {
  readonly backend_id: string | null;
  readonly source: string;
  readonly error: string | null;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

function probeBackendAvailable(
  backendId: string,
  environ: NodeJS.ProcessEnv = process.env,
): boolean {
  const envKey = `DEFT_PROBE_${backendId.toUpperCase().replace(/-/g, "_")}`;
  const override = environ[envKey];
  if (override !== undefined) {
    return isTruthy(override);
  }
  if (backendId === "grok-build") {
    const runtime = environ.DEFT_AGENT_RUNTIME?.trim().toLowerCase() ?? "";
    return isTruthy(environ.GROK_BUILD) || runtime === "grok-build";
  }
  if (backendId === "composer") {
    return isTruthy(environ.CURSOR_COMPOSER);
  }
  if (backendId === "cursor-cloud") {
    return isTruthy(environ.CURSOR_AGENT);
  }
  return false;
}

export function probeSubagentBackends(
  environ: NodeJS.ProcessEnv = process.env,
): SubagentBackendDescriptor[] {
  return [...KNOWN_SUBAGENT_BACKEND_IDS].sort().map((backendId) => {
    const meta = SUBAGENT_BACKEND_CATALOG[backendId];
    return {
      backend_id: backendId,
      display_name: meta?.display_name ?? backendId,
      roles: meta?.roles ?? [],
      available: probeBackendAvailable(backendId, environ),
    };
  });
}

function getPolicyBlock(data: Record<string, unknown>): Record<string, unknown> {
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {};
  }
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return {};
  }
  return policy as Record<string, unknown>;
}

export function resolveSwarmSubagentBackend(projectRoot: string): SwarmSubagentBackendResult {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return { backend_id: null, source: "default", error: err };
  }
  const policyBlock = getPolicyBlock(data);
  if (!("swarmSubagentBackend" in policyBlock)) {
    return { backend_id: null, source: "default", error: null };
  }
  const raw = policyBlock.swarmSubagentBackend;
  if (raw === null) {
    return {
      backend_id: null,
      source: "typed",
      error: "plan.policy.swarmSubagentBackend is explicitly null.",
    };
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      backend_id: null,
      source: "typed",
      error: `plan.policy.swarmSubagentBackend must be a non-empty string; got ${typeof raw}`,
    };
  }
  const bid = raw.trim();
  if (!KNOWN_SUBAGENT_BACKEND_IDS.has(bid)) {
    return {
      backend_id: bid,
      source: "typed",
      error:
        `plan.policy.swarmSubagentBackend must be one of ` +
        `${JSON.stringify([...KNOWN_SUBAGENT_BACKEND_IDS].sort())}; got ${JSON.stringify(bid)}`,
    };
  }
  return { backend_id: bid, source: "typed", error: null };
}

function formatProbedBackends(backends: readonly SubagentBackendDescriptor[]): string {
  return backends
    .map((entry) => {
      const avail = entry.available ? "available" : "unavailable";
      return `  ${entry.backend_id} (${avail}; roles=[${entry.roles.join(", ")}])`;
    })
    .join("\n");
}

const DISPATCH_PROVIDER_BY_BACKEND: Record<string, string> = {
  composer: "cursor",
  "grok-build": "grok",
  "cursor-cloud": "cursor",
};

export function dispatchProviderFor(backendId: string): string {
  return DISPATCH_PROVIDER_BY_BACKEND[backendId] ?? backendId;
}

export function enforceSubagentBackendPolicy(
  projectRoot: string,
  environ: NodeJS.ProcessEnv = process.env,
): { backend: SubagentBackendDescriptor | null; error: string | null } {
  const result = resolveSwarmSubagentBackend(projectRoot);
  const probed = probeSubagentBackends(environ);

  if (result.backend_id === null) {
    const detail = result.error ?? "plan.policy.swarmSubagentBackend is not set.";
    const listing = formatProbedBackends(probed);
    return {
      backend: null,
      error:
        `${detail}\n` +
        "Select a coding sub-agent backend before headless dispatch:\n" +
        `${listing}\n` +
        "Probe harness availability: task policy:subagent-backends\n" +
        `Persist a choice: ${SUBAGENT_BACKEND_SET_CMD.replace("{backend_id}", "<id>")}`,
    };
  }

  const selected = probed.find((e) => e.backend_id === result.backend_id) ?? null;
  if (selected === null) {
    const known = probed.map((e) => e.backend_id).join(", ");
    return {
      backend: null,
      error:
        `plan.policy.swarmSubagentBackend=${JSON.stringify(result.backend_id)} is not a ` +
        `known backend id (known: ${known}).\n` +
        `Persist a valid choice: ${SUBAGENT_BACKEND_SET_CMD.replace("{backend_id}", "<id>")}`,
    };
  }

  if (!selected.available) {
    const availableIds = probed.filter((e) => e.available).map((e) => e.backend_id);
    const availText = availableIds.length > 0 ? availableIds.join(", ") : "(none)";
    return {
      backend: null,
      error:
        `plan.policy.swarmSubagentBackend=${JSON.stringify(result.backend_id)} is ` +
        "unavailable in the current harness.\n" +
        `Available backend ids: ${availText}\n` +
        `Choose a different backend: ${SUBAGENT_BACKEND_SET_CMD.replace("{backend_id}", "<id>")}`,
    };
  }

  if (!selected.roles.includes(LEAF_CODING_WORKER_ROLE)) {
    const rolesText = selected.roles.length > 0 ? selected.roles.join(", ") : "(none)";
    return {
      backend: null,
      error:
        `plan.policy.swarmSubagentBackend=${JSON.stringify(result.backend_id)} does not ` +
        `support worker role ${JSON.stringify(LEAF_CODING_WORKER_ROLE)} ` +
        `(roles=[${rolesText}]).\n` +
        `Choose a leaf-implementation backend: ${SUBAGENT_BACKEND_SET_CMD.replace("{backend_id}", "<id>")}`,
    };
  }

  return { backend: selected, error: null };
}

export { LEAF_CODING_WORKER_ROLE };
