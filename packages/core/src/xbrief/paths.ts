/**
 * Portable path expand + project-root containment for xbrief:create/verify (#3057).
 *
 * Uses real path APIs (node:path / node:os) — no slash-only logic.
 * Default containment under project root fails closed on escape.
 */

import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  resolveContainedTarget,
} from "../fs/contained-write.js";
import type { XbriefFormat, XbriefPaths } from "./types.js";

export class XbriefPathError extends Error {
  readonly code: string;

  constructor(message: string, code = "XBRIEF_PATH_ERROR") {
    super(message);
    this.name = "XbriefPathError";
    this.code = code;
  }
}

/**
 * Expand simple user path forms portably:
 * - `~` / `~/…` / `~\…` → home directory
 * - `%VAR%` (Windows-class env expansion) when present in the string
 *
 * Relative paths are left relative (caller resolves against project root or cwd).
 */
export function expandUserPath(
  input: string,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  if (input.length === 0) {
    throw new XbriefPathError("empty path", "XBRIEF_PATH_EMPTY");
  }
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  let expanded = input.replace(/%([^%]+)%/g, (match, name: string) => {
    const value = env[name];
    return value !== undefined && value.length > 0 ? value : match;
  });

  if (expanded === "~") {
    expanded = home;
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(home, expanded.slice(2));
  }

  return normalize(expanded);
}

/** Strip known xBRIEF suffixes to recover a write stem. */
export function stripXbriefSuffix(pathLike: string): string {
  const lower = pathLike.toLowerCase();
  if (lower.endsWith(".xbrief.json")) {
    return pathLike.slice(0, -".xbrief.json".length);
  }
  if (lower.endsWith(".xbrief.md")) {
    return pathLike.slice(0, -".xbrief.md".length);
  }
  return pathLike;
}

/**
 * Resolve `--out` under `projectRoot` with user-path expansion and fail-closed
 * containment. Returns absolute stem + format-specific artifact paths.
 */
export function resolveXbriefOutPaths(input: {
  projectRoot: string;
  out: string;
  format: XbriefFormat;
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): XbriefPaths {
  const projectRoot = resolve(input.projectRoot);
  const expanded = expandUserPath(input.out, { home: input.home, env: input.env });

  // Absolute (post-expand) paths must still nest under projectRoot.
  // Relative paths resolve against projectRoot (not bare cwd) so containment is stable.
  let candidate: string;
  if (isAbsolute(expanded)) {
    candidate = resolve(expanded);
  } else {
    // When out is explicitly cwd-relative (./…), resolve against cwd then re-check root.
    const cwd = input.cwd ?? process.cwd();
    if (
      expanded === "." ||
      expanded.startsWith(`.${sep}`) ||
      expanded.startsWith("./") ||
      expanded.startsWith(".\\")
    ) {
      candidate = resolve(cwd, expanded);
    } else {
      candidate = resolve(projectRoot, expanded);
    }
  }

  const stemRaw = stripXbriefSuffix(candidate);

  let stemAbs: string;
  try {
    // resolveContainedTarget requires nested path (not the root itself).
    // If stem equals root, fail with a clear message.
    const rel = relative(projectRoot, stemAbsPlaceholder(projectRoot, stemRaw));
    if (rel.length === 0) {
      throw new XbriefPathError(
        `xbrief path refused: --out resolves to project root (need a file stem under the root)`,
        "XBRIEF_PATH_ESCAPE",
      );
    }
    stemAbs = resolveContainedTarget(
      projectRoot,
      isAbsolute(stemRaw) ? stemRaw : relative(projectRoot, stemRaw),
    );
  } catch (err) {
    if (err instanceof XbriefPathError) throw err;
    if (err instanceof ContainedWriteError) {
      throw new XbriefPathError(
        `xbrief path refused: --out escapes project root (${err.target})`,
        err.code === ContainedWriteErrorCode.ESCAPE ? "XBRIEF_PATH_ESCAPE" : err.code,
      );
    }
    throw err;
  }

  const jsonAbs = input.format === "md" ? null : `${stemAbs}.xbrief.json`;
  const mdAbs = input.format === "json" ? null : `${stemAbs}.xbrief.md`;

  // Re-validate artifact paths under root (stem + suffix must stay nested).
  for (const p of [jsonAbs, mdAbs]) {
    if (p === null) continue;
    try {
      resolveContainedTarget(projectRoot, p);
    } catch (err) {
      if (err instanceof ContainedWriteError) {
        throw new XbriefPathError(
          `xbrief path refused: artifact escapes project root (${p})`,
          "XBRIEF_PATH_ESCAPE",
        );
      }
      throw err;
    }
  }

  return { projectRoot, stemAbs, jsonAbs, mdAbs };
}

function stemAbsPlaceholder(projectRoot: string, stemRaw: string): string {
  return isAbsolute(stemRaw) ? resolve(stemRaw) : resolve(projectRoot, stemRaw);
}
