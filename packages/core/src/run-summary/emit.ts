/**
 * Fail-open run-summary JSONL emitter (#3282).
 *
 * Emission never changes exit codes, never throws to callers, and prints at
 * most one warning when an *explicit* DEFT_RUN_SUMMARY_PATH write fails.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { readCorePackageVersion } from "../engine-version.js";
import {
  type ResolveRunSummaryDestinationOptions,
  resolveRunSummaryDestination,
} from "./path.js";
import {
  type CheckInvocationRunSummaryPayload,
  type DialTransitionRunSummaryPayload,
  type RunSummaryDestination,
  type RunSummaryEventKind,
  type RunSummaryLine,
  type RunSummaryPayload,
  RUN_SUMMARY_SCHEMA_VERSION,
  RUN_SUMMARY_STDOUT_PREFIX,
  RUN_SUMMARY_WRITE_WARNING,
  type SessionStartRunSummaryPayload,
} from "./types.js";

export interface RunSummaryEmitterOptions extends ResolveRunSummaryDestinationOptions {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly frameworkVersion?: string;
  /** Clock seam for tests. */
  readonly now?: () => Date;
  /** Destination override (tests). */
  readonly destination?: RunSummaryDestination;
  /** stdout/stderr seams (tests). */
  readonly writeStdout?: (line: string) => void;
  readonly writeStderr?: (line: string) => void;
}

export interface EmitRunSummaryResult {
  readonly emitted: boolean;
  readonly destination: RunSummaryDestination;
  readonly line: RunSummaryLine | null;
  readonly warning: boolean;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function lineToJson(line: RunSummaryLine): string {
  return JSON.stringify(sortKeysDeep(line));
}

/**
 * Stateful emitter: one instance per session tracks seq and write-warning once.
 */
export class RunSummaryEmitter {
  private seq = 0;
  private warned = false;
  private readonly projectRoot: string;
  private readonly sessionId: string;
  private readonly frameworkVersion: string;
  private readonly now: () => Date;
  private readonly destination: RunSummaryDestination;
  private readonly writeStdout: (line: string) => void;
  private readonly writeStderr: (line: string) => void;

  constructor(options: RunSummaryEmitterOptions) {
    this.projectRoot = options.projectRoot;
    this.sessionId = options.sessionId;
    this.frameworkVersion = options.frameworkVersion ?? readCorePackageVersion();
    this.now = options.now ?? (() => new Date());
    this.destination =
      options.destination ??
      resolveRunSummaryDestination(options.projectRoot, {
        env: options.env,
        gitignoreCovers: options.gitignoreCovers,
      });
    this.writeStdout = options.writeStdout ?? ((line) => process.stdout.write(`${line}\n`));
    this.writeStderr = options.writeStderr ?? ((line) => process.stderr.write(`${line}\n`));
  }

  getDestination(): RunSummaryDestination {
    return this.destination;
  }

  emit(event: RunSummaryEventKind, payload: RunSummaryPayload): EmitRunSummaryResult {
    try {
      if (this.destination.kind === "silent") {
        return { emitted: false, destination: this.destination, line: null, warning: false };
      }
      this.seq += 1;
      const line: RunSummaryLine = {
        schema_version: RUN_SUMMARY_SCHEMA_VERSION,
        session_id: this.sessionId,
        framework_version: this.frameworkVersion,
        seq: this.seq,
        ts: this.now().toISOString(),
        event,
        payload,
      };
      const text = lineToJson(line);

      if (this.destination.kind === "stdout") {
        this.writeStdout(`${RUN_SUMMARY_STDOUT_PREFIX}${text}`);
        return { emitted: true, destination: this.destination, line, warning: false };
      }

      // file destination
      const { path, truncateOnSessionStart, explicit } = this.destination;
      try {
        mkdirSync(dirname(path), { recursive: true });
        if (event === "session_start" && truncateOnSessionStart) {
          writeFileSync(path, `${text}\n`, "utf8");
        } else {
          // O_APPEND single-line append for concurrent session safety.
          const fd = openSync(path, "a");
          try {
            writeSync(fd, `${text}\n`, null, "utf8");
          } finally {
            closeSync(fd);
          }
        }
        return { emitted: true, destination: this.destination, line, warning: false };
      } catch {
        // Fail-open: explicit path → one warning; default path → silent.
        if (explicit && !this.warned) {
          this.warned = true;
          this.writeStderr(RUN_SUMMARY_WRITE_WARNING);
          return { emitted: false, destination: this.destination, line, warning: true };
        }
        return { emitted: false, destination: this.destination, line, warning: false };
      }
    } catch {
      return { emitted: false, destination: this.destination, line: null, warning: false };
    }
  }

  emitSessionStart(payload: SessionStartRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("session_start", payload);
  }

  emitDialTransition(payload: DialTransitionRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("dial_transition", payload);
  }

  emitCheckInvocation(payload: CheckInvocationRunSummaryPayload): EmitRunSummaryResult {
    return this.emit("check_invocation", payload);
  }
}

/**
 * One-shot helper for call sites that do not hold an emitter (e.g. dial escalate).
 * Still fail-open; creates a fresh seq=1 emitter unless `seqSeed` is passed via reuse.
 */
export function emitRunSummaryEvent(
  options: RunSummaryEmitterOptions & {
    readonly event: RunSummaryEventKind;
    readonly payload: RunSummaryPayload;
  },
): EmitRunSummaryResult {
  const emitter = new RunSummaryEmitter(options);
  return emitter.emit(options.event, options.payload);
}

/** Convenience for tests: append a raw line without the emitter (not for production). */
export function appendRunSummaryRawLine(path: string, line: string): void {
  appendFileSync(path, `${line}\n`, "utf8");
}
