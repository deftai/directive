import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { resolveTriageCachePath } from "../triage/cache-path.js";
import type { StalenessTicklerState } from "./types.js";

export const STATE_RELATIVE_PATH = join("xbrief", ".triage-cache", "staleness-tickler-state.json");
const STATE_FILE_NAME = "staleness-tickler-state.json";

function resolveStalenessTicklerStatePath(projectRoot: string): string {
  return resolveTriageCachePath(projectRoot, STATE_FILE_NAME);
}

export interface StateIo {
  readonly readText?: (path: string) => string | null;
  readonly writeText?: (path: string, content: string) => void;
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultWriteText(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpBase = `${basename(path)}.${process.pid}.tmp`;
  const temporary = join(dir, tmpBase);
  try {
    // #2980 wave D: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(dir),
      target: tmpBase,
      data: content,
      mode: "create",
    });
    renameSync(temporary, path);
  } catch (err) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

export function parseStalenessTicklerState(text: string | null): StalenessTicklerState {
  if (text === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StalenessTicklerState;
    }
  } catch {
    // stale state must never block operator work
  }
  return {};
}

export function loadStalenessTicklerState(
  projectRoot: string,
  io: StateIo = {},
): StalenessTicklerState {
  let path: string;
  try {
    path = resolveStalenessTicklerStatePath(projectRoot);
  } catch {
    return {};
  }
  return parseStalenessTicklerState((io.readText ?? defaultReadText)(path));
}

export function saveStalenessTicklerState(
  projectRoot: string,
  state: StalenessTicklerState,
  io: StateIo = {},
): void {
  let path: string;
  try {
    path = resolveStalenessTicklerStatePath(projectRoot);
  } catch {
    return;
  }
  try {
    (io.writeText ?? defaultWriteText)(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // persistence is best-effort
  }
}
