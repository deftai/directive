/**
 * Cached-path suite-gate supervisor helpers (#4230).
 *
 * Tee path, exclusive create, prune that spares live tees, win32 / POSIX kill.
 * Timeout is armed only when `timeoutMs` is set.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { containedOpenExclusive, containedRemove } from "../fs/contained-write.js";
import { RELEASE_CHECK_TIMEOUT_MS } from "../release/constants.js";
import { SKIP_NOTICE } from "../ts-check-lane/run-lane.js";

export const SUITE_TEE_DIR_REL = ".deft/check-tees";
/** Age bound sits above the 20-minute hang ceiling (freshness 25). */
export const SUITE_TEE_PRUNE_AGE_MS = 25 * 60 * 1000;
export const SUITE_TEE_HANG_CEILING_MS = RELEASE_CHECK_TIMEOUT_MS;
export const FAILURE_SIGNAL_TAIL_LINES = 80;
/** In-memory diagnostic capture; the tee still holds the full stream. */
export const SUITE_CAPTURE_MAX_BYTES = 256 * 1024;

export interface BoundedCapture {
  chunks: Buffer[];
  size: number;
}

export function createBoundedCapture(): BoundedCapture {
  return { chunks: [], size: 0 };
}

export function appendBoundedCapture(
  acc: BoundedCapture,
  chunk: Buffer,
  maxBytes: number = SUITE_CAPTURE_MAX_BYTES,
): void {
  acc.chunks.push(chunk);
  acc.size += chunk.length;
  while (acc.size > maxBytes && acc.chunks.length > 1) {
    const dropped = acc.chunks.shift();
    if (dropped !== undefined) acc.size -= dropped.length;
  }
  if (acc.chunks.length === 1 && acc.size > maxBytes) {
    const only = acc.chunks[0];
    if (only !== undefined) {
      acc.chunks[0] = only.subarray(only.length - maxBytes);
      acc.size = acc.chunks[0].length;
    }
  }
}

export function boundedCaptureText(acc: BoundedCapture): string {
  if (acc.chunks.length === 0) return "";
  return Buffer.concat(acc.chunks).toString("utf8");
}

export function notifySupervisorWaiter(signal: Int32Array): void {
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}

export type WorkerFailureHost = {
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (exitCode: number) => void): unknown;
};

/** Record a worker crash or premature exit and wake `Atomics.wait`. */
export function bindWorkerFailureToWaiter(
  worker: WorkerFailureHost,
  signal: Int32Array,
  record: { failure?: string },
): void {
  worker.on("error", (err: Error) => {
    if (record.failure !== undefined) return;
    record.failure = err.message;
    notifySupervisorWaiter(signal);
  });
  worker.on("exit", (exitCode: number) => {
    if (record.failure !== undefined) return;
    if (exitCode === 0) return;
    record.failure = `suite-gate supervisor worker exited before posting a result (code ${exitCode})`;
    notifySupervisorWaiter(signal);
  });
}

export interface SupervisedGatePlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly platform?: NodeJS.Platform;
  readonly killTree?: (pid: number) => void;
}

export interface SupervisedGateResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly teePath: string;
  readonly teeRel: string;
  readonly spawnError?: string;
}

export function sanitizeSessionDirName(sessionId: string | undefined): string {
  const raw = (sessionId ?? "no-session").trim();
  if (raw.includes("..") || /[\\/]/.test(raw)) {
    throw new Error("suite tee sessionId rejected: separators or traversal");
  }
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return safe.length > 0 ? safe : "no-session";
}

export function mintSuiteRunId(pid: number = process.pid): string {
  return `${pid}-${randomBytes(4).toString("hex")}`;
}

export function suiteTeeRelativePath(sessionId: string | undefined, runId: string): string {
  return `${SUITE_TEE_DIR_REL}/${sanitizeSessionDirName(sessionId)}/${runId}.log`;
}

export function assertTeePathContained(projectRoot: string, teeRel: string): string {
  const root = resolve(projectRoot);
  const abs = resolve(root, teeRel);
  const rel = relative(root, abs);
  if (rel.length === 0 || rel.startsWith("..") || rel.split(/[\\/]/).includes("..")) {
    throw new Error(`suite tee path escapes containment root: ${abs}`);
  }
  return abs;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function ownerPidFromTeeName(fileName: string): number | null {
  const m = /^(\d+)-[0-9a-f]+\.log$/i.exec(fileName);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) ? pid : null;
}

export interface KillTreeSeams {
  readonly platform?: NodeJS.Platform;
  readonly taskkill?: (args: readonly string[]) => void;
  readonly posixKill?: (pid: number, signal: NodeJS.Signals) => void;
}

