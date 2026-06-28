#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rehearseGreenfieldPythonFreeSmoke } from "./greenfield-python-free-smoke.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const skipWorkspacePrep = process.env.DEFT_GREENFIELD_SKIP_PREP === "1";
const [ok, reason] = rehearseGreenfieldPythonFreeSmoke(repoRoot, {}, { skipWorkspacePrep });
process.stdout.write(`${reason}\n`);
process.exit(ok ? 0 : 1);
