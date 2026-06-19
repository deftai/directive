import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFT_REPO_POSITIVE_MARKERS } from "./constants.js";

/** Resolve a user-supplied path string to an absolute path. */
export function resolvePath(pathStr: string, cwd = process.cwd()): string {
  if (!pathStr) {
    return cwd;
  }
  const expanded = pathStr.startsWith("~")
    ? join(process.env.HOME ?? cwd, pathStr.slice(1))
    : pathStr;
  return resolve(cwd, expanded);
}

/** Best-effort version string (mirrors Python `_resolve_version`). */
export function resolveVersion(frameworkRoot?: string): string {
  const root = frameworkRoot ?? resolveDefaultFrameworkRoot();
  const candidates = [
    join(root, "VERSION"),
    join(root, "scripts", "VERSION"),
    join(process.cwd(), ".deft-version"),
  ];
  for (const cand of candidates) {
    try {
      if (existsSync(cand)) {
        return readFileSync(cand, "utf8").trim();
      }
    } catch {
      // continue
    }
  }
  return "dev";
}

/** Return the deft framework repo root (the directory containing `main.md`). */
export function resolveDefaultFrameworkRoot(): string {
  const envRoot = process.env.DEFT_ROOT?.trim();
  if (envRoot) {
    return resolve(envRoot);
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "main.md")) && existsSync(join(dir, "templates", "agents-entry.md"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/** Directory containing doctor implementation (Python: scripts/). */
export function resolveScriptDir(frameworkRoot?: string): string {
  return join(frameworkRoot ?? resolveDefaultFrameworkRoot(), "scripts");
}

export function readTextSafe(path: string, readText = defaultReadText): string | null {
  return readText(path);
}

function defaultReadText(path: string): string | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function runningInsideDeftRepo(
  projectRoot: string,
  seams: { isDir?: (p: string) => boolean; isFile?: (p: string) => boolean } = {},
): boolean {
  const fileCheck = seams.isFile ?? defaultIsFile;
  const dirCheck = seams.isDir ?? defaultIsDir;

  if (!fileCheck(join(projectRoot, "main.md"))) {
    return false;
  }
  if (dirCheck(join(projectRoot, "deft"))) {
    return false;
  }
  if (dirCheck(join(projectRoot, ".deft", "core"))) {
    return false;
  }
  return DEFT_REPO_POSITIVE_MARKERS.every((m) => fileCheck(join(projectRoot, m)));
}
