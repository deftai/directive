#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformCapabilities } from "../intake/platform-capabilities.js";
import { EXIT_CONFIG_ERROR, EXIT_OK } from "./constants.js";
import {
  dispatchProviderFromRuntime,
  HARNESS_BOUND_PROVIDERS,
  ROUTING_MODE_HARNESS_DEFAULT,
  ROUTING_MODE_PINNED,
  resolveRoutingPath,
  SWARM_WORKER_ROLES,
  writeModelDecision,
} from "./routing.js";

export function routingSetMain(argv: string[] = process.argv.slice(2)): number {
  let projectRoot = ".";
  let provider: string | null = null;
  let role: string | null = null;
  let model: string | null = null;
  let harnessDefault = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root" && argv[i + 1] !== undefined) {
      projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg === "--provider" && argv[i + 1] !== undefined) {
      provider = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--role" && argv[i + 1] !== undefined) {
      role = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--model" && argv[i + 1] !== undefined) {
      model = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--harness-default") {
      harnessDefault = true;
    }
  }

  if (role === null || role.length === 0) {
    process.stderr.write(
      `Error: --role <role> is required (one of: ${SWARM_WORKER_ROLES.join(", ")}).\n`,
    );
    return EXIT_CONFIG_ERROR;
  }
  if (!(SWARM_WORKER_ROLES as readonly string[]).includes(role)) {
    process.stderr.write(
      `Error: unknown role '${role}' (one of: ${SWARM_WORKER_ROLES.join(", ")}).\n`,
    );
    return EXIT_CONFIG_ERROR;
  }
  if (!harnessDefault && (model === null || model.trim().length === 0)) {
    process.stderr.write(
      "Error: pass --model <slug> to pin a model, or --harness-default to record an explicit harness default.\n",
    );
    return EXIT_CONFIG_ERROR;
  }

  let resolvedProvider = provider;
  if (resolvedProvider === null || resolvedProvider.length === 0) {
    let runtimeMode = "";
    try {
      runtimeMode = getPlatformCapabilities().runtimeMode;
    } catch {
      runtimeMode = "";
    }
    resolvedProvider = dispatchProviderFromRuntime(runtimeMode);
  }

  if (harnessDefault) {
    if (model !== null) {
      process.stderr.write(
        `Warning: --model '${model}' is ignored because --harness-default was also passed.\n`,
      );
    }
    model = null;
  } else if (HARNESS_BOUND_PROVIDERS.has(resolvedProvider)) {
    process.stderr.write(
      `Error: provider '${resolvedProvider}' is harness-bound -- its model is chosen by the harness, ` +
        "so only --harness-default is recordable here.\n",
    );
    return EXIT_CONFIG_ERROR;
  }

  const path = resolveRoutingPath(resolve(projectRoot));
  writeModelDecision(path, resolvedProvider, role, {
    model,
    mode: harnessDefault ? ROUTING_MODE_HARNESS_DEFAULT : ROUTING_MODE_PINNED,
  });

  const modelText = model ?? "<harness default>";
  process.stdout.write(
    `Recorded route: provider '${resolvedProvider}', role '${role}' -> model ${modelText}.\n` +
      `Route file: ${path}\n`,
  );
  return EXIT_OK;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(routingSetMain());
}
