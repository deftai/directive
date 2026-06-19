import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROJECT_ROOT_SENTINELS = ["vbrief", ".git"] as const;

function isProjectRoot(candidate: string): boolean {
  return PROJECT_ROOT_SENTINELS.some((sentinel) => existsSync(join(candidate, sentinel)));
}

function* walkUp(start: string): Generator<string> {
  let current = resolve(start);
  for (;;) {
    yield current;
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

/**
 * Resolve the consumer project root (#535).
 * Precedence: --project-root > $DEFT_PROJECT_ROOT > sentinel walk from CWD.
 */
export function resolveProjectRoot(cliProjectRoot?: string | null, start?: string): string | null {
  if (cliProjectRoot !== undefined && cliProjectRoot !== null && cliProjectRoot.length > 0) {
    const candidate = resolve(cliProjectRoot);
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      return null;
    }
    return null;
  }

  const envRoot = process.env.DEFT_PROJECT_ROOT;
  if (envRoot !== undefined && envRoot.length > 0) {
    const candidate = resolve(envRoot);
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      return null;
    }
    return null;
  }

  for (const candidate of walkUp(start ?? process.cwd())) {
    if (isProjectRoot(candidate)) {
      return candidate;
    }
  }
  return null;
}
