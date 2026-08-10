import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface WhichAllOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
}

/**
 * Enumerate every PATH match for `name` (PATH order, first = highest precedence).
 * Pure PATH scan — no shell locator — so tests and win32/posix stay hermetic and
 * gated ritual never executes a PATH-substituted `which`/`where` (#3233).
 */
export function whichAllFromPath(name: string, options: WhichAllOptions = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const pathValue = env.PATH ?? env.Path ?? "";
  if (pathValue === "") {
    return [];
  }
  const isWindows = platform === "win32";
  const exts = isWindows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const sep = isWindows ? ";" : ":";
  const joinPath = isWindows ? win32.join : posix.join;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of pathValue.split(sep)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = joinPath(dir, `${name}${ext}`);
      const key = isWindows ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      if (exists(candidate)) {
        seen.add(key);
        out.push(candidate);
        // One match per PATH directory (first PATHEXT hit wins on win32).
        break;
      }
    }
  }
  return out;
}

/**
 * All PATH matches for `name` without shelling out (#3233 security).
 * Alias of {@link whichAllFromPath} — never runs bare `which` / `where`.
 */
export function defaultWhichAll(name: string, options: WhichAllOptions = {}): string[] {
  return whichAllFromPath(name, options);
}

/**
 * Optional shell-locator listing (`where` / `which -a`). Prefer
 * {@link defaultWhichAll} / {@link whichAllFromPath} for security-sensitive gates.
 * Kept for diagnostics and tests that intentionally exercise the locator.
 */
export function whichAllViaLocator(name: string, options: WhichAllOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const locator = platform === "win32" ? "where" : "which";
  const args = platform === "win32" ? [name] : ["-a", name];
  try {
    const result = execFileSync(locator, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    const lines = result
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length > 0) {
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const line of lines) {
        const key = platform === "win32" ? line.toLowerCase() : line;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(line);
      }
      return deduped;
    }
  } catch {
    // Fall through to PATH scan.
  }
  return whichAllFromPath(name, options);
}

/** Default PATH lookup mirroring Python `shutil.which` (first match only). */
export function defaultWhich(name: string): string | null {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const result = execFileSync(locator, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = result.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first !== undefined ? first.trim() : null;
  } catch {
    return null;
  }
}
