#!/usr/bin/env node
/**
 * Runtime product entry + Contract 1 bookend stubs (YOLO Wave 1d).
 * Launcher spawns this file under node_modules/@deftai/directive-runtime/dist/bin.js.
 */
import { routeAndDispatch } from "./cli-router/index.js";
import { handleContractEntrypoint } from "./contract-entry.js";

const argv = process.argv.slice(2);
const contractCode = handleContractEntrypoint(argv);
if (contractCode !== null) {
  process.exit(contractCode);
}

const code = await routeAndDispatch(argv);
process.exit(code);
