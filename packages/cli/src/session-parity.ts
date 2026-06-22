#!/usr/bin/env node
/**
 * Golden-output parity harness (#1787 s1): runs BOTH the Python oracle
 * (`scripts/verify_session_ritual.py`) and the ported TS session core over
 * shared fixtures (cache-off) and diffs JSON stdout + exit codes.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitRunner } from "@deftai/core/session";
import {
  emitVerifyJson,
  newRitualStatePayload,
  ritualStep,
  verifySessionRitual,
  writeRitualState,
} from "@deftai/core/session";

export interface Capture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Fixture {
  readonly root: string;
  readonly head: string;
}

export interface ParityCase {
  readonly name: string;
  readonly setup: () => Fixture;
  readonly tier: "quick" | "gated";
  readonly bypass: boolean;
  readonly nowIso: string;
  readonly runner?: (
    command: readonly string[],
    projectRoot: string,
  ) => { code: number; stdout: string; stderr: string };
}

const FIXED_NOW = "2026-06-09T01:00:00Z";

function initGitRepo(
  policy: Record<string, unknown> = { sessionRitualStalenessHours: 4 },
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "deft-session-parity-"));
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
      plan: { title: "T", status: "running", items: [], policy },
    }),
    "utf8",
  );
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "parity@test.local"], {
    cwd: root,
    encoding: "utf8",
  });
  execFileSync("git", ["config", "user.name", "deft-parity"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "deft-parity",
      GIT_AUTHOR_EMAIL: "parity@test.local",
      GIT_COMMITTER_NAME: "deft-parity",
      GIT_COMMITTER_EMAIL: "parity@test.local",
    },
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, head };
}

function fakeGitRunner(head: string, worktree: string): GitRunner {
  return (_root, args) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      return { code: 0, stdout: head, stderr: "" };
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: worktree, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function writeFreshState(
  fixture: Fixture,
  startedAt: string,
  gated: Record<string, Record<string, unknown>> = {},
): void {
  const now = new Date(startedAt);
  writeRitualState(
    fixture.root,
    newRitualStatePayload({
      sessionId: "parity-session",
      gitHead: fixture.head,
      worktreePath: resolve(fixture.root),
      startedAt: now,
      quickSteps: {
        alignment: ritualStep({ ok: true, ts: now }),
        branch_policy: ritualStep({ ok: true, ts: now }),
        triage_welcome: ritualStep({ ok: true, ts: now }),
      },
      gatedSteps: gated,
    }),
  );
}

function loadPyModule(_deftRoot: string, name: string, rel: string): string {
  return `spec = importlib.util.spec_from_file_location(${JSON.stringify(name)}, root / ${JSON.stringify(rel)})
mod = importlib.util.module_from_spec(spec)
sys.modules[${JSON.stringify(name)}] = mod
spec.loader.exec_module(mod)`;
}

function runPythonVerify(deftRoot: string, fixture: Fixture, scenario: ParityCase): Capture {
  const runnerSnippet = scenario.runner
    ? `def runner(args, cwd):
    return (0, "OK", "")`
    : "";
  const script = `import importlib.util, json, sys
from datetime import datetime, UTC
from pathlib import Path
root = Path(${JSON.stringify(deftRoot)})
fixture = Path(${JSON.stringify(fixture.root)})
${loadPyModule(deftRoot, "verify_session_ritual", "scripts/verify_session_ritual.py")}
${runnerSnippet}
now = datetime.fromisoformat(${JSON.stringify(scenario.nowIso.replace("Z", "+00:00"))})
kwargs = dict(tier=${JSON.stringify(scenario.tier)}, now=now, bypass=${scenario.bypass ? "True" : "False"})
${scenario.runner ? "kwargs['runner'] = runner" : ""}
result = mod.verify(fixture, **kwargs)
print(json.dumps({"ready": result.code == 0, "exit_code": result.code, "tier": result.tier, "message": result.message, "state_path": str(result.state_path), "bypassed": result.bypassed, "would_fail_code": result.would_fail_code}, sort_keys=True))
sys.exit(result.code)`;
  const result = spawnSync("uv", ["run", "python", "-c", script], {
    cwd: deftRoot,
    encoding: "utf8",
    env: { ...process.env, DEFT_CACHE_DISABLE: "1", PYTHONUTF8: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: result.status ?? 2,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function runTsVerify(fixture: Fixture, scenario: ParityCase): Capture {
  const result = verifySessionRitual(fixture.root, {
    tier: scenario.tier,
    now: new Date(scenario.nowIso),
    bypass: scenario.bypass,
    runGit: fakeGitRunner(fixture.head, resolve(fixture.root)),
    runner: scenario.runner,
  });
  return {
    exitCode: result.code,
    stdout: `${emitVerifyJson(result)}\n`,
    stderr: "",
  };
}

const mockGatedRunner = (): ParityCase["runner"] => () => ({
  code: 0,
  stdout: "OK",
  stderr: "",
});

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "quick-tier",
    setup() {
      const fixture = initGitRepo();
      writeFreshState(fixture, FIXED_NOW);
      return fixture;
    },
    tier: "quick",
    bypass: false,
    nowIso: FIXED_NOW,
  },
  {
    name: "gated-tier",
    setup() {
      const fixture = initGitRepo();
      writeFreshState(fixture, FIXED_NOW);
      return fixture;
    },
    tier: "gated",
    bypass: false,
    nowIso: FIXED_NOW,
    runner: mockGatedRunner(),
  },
  {
    name: "stale-expiry",
    setup() {
      const fixture = initGitRepo({ sessionRitualStalenessHours: 1 });
      writeFreshState(fixture, "2026-06-08T00:00:00Z");
      return fixture;
    },
    tier: "quick",
    bypass: false,
    nowIso: FIXED_NOW,
  },
  {
    name: "defer",
    setup() {
      const fixture = initGitRepo();
      const now = new Date(FIXED_NOW);
      writeRitualState(
        fixture.root,
        newRitualStatePayload({
          sessionId: "parity-session",
          gitHead: fixture.head,
          worktreePath: resolve(fixture.root),
          startedAt: now,
          quickSteps: {
            alignment: ritualStep({ ok: true, ts: now }),
            branch_policy: ritualStep({ ok: true, ts: now }),
            triage_welcome: ritualStep({ ok: true, ts: now }),
          },
          gatedSteps: {
            doctor: ritualStep({ ok: true, ts: now, deferredReason: "operator deferred" }),
            cache_fresh: ritualStep({ ok: true, ts: now, deferredReason: "operator deferred" }),
          },
        }),
      );
      return fixture;
    },
    tier: "gated",
    bypass: false,
    nowIso: FIXED_NOW,
  },
  {
    name: "skip",
    setup() {
      return initGitRepo();
    },
    tier: "quick",
    bypass: true,
    nowIso: FIXED_NOW,
  },
];

export interface ParityDiff {
  readonly name: string;
  readonly exitMismatch: boolean;
  readonly stdoutMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
  readonly pythonStdout: string;
  readonly tsStdout: string;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function runParity(): ParityResult {
  const deftRoot = resolveDeftRoot();
  const diffs: ParityDiff[] = [];
  for (const scenario of PARITY_CASES) {
    const fixture = scenario.setup();
    try {
      const py = runPythonVerify(deftRoot, fixture, scenario);
      const ts = runTsVerify(fixture, scenario);
      diffs.push({
        name: scenario.name,
        exitMismatch: py.exitCode !== ts.exitCode,
        stdoutMismatch: py.stdout !== ts.stdout,
        pythonExit: py.exitCode,
        tsExit: ts.exitCode,
        pythonStdout: py.stdout,
        tsStdout: ts.stdout,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  const ok = diffs.every((d) => !d.exitMismatch && !d.stdoutMismatch);
  return { ok, diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `session parity: CLEAN -- Python and TS agree on ${result.diffs.length} case(s).`;
  }
  const lines = ["session parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.stdoutMismatch) {
      lines.push(`  case: ${d.name}`);
      if (d.exitMismatch) {
        lines.push(`    exit mismatch: python=${d.pythonExit} ts=${d.tsExit}`);
      }
      if (d.stdoutMismatch) {
        lines.push(`    python stdout: ${JSON.stringify(d.pythonStdout)}`);
        lines.push(`    ts stdout: ${JSON.stringify(d.tsStdout)}`);
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
    process.stderr.write(`session parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
