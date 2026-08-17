/**
 * Python-free deposit hygiene (#2022 Phase 3).
 *
 * After copying @deftai/directive-content into `.deft/core`, strip any
 * Python-only artifacts that must not ship to npm consumers: the legacy
 * `scripts/` tree, `.py` files, and Python `run` shims.
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { containedRemove } from "../fs/contained-write.js";

const PY_SUFFIX = ".py";
const PYC_SUFFIX = ".pyc";

export interface PythonArtifact {
  readonly path: string;
  readonly kind: "py-file" | "scripts-tree" | "run-shim";
}

function isPythonRunShim(_path: string, head: string): boolean {
  if (!head.startsWith("#!")) return false;
  const bang = head.split("\n", 1)[0] ?? head;
  return /python/i.test(bang);
}

function walkForPyFilesSync(root: string, base: string, found: PythonArtifact[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        found.push({ path: relative(base, full), kind: "py-file" });
        continue;
      }
      walkForPyFilesSync(full, base, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(PY_SUFFIX) || entry.name.endsWith(PYC_SUFFIX)) {
      found.push({ path: relative(base, full), kind: "py-file" });
    }
  }
}

/** List Python-only artifacts under a deposit root (relative paths). */
export function collectPythonArtifacts(depositDir: string): PythonArtifact[] {
  const found: PythonArtifact[] = [];
  const scriptsDir = join(depositDir, "scripts");
  try {
    if (statSync(scriptsDir).isDirectory()) {
      found.push({ path: "scripts", kind: "scripts-tree" });
    }
  } catch {
    // absent
  }

  const runPath = join(depositDir, "run");
  if (existsSync(runPath)) {
    try {
      const head = readFileSync(runPath, "utf8");
      if (isPythonRunShim(runPath, head.slice(0, 200))) {
        found.push({ path: "run", kind: "run-shim" });
      }
    } catch {
      found.push({ path: "run", kind: "run-shim" });
    }
  }

  walkForPyFilesSync(depositDir, depositDir, found);
  return found;
}

/** Return true when a repo-root `run` file is a Python launcher shim. */
export function isRepoRootPythonRunShim(projectDir: string): boolean {
  const runPath = join(projectDir, "run");
  if (!existsSync(runPath)) return false;
  try {
    const head = readFileSync(runPath, "utf8").slice(0, 200);
    return isPythonRunShim(runPath, head);
  } catch {
    return true;
  }
}

export interface PrunePythonArtifactsIo {
  printf: (text: string) => void;
}

function removeContained(projectDir: string, target: string, recursive = false): boolean {
  return containedRemove({ root: projectDir, target, recursive }).removed;
}

/** Remove Python-only trees/files from the consumer deposit and repo-root run shim. */
export async function prunePythonArtifactsFromDeposit(
  depositDir: string,
  projectDir: string,
  io?: PrunePythonArtifactsIo,
): Promise<number> {
  let removed = 0;

  const scriptsDir = join(depositDir, "scripts");
  try {
    if ((await stat(scriptsDir)).isDirectory()) {
      if (removeContained(projectDir, scriptsDir, true)) {
        removed += 1;
        io?.printf("Removed Python scripts/ tree from the consumer deposit (#2022 Phase 3).\n");
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  async function walkRemovePy(root: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") {
          if (removeContained(projectDir, full, true)) removed += 1;
          continue;
        }
        await walkRemovePy(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(PY_SUFFIX) || entry.name.endsWith(PYC_SUFFIX)) {
        if (removeContained(projectDir, full)) removed += 1;
      }
    }
  }

  await walkRemovePy(depositDir);

  const depositRun = join(depositDir, "run");
  if (existsSync(depositRun)) {
    try {
      const head = await readFile(depositRun, "utf8");
      if (isPythonRunShim(depositRun, head.slice(0, 200))) {
        if (removeContained(projectDir, depositRun)) {
          removed += 1;
          io?.printf("Removed Python run shim from .deft/core (#2022 Phase 3).\n");
        }
      }
    } catch {
      if (removeContained(projectDir, depositRun)) removed += 1;
    }
  }

  const projectRun = join(projectDir, "run");
  if (isRepoRootPythonRunShim(projectDir)) {
    if (removeContained(projectDir, projectRun)) {
      removed += 1;
      io?.printf("Removed repo-root Python run shim (#2022 Phase 3).\n");
    }
  }

  return removed;
}
