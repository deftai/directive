#!/usr/bin/env node
/**
 * Global `deft-hook` bin on the launcher package (AC3.5).
 * Host configs should use `node node_modules/@deftai/directive-runtime/dist/hook-bin.js`.
 * This PATH binary discovers the project runtime hook and spawns it, or prints recovery.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EXIT_CODES, RECOVERY_GUIDANCE, RUNTIME_PACKAGE_NAME } from "./constants.js";
import { discoverProject } from "./discover.js";
import { checkNodeVersion } from "./node-check.js";
import { readInstalledRuntime } from "./pin.js";

function main(argv: string[]): number {
  const node = checkNodeVersion();
  if (!node.ok) {
    process.stderr.write(`${node.message}\n`);
    return node.exitCode;
  }

  const discovered = discoverProject({ cwd: process.cwd() });
  if (!discovered.ok) {
    process.stderr.write(
      `deft-hook: no project root. Host hooks should call ` +
        `node node_modules/${RUNTIME_PACKAGE_NAME}/dist/hook-bin.js\n` +
        `Recovery: ${RECOVERY_GUIDANCE}\n`,
    );
    return EXIT_CODES.FAILURE;
  }

  const runtime = readInstalledRuntime(discovered.root);
  if (runtime === null) {
    process.stderr.write(
      `deft-hook: ${RUNTIME_PACKAGE_NAME} not installed in ${discovered.root}.\n` +
        `Recovery: ${RECOVERY_GUIDANCE}\n`,
    );
    return EXIT_CODES.FAILURE;
  }

  const hookEntry = join(
    discovered.root,
    "node_modules",
    ...RUNTIME_PACKAGE_NAME.split("/"),
    "dist",
    "hook-bin.js",
  );
  if (!existsSync(hookEntry)) {
    process.stderr.write(`deft-hook: missing ${hookEntry}\nRecovery: ${RECOVERY_GUIDANCE}\n`);
    return EXIT_CODES.FAILURE;
  }

  const result = spawnSync(process.execPath, [hookEntry, ...argv], {
    cwd: discovered.root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(`deft-hook: failed to start runtime hook: ${result.error.message}\n`);
    return EXIT_CODES.FAILURE;
  }
  if (result.status === null && result.signal) return EXIT_CODES.INTERRUPTED;
  return result.status ?? EXIT_CODES.FAILURE;
}

process.exit(main(process.argv.slice(2)));
