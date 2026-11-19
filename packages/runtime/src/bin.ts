#!/usr/bin/env node
/**
 * Runtime product entry + Contract 1 bookend stubs (YOLO Wave 1d).
 * Launcher spawns this file under node_modules/@deftai/directive-runtime/dist/bin.js.
 */
import {
  runtimeCommandProjectRoot,
  runtimeIdentityRefusal,
} from "@deftai/directive-core/dist/install-health/cheap.js";
import { routeAndDispatch } from "./cli-router/index.js";
import { handleContractEntrypoint } from "./contract-entry.js";
import { maybeSelfCompleteSetup } from "./self-complete.js";

const argv = process.argv.slice(2);
const contractCode = await handleContractEntrypoint(argv);
if (contractCode !== null) {
  process.exit(contractCode);
}

const projectRoot = process.env.DIRECTIVE_PROJECT_ROOT ?? process.cwd();

// AC2.6 (#6620): the runtime checks itself, however it was started (launcher,
// git hook, Taskfile). Installed ≠ pin → no setup, no command, exit 1. An
// explicit --project-root names the project the command acts on.
const refusal = runtimeIdentityRefusal(runtimeCommandProjectRoot(argv, projectRoot), argv);
if (refusal !== null) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}

// Wave 2d / AC8.6: eligible ordinary commands self-complete local wiring when
// readiness is missing/stale. Installation-management and doctor skip this.
maybeSelfCompleteSetup(projectRoot, { argv });

const code = await routeAndDispatch(argv);
process.exit(code);
