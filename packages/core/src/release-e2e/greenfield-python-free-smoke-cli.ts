#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rehearseGreenfieldPythonFreeSmoke } from "./greenfield-python-free-smoke.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const [ok, reason] = rehearseGreenfieldPythonFreeSmoke(repoRoot);
process.stdout.write(`${reason}\n`);
process.exit(ok ? 0 : 1);
