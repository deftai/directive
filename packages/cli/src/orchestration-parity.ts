#!/usr/bin/env node
/**
 * Golden-output parity harness (#1788 s2): runs BOTH the Python oracles
 * (subagent_monitor, probe_session, verify_investigation, verify_judgment_gates)
 * and the ported TS CLI modules with cache-off, then diffs exit codes and output.
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ScenarioResult {
  readonly name: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityScenario {
  readonly name: string;
  readonly module:
    | "subagent_monitor"
    | "probe_session"
    | "verify_investigation"
    | "verify_judgment_gates";
  readonly argv: readonly string[];
  readonly setup?: (root: string) => void;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly scenarios: Array<{
    readonly name: string;
    readonly exitMismatch: boolean;
    readonly pythonExit: number;
    readonly tsExit: number;
    readonly stdoutMismatch: boolean;
    readonly stderrMismatch: boolean;
    readonly pythonStdout: string;
    readonly tsStdout: string;
    readonly pythonStderr: string;
    readonly tsStderr: string;
  }>;
}

function closeReadyLedger(): Record<string, unknown> {
  return {
    vBRIEFInfo: { version: "0.6" },
    plan: {
      id: "2026-06-14-example",
      title: "Why did X happen?",
      status: "completed",
      items: [
        {
          id: "branch.slowness",
          title: "Why slow",
          status: "completed",
          items: [
            {
              id: "claim.slowness.M1",
              title: "embed contention",
              status: "completed",
              metadata: { "x-claim": { evidenceRefs: ["EV-001"] } },
            },
          ],
        },
        {
          id: "branch.queue",
          title: "Queue wait",
          status: "failed",
          items: [
            {
              id: "claim.queue.B1",
              title: "saturation",
              status: "failed",
              metadata: {
                "x-claim": {
                  ruledOutReason: "active=2, cap=8",
                  evidenceRefs: ["EV-002"],
                },
              },
            },
          ],
        },
      ],
      edges: [{ from: "claim.queue.B1", to: "branch.queue", type: "invalidates" }],
      references: [
        { id: "EV-001", type: "log-excerpt" },
        { id: "EV-002", type: "metric-snapshot" },
      ],
      metadata: {
        "x-investigation": {
          profile: "forensic-research-v1",
          wavesCompleted: { "1": true, "2": true, "3": true, "4": true },
        },
      },
    },
  };
}

function blockedLedger(): Record<string, unknown> {
  const data = closeReadyLedger() as Record<string, Record<string, unknown>>;
  (data.plan as Record<string, unknown>).status = "running";
  return data;
}

function isoMinutesAgo(minutes: number): string {
  const d = new Date(Date.now() - minutes * 60 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function writeHeartbeat(
  scratch: string,
  agentId: string,
  minutesAgo: number,
  phase = "polling",
): void {
  mkdirSync(scratch, { recursive: true });
  writeFileSync(
    join(scratch, `${agentId}.json`),
    JSON.stringify({
      agent_id: agentId,
      parent_id: "parent-test",
      last_heartbeat_at: isoMinutesAgo(minutesAgo),
      last_message: "polling Greptile",
      phase,
      terminal_state: null,
    }),
    "utf8",
  );
}

function setupProjectDefinition(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
  mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
  mkdirSync(join(root, "vbrief", "active"), { recursive: true });
  mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
  mkdirSync(join(root, "vbrief", "cancelled"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "parity", status: "running", items: [], policy },
    }),
    "utf8",
  );
}

export const PARITY_SCENARIOS: readonly ParityScenario[] = [
  {
    name: "monitor-empty-scratch",
    module: "subagent_monitor",
    argv: ["--json"],
    setup: (root) => {
      mkdirSync(join(root, ".deft-scratch", "subagent-status"), { recursive: true });
    },
  },
  {
    name: "monitor-fresh-heartbeat",
    module: "subagent_monitor",
    argv: ["--json", "--threshold-minutes", "30"],
    setup: (root) => {
      writeHeartbeat(join(root, ".deft-scratch", "subagent-status"), "agent-fresh", 1);
    },
  },
  {
    name: "monitor-stale-heartbeat",
    module: "subagent_monitor",
    argv: ["--json", "--threshold-minutes", "30"],
    setup: (root) => {
      writeHeartbeat(join(root, ".deft-scratch", "subagent-status"), "agent-stale", 45);
    },
  },
  {
    name: "monitor-missing-scratch-dir",
    module: "subagent_monitor",
    argv: ["--scratch-dir", ".deft-scratch/missing-status", "--json"],
  },
  {
    name: "probe-session-guard-artifact-blocked",
    module: "probe_session",
    argv: ["guard-artifact", "--path", "vbrief/proposed/auth-probe.vbrief.json"],
    setup: (root) => {
      mkdirSync(join(root, ".deft"), { recursive: true });
      writeFileSync(
        join(root, ".deft", "probe-session.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          state: "interrogate",
          target: "auth-probe",
          currentBranch: "tokens",
          resolvedDecisions: [],
          startedAt: "2026-06-19T12:00:00Z",
        })}\n`,
        "utf8",
      );
    },
  },
  {
    name: "probe-session-complete-then-guard",
    module: "probe_session",
    argv: ["guard-artifact", "--path", "vbrief/proposed/auth-probe.vbrief.json"],
    setup: (root) => {
      mkdirSync(join(root, ".deft"), { recursive: true });
      writeFileSync(
        join(root, ".deft", "probe-session.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          state: "complete",
          target: "auth-probe",
          currentBranch: "tokens",
          resolvedDecisions: [{ question: "Q?", answer: "A.", status: "locked" }],
          startedAt: "2026-06-19T12:00:00Z",
          completedAt: "2026-06-19T13:00:00Z",
        })}\n`,
        "utf8",
      );
    },
  },
  {
    name: "investigation-close-clean",
    module: "verify_investigation",
    argv: ["--ledger", "ledger.json"],
    setup: (root) => {
      writeFileSync(join(root, "ledger.json"), `${JSON.stringify(closeReadyLedger())}\n`, "utf8");
    },
  },
  {
    name: "investigation-close-blocked",
    module: "verify_investigation",
    argv: ["--ledger", "ledger.json"],
    setup: (root) => {
      writeFileSync(join(root, "ledger.json"), `${JSON.stringify(blockedLedger())}\n`, "utf8");
    },
  },
  {
    name: "judgment-gate-advise-secrets",
    module: "verify_judgment_gates",
    argv: ["--path", "secrets/prod.env"],
    setup: (root) => setupProjectDefinition(root),
  },
  {
    name: "judgment-gate-enforce-secrets-blocked",
    module: "verify_judgment_gates",
    argv: ["--enforce", "--path", "secrets/prod.env", "--quiet"],
    setup: (root) => setupProjectDefinition(root),
  },
];

const TS_SCRIPT: Record<ParityScenario["module"], string> = {
  subagent_monitor: "subagent-monitor.js",
  probe_session: "probe-session.js",
  verify_investigation: "verify-investigation.js",
  verify_judgment_gates: "verify-judgment-gates.js",
};

const PY_SCRIPT: Record<ParityScenario["module"], string> = {
  subagent_monitor: "subagent_monitor.py",
  probe_session: "probe_session.py",
  verify_investigation: "verify_investigation.py",
  verify_judgment_gates: "verify_judgment_gates.py",
};

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function runCapture(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Capture {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 2,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function normaliseHarnessNoise(text: string): string {
  let out = text
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("Using CPython") &&
        !line.startsWith("Creating virtual environment") &&
        !line.startsWith("Installed "),
    )
    .join("\n");
  // Monitor JSON emits wall-clock `now` / age_seconds — normalise volatile fields.
  if (out.trimStart().startsWith("{")) {
    try {
      const obj = JSON.parse(out) as Record<string, unknown>;
      if (typeof obj.now === "string") {
        delete obj.now;
        if (Array.isArray(obj.records)) {
          for (const rec of obj.records) {
            if (typeof rec === "object" && rec !== null && !Array.isArray(rec)) {
              delete (rec as Record<string, unknown>).age_seconds;
            }
          }
        }
        out = JSON.stringify(obj, null, 2);
      }
    } catch {
      // not JSON — leave as-is
    }
  }
  return out;
}

export function diffParity(
  python: ScenarioResult,
  ts: ScenarioResult,
): { exitMismatch: boolean; stdoutMismatch: boolean; stderrMismatch: boolean } {
  const pythonStdout = normaliseHarnessNoise(python.stdout);
  const tsStdout = normaliseHarnessNoise(ts.stdout);
  const pythonStderr = normaliseHarnessNoise(python.stderr);
  const tsStderr = normaliseHarnessNoise(ts.stderr);
  return {
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: pythonStdout !== tsStdout,
    stderrMismatch: pythonStderr !== tsStderr,
  };
}

function runScenario(
  deftRoot: string,
  scenario: ParityScenario,
): { python: ScenarioResult; ts: ScenarioResult } {
  const root = mkdtempSync(join(tmpdir(), "deft-orchestration-parity-"));
  try {
    if (scenario.setup) {
      scenario.setup(root);
    }
    const env = {
      DEFT_CACHE_DISABLE: "1",
      PYTHONUTF8: "1",
    };
    const pyScript = join(deftRoot, "scripts", PY_SCRIPT[scenario.module]);
    const pyArgs = ["run", "python", pyScript];
    if (scenario.module === "probe_session" || scenario.module === "verify_judgment_gates") {
      pyArgs.push("--project-root", root, ...scenario.argv);
    } else if (scenario.module === "verify_investigation") {
      pyArgs.push(
        ...scenario.argv.map((a) => (a === "ledger.json" ? join(root, "ledger.json") : a)),
      );
      pyArgs.push("--project-root", root);
    } else {
      pyArgs.push(...scenario.argv);
    }

    const tsScript = join(deftRoot, "packages", "cli", "dist", TS_SCRIPT[scenario.module]);
    const tsArgs = [tsScript];
    if (scenario.module === "probe_session" || scenario.module === "verify_judgment_gates") {
      tsArgs.push("--project-root", root, ...scenario.argv);
    } else if (scenario.module === "verify_investigation") {
      tsArgs.push(
        ...scenario.argv.map((a) => (a === "ledger.json" ? join(root, "ledger.json") : a)),
      );
      tsArgs.push("--project-root", root);
    } else {
      tsArgs.push(...scenario.argv);
    }

    const py = runCapture(
      "uv",
      pyArgs,
      scenario.module === "subagent_monitor" ? root : deftRoot,
      env,
    );
    const ts = runCapture(
      "node",
      tsArgs,
      scenario.module === "subagent_monitor" ? root : deftRoot,
      env,
    );

    return {
      python: { name: scenario.name, exitCode: py.status, stdout: py.stdout, stderr: py.stderr },
      ts: { name: scenario.name, exitCode: ts.status, stdout: ts.stdout, stderr: ts.stderr },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  process.env.DEFT_ROOT = deftRoot;
  const scenarios: ParityResult["scenarios"] = [];
  for (const scenario of PARITY_SCENARIOS) {
    const ran = runScenario(deftRoot, scenario);
    const diff = diffParity(ran.python, ran.ts);
    scenarios.push({
      name: scenario.name,
      pythonExit: ran.python.exitCode,
      tsExit: ran.ts.exitCode,
      pythonStdout: normaliseHarnessNoise(ran.python.stdout),
      tsStdout: normaliseHarnessNoise(ran.ts.stdout),
      pythonStderr: normaliseHarnessNoise(ran.python.stderr),
      tsStderr: normaliseHarnessNoise(ran.ts.stderr),
      ...diff,
    });
  }
  const ok = scenarios.every((s) => !s.exitMismatch && !s.stdoutMismatch && !s.stderrMismatch);
  return { ok, scenarios };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `orchestration parity: CLEAN -- Python and TS agree on ${result.scenarios.length} case(s).`;
  }
  const lines = ["orchestration parity: DIVERGENCE"];
  for (const s of result.scenarios) {
    if (s.exitMismatch || s.stdoutMismatch || s.stderrMismatch) {
      lines.push(`  scenario: ${s.name}`);
      if (s.exitMismatch) {
        lines.push(`    exit mismatch: python=${s.pythonExit} ts=${s.tsExit}`);
      }
      if (s.stdoutMismatch) {
        lines.push(
          `    stdout mismatch (python ${s.pythonStdout.length} / ts ${s.tsStdout.length} bytes)`,
        );
      }
      if (s.stderrMismatch) {
        lines.push(
          `    stderr mismatch (python ${s.pythonStderr.length} / ts ${s.tsStderr.length} bytes)`,
        );
      }
    }
  }
  return lines.join("\n");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = runParity();
    if (result.ok) {
      process.stdout.write(`${renderReport(result)}\n`);
      process.exit(0);
    }
    process.stderr.write(`${renderReport(result)}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(`orchestration parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
