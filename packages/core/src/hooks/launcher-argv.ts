/**
 * Launcher-family worker argv classification (#4219).
 *
 * Inspects shell command contents for grok / claude / codex worker launches.
 * Lives ahead of the shell branch. Not a dest-form. Not SPAWN_TOOL_NAMES.
 */

export const LAUNCHER_FAMILIES = ["grok", "claude", "codex"] as const;
export type LauncherFamily = (typeof LAUNCHER_FAMILIES)[number];

export type LauncherArgvClass =
  | { readonly kind: "not-launcher" }
  | {
      readonly kind: "launcher";
      readonly family: LauncherFamily;
      readonly dest: string | null;
    };

export const NOT_LAUNCHER: LauncherArgvClass = { kind: "not-launcher" };

const WRAP_BINS = new Set(["sudo", "env", "command", "nice", "nohup", "time"]);

const WRAP_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(["-u", "-g", "-C", "-p", "-r", "-t", "-T", "-D"]),
  env: new Set(["-u", "-C", "-S", "--chdir", "--split-string"]),
  command: new Set(),
  nice: new Set(["-n"]),
  nohup: new Set(),
  time: new Set(),
};

const DIAGNOSTIC_FLAGS = new Set(["--version", "--help", "-h", "-V"]);

const GROK_DEST_FLAGS = ["--cwd"] as const;
const CODEX_DEST_FLAGS = ["-C", "--cd"] as const;
const CLAUDE_DEST_FLAGS = ["--cwd"] as const;

const CLAUDE_WORKER_FLAGS = new Set([
  "-p",
  "--print",
  "--permission-mode",
  "--dangerously-skip-permissions",
  "--output-format",
]);

export interface ClassifyLauncherArgvOptions {
  /** Shell payload cwd. Used only for claude dest (published form has no dest flag). */
  readonly payloadCwd?: string | null;
}

/**
 * Classify launcher-family worker argv. Dest for grok/codex is argv-only;
 * claude may use payload cwd. Do not inherit parent cwd for grok/codex (#4066).
 */
export function classifyLauncherFamilyArgv(
  command: string,
  options: ClassifyLauncherArgvOptions = {},
): LauncherArgvClass {
  const cmd = command.trim();
  if (cmd.length === 0) return NOT_LAUNCHER;
  for (const segment of splitCommandSegments(cmd)) {
    const classified = classifyLauncherSegment(segment, options.payloadCwd ?? null);
    if (classified.kind === "launcher") return classified;
  }
  return NOT_LAUNCHER;
}

function classifyLauncherSegment(segment: string, payloadCwd: string | null): LauncherArgvClass {
  const tokens = tokenizeSegment(segment);
  const start = skipWrappers(tokens);
  const bin = tokens[start];
  if (bin === undefined) return NOT_LAUNCHER;
  const family = launcherFamilyFromBin(bin);
  if (family === null) return NOT_LAUNCHER;
  const rest = tokens.slice(start + 1);
  if (!isWorkerLaunch(family, rest)) return NOT_LAUNCHER;
  return { kind: "launcher", family, dest: destFromArgv(family, rest, payloadCwd) };
}

function launcherFamilyFromBin(token: string): LauncherFamily | null {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? "";
  const name = base.replace(/\.exe$/i, "").toLowerCase();
  if (name === "grok" || name === "claude" || name === "codex") return name;
  return null;
}

function isWorkerLaunch(family: LauncherFamily, rest: readonly string[]): boolean {
  if (isDiagnosticOnly(rest)) return false;
  if (family === "codex") {
    const first = rest.find((token) => !token.startsWith("-") && !isEnvAssign(token));
    return first === "exec" || destFlagValue(rest, CODEX_DEST_FLAGS) !== null;
  }
  if (family === "claude") {
    return rest.some((token) => CLAUDE_WORKER_FLAGS.has(flagName(token)));
  }
  return true;
}

function destFromArgv(
  family: LauncherFamily,
  rest: readonly string[],
  payloadCwd: string | null,
): string | null {
  if (family === "grok") return destFlagValue(rest, GROK_DEST_FLAGS);
  if (family === "codex") return destFlagValue(rest, CODEX_DEST_FLAGS);
  return destFlagValue(rest, CLAUDE_DEST_FLAGS) ?? emptyToNull(payloadCwd);
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function destFlagValue(tokens: readonly string[], names: readonly string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    for (const name of names) {
      if (token === name) {
        const next = tokens[i + 1];
        if (next === undefined || next.startsWith("-")) return null;
        return next;
      }
      if (token.startsWith(`${name}=`)) {
        const value = token.slice(name.length + 1);
        return value.length > 0 ? value : null;
      }
    }
  }
  return null;
}

function isDiagnosticOnly(rest: readonly string[]): boolean {
  const flags: string[] = [];
  const positionals: string[] = [];
  for (const token of rest) {
    if (token.startsWith("-")) flags.push(flagName(token));
    else if (!isEnvAssign(token)) positionals.push(token);
  }
  if (positionals.length > 0) return false;
  if (flags.length === 0) return false;
  return flags.every((flag) => DIAGNOSTIC_FLAGS.has(flag));
}

function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

function isEnvAssign(token: string): boolean {
  const eq = token.indexOf("=");
  if (eq <= 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq));
}

function skipWrappers(tokens: readonly string[]): number {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;
    if (isEnvAssign(token)) {
      i++;
      continue;
    }
    const bin = launcherFamilyFromBin(token);
    if (bin !== null) return i;
    const base = token
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.exe$/i, "")
      .toLowerCase();
    if (base === undefined || !WRAP_BINS.has(base)) return i;
    i++;
    const valueOpts = WRAP_VALUE_OPTS[base] ?? new Set<string>();
    while (i < tokens.length) {
      const opt = tokens[i];
      if (opt === undefined || !opt.startsWith("-")) break;
      i++;
      if (valueOpts.has(flagName(opt)) && !opt.includes("=")) i++;
    }
  }
  return i;
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    segments.push(cur);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += c;
      cur += command[i + 1] ?? "";
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if ((c === "&" && command[i + 1] === "&") || (c === "|" && command[i + 1] === "|")) {
      flush();
      i++;
      continue;
    }
    if (c === "|" || c === "&" || c === ";" || c === "\n" || c === "\r") {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return segments.filter((seg) => seg.trim().length > 0);
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const push = (): void => {
    if (cur.length > 0) {
      tokens.push(cur);
      cur = "";
    }
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === undefined) break;
    if (quote !== null) {
      if (c === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && c === "\\" && i + 1 < segment.length) {
        const next = segment[i + 1] ?? "";
        if (next === "\\" || next === '"') {
          cur += next;
          i++;
          continue;
        }
        cur += c;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < segment.length) {
      const next = segment[i + 1] ?? "";
      if (next === " " || next === "\t" || next === '"' || next === "'") {
        cur += next;
        i++;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    cur += c;
  }
  push();
  return tokens;
}
