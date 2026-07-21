import { readFileSync } from "node:fs";
import { type RunGhApiFn, runGhApi } from "../scm/gh-rest.js";
import { resolveUserMdPath } from "../user-config/resolve-user-md.js";

export type ActorNameSource = "user-md" | "gh-login" | "unnamed";

export interface ResolvedActorName {
  readonly actorName: string;
  readonly actorNameSource: ActorNameSource;
  readonly displayName: string;
}

/** Normalize for thread-key matching (#2693 D8). */
export function normalizeActorKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Parse addressing-name from USER.md Personal section (#2693 D8). */
export function parseAddressingNameFromUserMd(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inPersonal = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+personal\b/i.test(trimmed)) {
      inPersonal = true;
      continue;
    }
    if (inPersonal && /^##\s+/.test(trimmed)) {
      break;
    }
    const nameMatch =
      trimmed.match(/^(?:-\s*)?(?:\*\*)?Name(?:\*\*)?\s*:\s*(.+)$/i) ??
      trimmed.match(/^(?:-\s*)?(?:\*\*)?addressing-name(?:\*\*)?\s*:\s*(.+)$/i);
    if (nameMatch?.[1] !== undefined) {
      const value = nameMatch[1].replace(/\*\*/g, "").trim();
      if (value.length > 0) {
        return value;
      }
    }
    if (!inPersonal) {
      const topMatch = trimmed.match(/^(?:\*\*)?Name(?:\*\*)?\s*:\s*(.+)$/i);
      if (topMatch?.[1] !== undefined) {
        const value = topMatch[1].replace(/\*\*/g, "").trim();
        if (value.length > 0) {
          return value;
        }
      }
    }
  }
  return null;
}

function readGhLogin(runGhApiFn?: RunGhApiFn): string | null {
  try {
    const result = (runGhApiFn ?? runGhApi)(["user"], { timeout: 15 });
    if (result.returncode !== 0) {
      return null;
    }
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const login = (parsed as Record<string, unknown>).login;
      if (typeof login === "string" && login.trim().length > 0) {
        return login.trim();
      }
    }
  } catch {
    // best-effort
  }
  return null;
}

export interface ResolveActorNameOptions {
  readonly projectRoot?: string;
  readonly runGhApiFn?: RunGhApiFn;
}

/** Resolve actorName with USER.md -> gh-login -> unnamed precedence (#2693 D8). */
export function resolveActorName(options: ResolveActorNameOptions = {}): ResolvedActorName {
  const projectRoot = options.projectRoot ?? process.cwd();
  const userMd = resolveUserMdPath({ projectRoot });
  if (userMd.found) {
    try {
      const text = readFileSync(userMd.path, "utf8");
      const fromUser = parseAddressingNameFromUserMd(text);
      if (fromUser !== null) {
        return {
          actorName: fromUser,
          actorNameSource: "user-md",
          displayName: fromUser,
        };
      }
    } catch {
      // fall through
    }
  }
  const ghLogin = readGhLogin(options.runGhApiFn);
  if (ghLogin !== null) {
    return {
      actorName: ghLogin,
      actorNameSource: "gh-login",
      displayName: ghLogin,
    };
  }
  return {
    actorName: "unnamed",
    actorNameSource: "unnamed",
    displayName: "unnamed",
  };
}
