#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { EXIT_CONFIG_ERROR, EXIT_OK } from "./constants.js";
import { SWARM_WORKER_ROLES } from "./routing.js";
import { routingGatedProvidersHelpList } from "./routing-honor.js";
import { verifyRouting } from "./routing-verify.js";

const HELP_TEXT = `usage: swarm-routing-verify [--project-root PATH] [--advise] [--provider NAME]
                            [--roles ROLE[,ROLE...]] [--help]

Pre-dispatch routing gate (#1739 / #3703). Enforce (default) fails when a gated
role is undecided for the active provider. --advise is non-blocking disclosure
only (session-start additive; does not relieve honor-at-dispatch).

Gated providers (ROUTING_GATED_DISPATCH_PROVIDERS): ${routingGatedProvidersHelpList()}.
Narrower than LAUNCHER_FAMILIES (codex is argv-class only). Default gated role
subset: leaf-implementation (explicit subset of SWARM_WORKER_ROLES; critics
stay outside the enum).
`;

export function routingVerifyMain(argv: string[] = process.argv.slice(2)): number {
  let projectRoot = ".";
  let advise = false;
  let provider: string | null = null;
  const roles: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP_TEXT);
      return EXIT_OK;
    }
    if (arg === "--project-root" && argv[i + 1] !== undefined) {
      projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg === "--advise") {
      advise = true;
    } else if (arg === "--provider" && argv[i + 1] !== undefined) {
      provider = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--roles" && argv[i + 1] !== undefined) {
      for (const role of (argv[i + 1] ?? "").split(",")) {
        if (role.trim().length > 0) {
          roles.push(role.trim());
        }
      }
      i += 1;
    }
  }
  for (const role of roles) {
    if (!(SWARM_WORKER_ROLES as readonly string[]).includes(role)) {
      process.stderr.write(
        `Error: unknown role '${role}' (one of: ${SWARM_WORKER_ROLES.join(", ")}).\n`,
      );
      return EXIT_CONFIG_ERROR;
    }
  }
  const result = verifyRouting({
    projectRoot,
    advise,
    provider,
    roles: roles.length > 0 ? roles : undefined,
  });
  process.stdout.write(`${result.report}\n`);
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(routingVerifyMain());
}
