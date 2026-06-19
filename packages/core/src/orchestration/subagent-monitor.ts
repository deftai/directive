/**
 * Sub-agent heartbeat watcher (#1365). Port of scripts/subagent_monitor.py.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const EXIT_OK = 0;
export const EXIT_STALE = 1;
export const EXIT_EXTERNAL_ERROR = 2;

export const DEFAULT_THRESHOLD_MINUTES = 30;

export const CANONICAL_PHASES = new Set([
  "starting",
  "implementing",
  "validating",
  "committing",
  "pushing",
  "polling",
  "fixing",
  "terminal",
]);

export const REQUIRED_FIELDS = [
  "agent_id",
  "parent_id",
  "last_heartbeat_at",
  "last_message",
  "phase",
] as const;

export interface HeartbeatRecord {
  readonly path: string;
  agent_id: string | null;
  parent_id: string | null;
  last_heartbeat_at_iso: string | null;
  last_heartbeat_at: Date | null;
  last_message: string | null;
  phase: string | null;
  terminal_state: string | null;
  pr_number: number | null;
  age_seconds: number | null;
  is_terminal: boolean;
  is_stale: boolean;
  failures: string[];
}

export function recordOk(rec: HeartbeatRecord): boolean {
  return rec.failures.length === 0 && !rec.is_stale;
}

export function recordToDict(rec: HeartbeatRecord): Record<string, unknown> {
  return {
    path: rec.path,
    agent_id: rec.agent_id,
    parent_id: rec.parent_id,
    last_heartbeat_at: rec.last_heartbeat_at_iso,
    last_message: rec.last_message,
    phase: rec.phase,
    terminal_state: rec.terminal_state,
    pr_number: rec.pr_number,
    age_seconds: rec.age_seconds,
    is_terminal: rec.is_terminal,
    is_stale: rec.is_stale,
    failures: [...rec.failures],
    ok: recordOk(rec),
  };
}

/** Parse ISO-8601 UTC timestamp (Z or +00:00). */
export function parseIso8601Utc(value: string): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const trimmed = value.trim();
  let candidate = trimmed;
  if (trimmed.endsWith("Z")) {
    candidate = `${trimmed.slice(0, -1)}+00:00`;
  }
  if (!candidate.endsWith("+00:00")) {
    return null;
  }
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function emptyRecord(path: string): HeartbeatRecord {
  return {
    path,
    agent_id: null,
    parent_id: null,
    last_heartbeat_at_iso: null,
    last_heartbeat_at: null,
    last_message: null,
    phase: null,
    terminal_state: null,
    pr_number: null,
    age_seconds: null,
    is_terminal: false,
    is_stale: false,
    failures: [],
  };
}

/** Parse one heartbeat JSON file. Never throws. */
export function parseHeartbeatFile(
  filePath: string,
  options: { now: Date; thresholdSeconds: number },
): HeartbeatRecord {
  const rec = emptyRecord(filePath);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err: unknown) {
    rec.failures.push(`unreadable: ${String((err as Error).message ?? err)}`);
    return rec;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (err: unknown) {
    const msg = err instanceof SyntaxError ? err.message : String(err);
    rec.failures.push(`malformed JSON: ${msg}`);
    return rec;
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    rec.failures.push(
      `top-level must be a JSON object, got ${payload === null ? "null" : Array.isArray(payload) ? "list" : typeof payload}`,
    );
    return rec;
  }

  const obj = payload as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter((f) => !(f in obj));
  if (missing.length > 0) {
    rec.failures.push(`missing required field(s): ${missing.join(", ")}`);
  }

  const wrongType = REQUIRED_FIELDS.filter((f) => f in obj && typeof obj[f] !== "string");
  if (wrongType.length > 0) {
    const types = wrongType.map((f) => `${f}=${typeof obj[f]}`).join(", ");
    rec.failures.push(`required field(s) must be string, got: ${types}`);
  }

  if (typeof obj.agent_id === "string") rec.agent_id = obj.agent_id;
  if (typeof obj.parent_id === "string") rec.parent_id = obj.parent_id;
  if (typeof obj.last_message === "string") rec.last_message = obj.last_message;
  if (typeof obj.phase === "string") rec.phase = obj.phase;
  if (typeof obj.terminal_state === "string") rec.terminal_state = obj.terminal_state;
  if (typeof obj.pr_number === "number" && Number.isInteger(obj.pr_number)) {
    rec.pr_number = obj.pr_number;
  }

  const expectedId = basename(filePath, ".json");
  if (rec.agent_id !== null && rec.agent_id !== expectedId) {
    rec.failures.push(
      `agent_id mismatch: file is '${expectedId}.json' but payload has agent_id=${JSON.stringify(rec.agent_id)}`,
    );
  }

  const tsValue = obj.last_heartbeat_at;
  if (typeof tsValue === "string") {
    rec.last_heartbeat_at_iso = tsValue;
    const parsedTs = parseIso8601Utc(tsValue);
    if (parsedTs === null) {
      rec.failures.push(
        `last_heartbeat_at not ISO-8601 UTC (must end in 'Z' or '+00:00'): ${JSON.stringify(tsValue)}`,
      );
    } else {
      rec.last_heartbeat_at = parsedTs;
      rec.age_seconds = (options.now.getTime() - parsedTs.getTime()) / 1000;
    }
  }

  if (rec.phase !== null && !CANONICAL_PHASES.has(rec.phase)) {
    rec.failures.push(
      `unknown phase ${JSON.stringify(rec.phase)}; expected one of ${[...CANONICAL_PHASES].sort().join(", ")}`,
    );
  }

  if (rec.phase === "terminal" && !rec.terminal_state) {
    rec.failures.push("phase='terminal' requires a non-empty terminal_state field");
  }
  rec.is_terminal = Boolean(rec.terminal_state);

  if (rec.age_seconds !== null && !rec.is_terminal && rec.age_seconds > options.thresholdSeconds) {
    rec.is_stale = true;
  }

  return rec;
}

