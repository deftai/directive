import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { GitCommandError, GitNotFoundError, gitStagedFiles, gitTrackedFiles } from "./git.js";
import { BUILTIN_ALLOW_LIST, SCANNABLE_EXTENSIONS } from "./patterns.js";
import { type Finding, renderFinding, scanFile, suffixOf } from "./scan.js";
import { fnmatchCase } from "./text.js";

export type ScanMode = "all" | "staged";

/** Result of an encoding-gate evaluation; mirrors the Python `evaluate` tuple. */
export interface EvaluateResult {
  readonly exitCode: 0 | 1 | 2;
  readonly findings: Finding[];
  readonly message: string;
}

export interface EvaluateOptions {
  readonly mode?: ScanMode;
  readonly allowListPath?: string | null;
}

/** Raised by `loadAllowList` when the path does not exist. */
class AllowListNotFoundError extends Error {}

function loadAllowList(path: string | null | undefined): string[] {
  if (path === null || path === undefined) {
    return [];
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new AllowListNotFoundError(path);
    }
    throw err;
  }
  const out: string[] = [];
  for (const line of raw.split(/\r\n|[\n\r]/)) {
    const stripped = line.trim();
    if (stripped.length === 0 || stripped.startsWith("#")) {
      continue;
    }
    out.push(stripped);
  }
  return out;
}

function isAllowListed(relPath: string, patterns: string[]): boolean {
  return patterns.some((pat) => fnmatchCase(relPath, pat));
}

function isFile(fullPath: string): boolean {
  try {
    return statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

function filterScannable(
  relPaths: string[],
  projectRoot: string,
  allowGlobs: string[],
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const rootResolved = resolve(projectRoot);
  for (const rel of relPaths) {
    const posix = rel.replace(/\\/g, "/");
    const full = resolve(rootResolved, rel);
    const relCheck = relative(rootResolved, full);
    if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
      continue;
    }
    if (!isFile(full)) {
      continue;
    }
    if (!SCANNABLE_EXTENSIONS.has(suffixOf(full))) {
      continue;
    }
    if (isAllowListed(posix, allowGlobs)) {
      continue;
    }
    out.push([posix, full]);
  }
  return out;
}

/**
 * Pure evaluation returning `{ exitCode, findings, message }`. Three-state
 * exit (0 clean / 1 corruption / 2 config error), faithful to the Python
 * `verify_encoding.evaluate`.
 */
export function evaluate(projectRoot: string, options: EvaluateOptions = {}): EvaluateResult {
  const mode: ScanMode = options.mode ?? "all";
  if (mode !== "all" && mode !== "staged") {
    return {
      exitCode: 2,
      findings: [],
      message: `verify_encoding: unrecognised mode '${mode}' (expected 'all' or 'staged').`,
    };
  }

  let customGlobs: string[];
  try {
    customGlobs = loadAllowList(options.allowListPath);
  } catch (err: unknown) {
    if (err instanceof AllowListNotFoundError) {
      return {
        exitCode: 2,
        findings: [],
        message:
          `verify_encoding: --allow-list file not found: ${err.message}\n` +
          "  Recovery: pass an existing path or omit the flag.",
      };
    }
    return {
      exitCode: 2,
      findings: [],
      message:
        `verify_encoding: --allow-list unreadable: ${String((err as Error).message)}\n` +
        "  Recovery: check file permissions.",
    };
  }

  const allowGlobs = [...BUILTIN_ALLOW_LIST, ...customGlobs];

  let relPaths: string[];
  try {
    relPaths = mode === "staged" ? gitStagedFiles(projectRoot) : gitTrackedFiles(projectRoot);
  } catch (err: unknown) {
    if (err instanceof GitNotFoundError) {
      return {
        exitCode: 2,
        findings: [],
        message:
          "verify_encoding: 'git' executable not found on PATH.\n" +
          "  Recovery: install git or run inside a git working tree.",
      };
    }
    if (err instanceof GitCommandError) {
      return {
        exitCode: 2,
        findings: [],
        message:
          `verify_encoding: git failed -- ${err.message}\n` +
          "  Recovery: ensure --project-root points at a git working tree.",
      };
    }
    throw err;
  }

  const candidates = filterScannable(relPaths, projectRoot, allowGlobs);

  const findings: Finding[] = [];
  for (const [rel, full] of candidates) {
    findings.push(...scanFile(rel, full));
  }

  if (findings.length > 0) {
    const fileCount = new Set(findings.map((f) => f.path)).size;
    const header =
      `verify_encoding: detected ${findings.length} mojibake / ` +
      `U+FFFD / unexpected-BOM hit(s) across ${fileCount} file(s) (#798).\n` +
      "  Root cause: a Windows codepage (cp1252/cp437) decoded the bytes on the READ side\n" +
      "  before any safe write could preserve them. Fix: rewrite the offending files with\n" +
      "  UTF-8, re-read from a clean source (git checkout HEAD -- <path>), and do NOT\n" +
      "  round-trip through PowerShell 5.1 again. See AGENTS.md ## PowerShell.\n" +
      "  Allow-list a documented exception via --allow-list <path>.";
    const shown = findings.slice(0, 50).map(renderFinding);
    let body = shown.join("\n");
    if (findings.length > 50) {
      body += `\n  ... and ${findings.length - 50} more`;
    }
    return { exitCode: 1, findings, message: `${header}\n${body}` };
  }

  return {
    exitCode: 0,
    findings,
    message:
      `verify_encoding: ${candidates.length} file(s) clean -- no mojibake / ` +
      "U+FFFD / unexpected-BOM detected (#798).",
  };
}