export function killDescendantTree(pid: number, seams: KillTreeSeams = {}): void {
  const platform = seams.platform ?? process.platform;
  if (platform === "win32") {
    const run =
      seams.taskkill ??
      ((args: readonly string[]) => {
        spawnSync("taskkill", [...args], { windowsHide: true, stdio: "ignore" });
      });
    run(["/T", "/F", "/PID", String(pid)]);
    return;
  }
  const kill = seams.posixKill ?? ((p: number, s: NodeJS.Signals) => process.kill(p, s));
  try {
    kill(-pid, "SIGKILL");
  } catch {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
}

export interface PruneSuiteTeesInput {
  readonly projectRoot: string;
  readonly nowMs?: number;
  readonly pruneAgeMs?: number;
  readonly hangCeilingMs?: number;
  readonly isPidAlive?: (pid: number) => boolean;
}

export function pruneSuiteTees(input: PruneSuiteTeesInput): string[] {
  const root = resolve(input.projectRoot);
  const teeRoot = join(root, SUITE_TEE_DIR_REL);
  if (!existsSync(teeRoot)) return [];
  const now = input.nowMs ?? Date.now();
  const pruneAge = input.pruneAgeMs ?? SUITE_TEE_PRUNE_AGE_MS;
  const hangCeiling = input.hangCeilingMs ?? SUITE_TEE_HANG_CEILING_MS;
  const alive = input.isPidAlive ?? isPidAlive;
  const removed: string[] = [];
  const stack = [teeRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!name.endsWith(".log")) continue;
      const age = now - st.mtimeMs;
      if (age < hangCeiling) continue;
      if (age < pruneAge) continue;
      const pid = ownerPidFromTeeName(name);
      if (pid !== null && alive(pid)) continue;
      const rel = relative(root, abs).split(sep).join("/");
      try {
        containedRemove({ root, target: rel });
        removed.push(rel);
      } catch {
        // live exclusive-open / in-use handle — spare
      }
    }
  }
  return removed;
}

/** @internal test helper */
export function touchTeeMtime(absPath: string, mtimeMs: number): void {
  const atime = new Date();
  utimesSync(absPath, atime, new Date(mtimeMs));
}

export function selectFailureSignalLines(
  text: string,
  maxLines: number = FAILURE_SIGNAL_TAIL_LINES,
): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-maxLines);
  const hits = tail.filter((l) => /\bFAIL\b/.test(l) || /\bTests?\b/.test(l));
  return (hits.length > 0 ? hits : tail).join("\n");
}

export function suiteActuallyRan(input: {
  readonly status: string | undefined;
  readonly teeText: string;
  readonly stdout?: string;
  readonly stderr?: string;
}): boolean {
  if (input.status !== "run") return false;
  const blob = `${input.teeText}\n${input.stdout ?? ""}\n${input.stderr ?? ""}`;
  if (blob.includes(SKIP_NOTICE)) return false;
  return true;
}

export function readTeeText(absPath: string): string {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
}

export async function superviseChild(plan: SupervisedGatePlan): Promise<SupervisedGateResult> {
  const runId = plan.runId ?? mintSuiteRunId();
  const teeRel = suiteTeeRelativePath(plan.sessionId, runId);
  const projectRoot = resolve(plan.projectRoot);
  assertTeePathContained(projectRoot, teeRel);
  const handle = containedOpenExclusive({ root: projectRoot, target: teeRel });
  const stdoutCap = createBoundedCapture();
  const stderrCap = createBoundedCapture();
  const platform = plan.platform ?? process.platform;
  const child = spawn(plan.command, [...plan.args], {
    cwd: plan.cwd,
    env: plan.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32" && plan.timeoutMs !== undefined,
    windowsHide: true,
  });
  const writeBoth = (chunk: Buffer, stream: NodeJS.WriteStream, acc: BoundedCapture): void => {
    appendBoundedCapture(acc, chunk);
    stream.write(chunk);
    handle.write(chunk);
  };
  child.stdout?.on("data", (chunk: Buffer) => writeBoth(chunk, process.stdout, stdoutCap));
  child.stderr?.on("data", (chunk: Buffer) => writeBoth(chunk, process.stderr, stderrCap));

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (plan.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        if (plan.killTree) plan.killTree(child.pid);
        else killDescendantTree(child.pid, { platform });
      }
    }, plan.timeoutMs);
  }

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolveExit) => {
    child.on("error", (error) => resolveExit({ code: 1, signal: null, error }));
    child.on("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (timer !== undefined) clearTimeout(timer);
  try {
    handle.close();
  } catch {
    // already closed
  }
  const stdout = boundedCaptureText(stdoutCap);
  const stderr = boundedCaptureText(stderrCap);
  if (timedOut) {
    return {
      exitCode: 124,
      timedOut: true,
      signal: exit.signal,
      stdout,
      stderr,
      teePath: handle.path,
      teeRel,
    };
  }
  if (exit.error !== undefined) {
    return {
      exitCode: 1,
      timedOut: false,
      signal: null,
      stdout,
      stderr,
      teePath: handle.path,
      teeRel,
      spawnError: exit.error.message,
    };
  }
  if (exit.signal) {
    return {
      exitCode: 1,
      timedOut: false,
      signal: exit.signal,
      stdout,
      stderr,
      teePath: handle.path,
      teeRel,
    };
  }
  return {
    exitCode: exit.code ?? 1,
    timedOut: false,
    signal: null,
    stdout,
    stderr,
    teePath: handle.path,
    teeRel,
  };
}
