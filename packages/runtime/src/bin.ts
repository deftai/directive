#!/usr/bin/env node
/**
 * Runtime product entry + Contract 1 bookend stubs (YOLO Wave 1d).
 * Launcher spawns this file under node_modules/@deftai/directive-runtime/dist/bin.js.
 */
import { routeAndDispatch } from "./cli-router/index.js";
import { handleContractEntrypoint } from "./contract-entry.js";
import { maybeSelfCompleteSetup } from "./self-complete.js";

const argv = process.argv.slice(2);
const contractCode = handleContractEntrypoint(argv);
if (contractCode !== null) {
  process.exit(contractCode);
}

// Wave 2d / AC8.6: eligible ordinary commands self-complete local wiring when
// readiness is missing/stale. Installation-management and doctor skip this.
const projectRoot = process.env.DIRECTIVE_PROJECT_ROOT ?? process.cwd();
maybeSelfCompleteSetup(projectRoot, { argv });

const code = await routeAndDispatch(argv);
process.exit(code);