export interface SweepResult {
  scratch_dirs: string[];
  threshold_minutes: number;
  now_iso: string;
  records: HeartbeatRecord[];
  sweep_errors: string[];
}

export function sweepAllOk(result: SweepResult): boolean {
  return result.sweep_errors.length === 0 && result.records.every((r) => recordOk(r));
}

export function sweepToDict(result: SweepResult): Record<string, unknown> {
  return {
    scratch_dirs: [...result.scratch_dirs],
    threshold_minutes: result.threshold_minutes as number,
    now: result.now_iso,
    record_count: result.records.length,
    stale_count: result.records.filter((r) => r.is_stale).length,
    malformed_count: result.records.filter((r) => r.failures.length > 0).length,
    all_ok: sweepAllOk(result),
    records: result.records.map(recordToDict),
    sweep_errors: [...result.sweep_errors],
  };
}

/** JSON.stringify helper matching Python's float formatting for threshold_minutes. */
export function sweepToJson(result: SweepResult): string {
  const obj = sweepToDict(result);
  const raw = JSON.stringify(obj, null, 2);
  return raw.replace(/"threshold_minutes": (\d+)(?=[,\n])/g, '"threshold_minutes": $1.0');
}

function formatNowIso(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface ScratchDirEntry {
  readonly readPath: string;
  readonly label: string;
}

/** Walk scratch dirs and parse every *.json heartbeat record. */
export function sweepScratchDirs(
  scratchDirs: ScratchDirEntry[],
  options: { thresholdMinutes: number; now?: Date },
): SweepResult {
  const now = options.now ?? new Date();
  const thresholdSeconds = options.thresholdMinutes * 60;

  const result: SweepResult = {
    scratch_dirs: scratchDirs.map((d) => d.label),
    threshold_minutes: options.thresholdMinutes,
    now_iso: formatNowIso(now),
    records: [],
    sweep_errors: [],
  };

  for (const entry of scratchDirs) {
    const d = entry.readPath;
    const label = entry.label;
    if (!existsSync(d)) {
      result.sweep_errors.push(`scratch dir does not exist: ${label}`);
      continue;
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(d);
    } catch {
      result.sweep_errors.push(`scratch path is not a directory: ${d}`);
      continue;
    }
    if (!stat.isDirectory()) {
      result.sweep_errors.push(`scratch path is not a directory: ${label}`);
      continue;
    }
    let children: string[];
    try {
      children = readdirSync(d)
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (exc: unknown) {
      result.sweep_errors.push(
        `scratch dir unreadable ${label}: ${String((exc as Error).message ?? exc)}`,
      );
      continue;
    }
    for (const name of children) {
      const child = join(d, name);
      try {
        if (!statSync(child).isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      result.records.push(parseHeartbeatFile(child, { now, thresholdSeconds }));
    }
  }

  return result;
}

function formatAge(seconds: number | null): string {
  if (seconds === null) {
    return "<unknown>";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(1)}m`;
  }
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

/** Pretty-print sweep verdict for human consumers. */
export function renderText(result: SweepResult): string {
  const lines: string[] = [];
  const n = result.records.length;
  lines.push(
    `Sub-agent heartbeat sweep (${n} record${n !== 1 ? "s" : ""}, threshold ${result.threshold_minutes} min, now=${result.now_iso})`,
  );
  for (const d of result.scratch_dirs) {
    lines.push(`  Scratch dir: ${d}`);
  }
  if (result.sweep_errors.length > 0) {
    lines.push("  Sweep errors:");
    for (const err of result.sweep_errors) {
      lines.push(`    [!] ${err}`);
    }
  }
  if (result.records.length === 0 && result.sweep_errors.length === 0) {
    lines.push("");
    lines.push("  No heartbeat records found (empty scratch dir).");
  }
  for (const rec of result.records) {
    let status: string;
    if (rec.failures.length > 0 && rec.is_stale) {
      status = "STALE+MALFORMED";
    } else if (rec.failures.length > 0) {
      status = "MALFORMED";
    } else if (rec.is_stale) {
      status = "STALE";
    } else if (rec.is_terminal) {
      status = "TERMINAL";
    } else {
      status = "OK";
    }
    const agent = rec.agent_id ?? basename(rec.path, ".json");
    lines.push("");
    lines.push(`  ${agent} -- ${status}`);
    lines.push(`    Path:               ${rec.path}`);
    lines.push(`    Parent:             ${rec.parent_id ?? "<unset>"}`);
    lines.push(
      `    Last heartbeat:     ${rec.last_heartbeat_at_iso ?? "<unparsed>"} (age ${formatAge(rec.age_seconds)})`,
    );
    lines.push(`    Phase:              ${rec.phase ?? "<unset>"}`);
    if (rec.pr_number !== null) {
      lines.push(`    PR:                 #${rec.pr_number}`);
    }
    if (rec.terminal_state) {
      lines.push(`    Terminal state:     ${rec.terminal_state}`);
    }
    if (rec.last_message) {
      lines.push(`    Last message:       ${rec.last_message}`);
    }
    for (let i = 0; i < rec.failures.length; i += 1) {
      lines.push(`      [${i + 1}] ${rec.failures[i]}`);
    }
  }
  lines.push("");
  if (result.records.length === 0 && result.sweep_errors.length === 0) {
    lines.push("Result: NO AGENTS TO MONITOR -- empty scratch dir (no stale state)");
  } else if (sweepAllOk(result)) {
    lines.push("Result: ALL AGENTS ALIVE -- no stale or malformed records");
  } else {
    const stale = result.records.filter((r) => r.is_stale).length;
    const malformed = result.records.filter((r) => r.failures.length > 0).length;
    const dirErrors = result.sweep_errors.length;
    if (dirErrors > 0 && stale === 0 && malformed === 0) {
      const healthy = result.records.length;
      lines.push(
        `Result: ATTENTION -- ${dirErrors} scratch dir error(s); ${healthy} record(s) healthy. Verify each --scratch-dir path; correct the misconfigured or missing directories surfaced above.`,
      );
    } else {
      const dirTail = dirErrors > 0 ? `, ${dirErrors} scratch dir error(s)` : "";
      lines.push(
        `Result: ATTENTION -- ${stale} stale, ${malformed} malformed record(s)${dirTail}. Inspect diagnostics above and either re-dispatch the stalled agent(s) or take over manually.`,
      );
    }
  }
  return lines.join("\n");
}

export function defaultScratchDir(cwd: string = process.cwd()): string {
  return join(cwd, ".deft-scratch", "subagent-status");
}

export interface SubagentMonitorArgs {
  scratchDirs: string[];
  thresholdMinutes: number;
  emitJson: boolean;
  error?: string;
}

/** Parse CLI args mirroring Python argparse surface. */
export function parseSubagentMonitorArgs(argv: string[]): SubagentMonitorArgs {
  const parsed: SubagentMonitorArgs = {
    scratchDirs: [],
    thresholdMinutes: DEFAULT_THRESHOLD_MINUTES,
    emitJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--scratch-dir") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --scratch-dir: expected one argument" };
      }
      parsed.scratchDirs.push(value);
      i += 1;
    } else if (arg?.startsWith("--scratch-dir=")) {
      parsed.scratchDirs.push(arg.slice("--scratch-dir=".length));
    } else if (arg === "--threshold-minutes") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --threshold-minutes: expected one argument" };
      }
      parsed.thresholdMinutes = Number(value);
      i += 1;
    } else if (arg?.startsWith("--threshold-minutes=")) {
      parsed.thresholdMinutes = Number(arg.slice("--threshold-minutes=".length));
    } else if (arg === "--help" || arg === "-h") {
      return parsed;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run subagent monitor; returns exit code. */
export function cmdSubagentMonitor(argv: string[], cwd: string = process.cwd()): number {
  const args = parseSubagentMonitorArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`Error: ${args.error}\n`);
    return EXIT_EXTERNAL_ERROR;
  }

  if (args.thresholdMinutes <= 0) {
    process.stderr.write(
      `Error: --threshold-minutes must be positive, got ${args.thresholdMinutes}\n`,
    );
    return EXIT_EXTERNAL_ERROR;
  }

  const scratchEntries: ScratchDirEntry[] =
    args.scratchDirs.length > 0
      ? args.scratchDirs.map((p) => ({ readPath: resolve(cwd, p), label: p }))
      : [{ readPath: defaultScratchDir(cwd), label: defaultScratchDir(cwd) }];

  const result = sweepScratchDirs(scratchEntries, { thresholdMinutes: args.thresholdMinutes });
  const configError = result.sweep_errors.length > 0 && result.records.length === 0;

  if (args.emitJson) {
    process.stdout.write(`${sweepToJson(result)}\n`);
  } else {
    process.stdout.write(`${renderText(result)}\n`);
  }

  if (configError) {
    return EXIT_EXTERNAL_ERROR;
  }
  if (sweepAllOk(result)) {
    return EXIT_OK;
  }
  return EXIT_STALE;
}
