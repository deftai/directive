import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface WhichAllOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
  /** Optional executable predicate (defaults to file + X_OK on posix). */
  readonly isExecutable?: (path: string) => boolean;
}

function defaultIsExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    const st = statSync(path);
    // Directories named `deft` must not shadow later executables (#3233 Greptile).
    if (st.isDirectory()) return false;
    if (!st.isFile() && !st.isSymbolicLink()) return false;
    if (platform === "win32") {
      return true;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate every PATH match for `name` (PATH order, first = highest precedence).
 * Pure PATH scan — no shell locator — so tests and win32/posix stay hermetic and
 * gated ritual never executes a PATH-substituted `which`/`where` (#3233).
 * Only files (posix: executable bit) are accepted — not bare directories.
 */
export function whichAllFromPath(name: string, options: WhichAllOptions = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const isExecutable = options.isExecutable ?? ((p: string) => defaultIsExecutable(p, platform));
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
      if (exists(candidate) && isExecutable(candidate)) {
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
