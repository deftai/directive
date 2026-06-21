#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { verifyRouting } from "./routing-verify.js";

export function routingVerifyMain(argv: string[] = process.argv.slice(2)): number {
  let projectRoot = ".";
  let advise = false;
  let provider: string | null = null;
  const roles: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
