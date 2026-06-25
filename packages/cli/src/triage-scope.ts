#!/usr/bin/env node
/**
 * Thin CLI entry for triage:scope (#1725).
 * Delegates to the core implementation at packages/core/dist/triage/scope/cli.js.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// Resolve the core CLI by its published package name so it works both in the
// source monorepo and under a flattened npm install (#1993). The bare specifier
// resolves via @deftai/directive-core's "./dist/*.js" export map; a hand-built
// relative path would point at the non-existent "@deftai/core" once published.
function coreCliPath(): string {
  return require.resolve("@deftai/directive-core/dist/triage/scope/cli.js");
}

/** Run triage:scope with argv; returns process exit code. */
export function run(argv: string[]): number {
  const result = spawnSync(process.execPath, [coreCliPath(), ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.status ?? 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
