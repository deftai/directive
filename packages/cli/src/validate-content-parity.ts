#!/usr/bin/env node
/**
 * Golden-output parity harness (#1783 s3): runs BOTH the Python oracles
 * (`validate-links.py`, `validate_strategy_output.py`, `verify_capacity.py`)
 * and the ported TS validate-content gates over shared fixtures, then diffs
 * exit codes + stdout/stderr (cache-off).
 *
 * Exit codes: 0 parity / 1 divergence / 2 harness setup error.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvaluateResult } from "@deftai/core/validate-content";
import {
  validateLinks,
  validateStrategyOutput,
  verifyCapacity,
} from "@deftai/core/validate-content";

export function normalizeOutput(text: string): string {
  return text.replace(
    /verify_capacity: --project-root is not a directory: [^\n]+/g,
    "verify_capacity: --project-root is not a directory: <ROOT>",
  );
}

export interface CommandCapture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityCase {
  readonly gate: "validate-links" | "validate-strategy-output" | "verify-capacity";
  readonly name: string;
  readonly setup: (root: string) => void;
  readonly argv?: string[];
  readonly env?: Record<string, string>;
  readonly now?: string;
}

export interface ParityDiff {
  readonly gate: string;
  readonly caseName: string;
  readonly exitMismatch: boolean;
  readonly stdoutMismatch: boolean;
  readonly stderrMismatch: boolean;
  readonly pythonExit: number;
  readonly tsExit: number;
}

export interface ParityResult {
  readonly ok: boolean;
  readonly diffs: ParityDiff[];
}

const NOW_ISO = "2026-06-04T12:00:00Z";

function runPythonGate(
  deftRoot: string,
  gate: ParityCase["gate"],
  repo: string,
  argv: string[],
  env: Record<string, string>,
): CommandCapture {
  const scriptsDir = join(deftRoot, "scripts").replace(/\\/g, "/");
  const repoPath = repo.replace(/\\/g, "/");
  let code: string;
  if (gate === "validate-links") {
    const strict = argv.includes("--strict") || env.LINK_CHECK_STRICT === "1";
    code = [
      "import sys,os,importlib.util",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      `os.chdir(${JSON.stringify(repoPath)})`,
      strict ? "os.environ['LINK_CHECK_STRICT']='1'" : "os.environ.pop('LINK_CHECK_STRICT', None)",
      `spec=importlib.util.spec_from_file_location('validate_links', ${JSON.stringify(join(deftRoot, "scripts", "validate-links.py"))})`,
      "mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
      `sys.argv = ['validate-links.py'] + ${JSON.stringify(argv)}`,
      "raise SystemExit(mod.main())",
    ].join(";");
  } else if (gate === "validate-strategy-output") {
    code = [
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "from validate_strategy_output import main as m",
      `raise SystemExit(m([${["--project-root", repoPath, ...argv].map((a) => JSON.stringify(a)).join(",")}]))`,
    ].join(";");
  } else {
    code = [
      "import sys",
      "from datetime import datetime",
      "from pathlib import Path",
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      "from verify_capacity import evaluate as ev",
      `root = Path(${JSON.stringify(repoPath)})`,
      `now = datetime.fromisoformat(${JSON.stringify(NOW_ISO)}.replace("Z", "+00:00"))`,
      "code, msg = ev(root, now=now)",
      "stream = sys.stdout if code == 0 else sys.stderr",
      "stream.write(msg)",
      'if not msg.endswith("\\n"):',
      '    stream.write("\\n")',
      "raise SystemExit(code)",
    ].join("\n");
  }

  try {
    const stdout = execFileSync("uv", ["run", "python", "-c", code], {
      cwd: deftRoot,
      encoding: "utf8",
      env: { ...process.env, ...env, DEFT_CACHE_DISABLE: "1", PYTHONUTF8: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 2,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}

function runTsGate(gate: ParityCase["gate"], repo: string, testCase: ParityCase): CommandCapture {
  const argv = testCase.argv ?? [];
  const env = testCase.env ?? {};
  const now = testCase.now ? new Date(testCase.now) : new Date(NOW_ISO);

  let result: EvaluateResult;
  if (gate === "validate-links") {
    result = validateLinks.evaluate({
      cwd: repo,
      argv,
      linkCheckStrict: env.LINK_CHECK_STRICT === "1",
      strict: argv.includes("--strict"),
    });
  } else if (gate === "validate-strategy-output") {
    result = validateStrategyOutput.evaluate({
      projectRoot: repo,
      strict: argv.includes("--strict"),
      quiet: argv.includes("--quiet"),
    });
  } else {
    result = verifyCapacity.evaluate({ projectRoot: repo, now });
  }

  const stream = result.stream;
  return {
    exitCode: result.code,
    stdout: stream === "stdout" ? `${result.message}\n` : "",
    stderr: stream === "stderr" ? `${result.message}\n` : "",
  };
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data)}\n`, { encoding: "utf8" });
}

function makeLifecycle(root: string): void {
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "vbrief", folder), { recursive: true });
  }
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    gate: "validate-links",
    name: "links-clean",
    setup: (root) => {
      writeFileSync(join(root, "README.md"), "See [guide](guide.md)\n", { encoding: "utf8" });
      writeFileSync(join(root, "guide.md"), "# Guide\n", { encoding: "utf8" });
    },
  },
  {
    gate: "validate-links",
    name: "links-broken-warning",
    setup: (root) => {
      writeFileSync(join(root, "README.md"), "See [missing](nope.md)\n", { encoding: "utf8" });
    },
    env: { LINK_CHECK_STRICT: "" },
  },
  {
    gate: "validate-links",
    name: "links-broken-strict",
    setup: (root) => {
      writeFileSync(join(root, "doc.md"), "See [nope](nope.md).\n", { encoding: "utf8" });
    },
    argv: ["--strict"],
  },
  {
    gate: "validate-strategy-output",
    name: "strategy-conformant",
    setup: (root) => {
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}", {
        encoding: "utf8",
      });
      writeFileSync(join(root, "vbrief", "proposed", "2026-05-26-good.vbrief.json"), "{}", {
        encoding: "utf8",
      });
    },
  },
  {
    gate: "validate-strategy-output",
    name: "strategy-missing-projdef",
    setup: (root) => {
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      writeFileSync(join(root, "vbrief", "proposed", "2026-05-26-good.vbrief.json"), "{}", {
        encoding: "utf8",
      });
    },
  },
  {
    gate: "validate-strategy-output",
    name: "strategy-strict-missing-vbrief",
    setup: () => {
      /* empty root */
    },
    argv: ["--strict"],
  },
  {
    gate: "verify-capacity",
    name: "capacity-unconfigured",
    setup: (root) => {
      makeLifecycle(root);
      writeJson(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), {
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "T", status: "running", items: [] },
      });
    },
  },
  {
    gate: "verify-capacity",
    name: "capacity-advise-posture",
    setup: (root) => {
      makeLifecycle(root);
      writeJson(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          policy: {
            capacityAllocation: {
              unit: "vbrief-count",
              window: 30,
              enforcement: "advise",
              minSampleSize: 2,
              defaultBucket: "feature",
              buckets: [
                { id: "debt", target: 0.4 },
                { id: "feature", target: 0.6 },
              ],
            },
          },
        },
      });
      const completedAt = "2026-06-03T12:00:00Z";
      for (let i = 0; i < 4; i += 1) {
        writeJson(join(root, "vbrief", "completed", `feat-${i}.vbrief.json`), {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: `feat-${i}`,
            status: "completed",
            items: [],
            metadata: { capacityBucket: "feature", completedAt },
          },
        });
      }
    },
  },
  {
    gate: "verify-capacity",
    name: "capacity-enforce-deficit",
    setup: (root) => {
      makeLifecycle(root);
      writeJson(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), {
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "T",
          status: "running",
          items: [],
          policy: {
            capacityAllocation: {
              unit: "vbrief-count",
              window: 30,
              enforcement: "enforce",
              minSampleSize: 2,
              defaultBucket: "feature",
              buckets: [
                { id: "debt", target: 0.4 },
                { id: "feature", target: 0.6 },
              ],
            },
          },
        },
      });
      const completedAt = "2026-06-03T12:00:00Z";
      for (let i = 0; i < 4; i += 1) {
        writeJson(join(root, "vbrief", "completed", `feat-${i}.vbrief.json`), {
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: `feat-${i}`,
            status: "completed",
            items: [],
            metadata: { capacityBucket: "feature", completedAt },
          },
        });
      }
    },
  },
  {
    gate: "verify-capacity",
    name: "capacity-config-error",
    setup: (root) => {
      writeFileSync(join(root, "not-a-dir.txt"), "x", { encoding: "utf8" });
    },
  },
];

export function diffCase(
  python: CommandCapture,
  ts: CommandCapture,
  gate: string,
  caseName: string,
): ParityDiff {
  const pyOut = normalizeOutput(python.stdout);
  const tsOut = normalizeOutput(ts.stdout);
  const pyErr = normalizeOutput(python.stderr);
  const tsErr = normalizeOutput(ts.stderr);
  return {
    gate,
    caseName,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: pyOut !== tsOut,
    stderrMismatch: pyErr !== tsErr,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
  };
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

  for (const testCase of PARITY_CASES) {
    const pyRepo = mkdtempSync(join(tmpdir(), "deft-vc-parity-py-"));
    const tsRepo = mkdtempSync(join(tmpdir(), "deft-vc-parity-ts-"));
    try {
      testCase.setup(pyRepo);
      testCase.setup(tsRepo);
      const argv = testCase.argv ?? [];
      const env = testCase.env ?? {};
      const configErrorRoot =
        testCase.name === "capacity-config-error" ? join(pyRepo, "not-a-dir.txt") : pyRepo;
      const tsConfigRoot =
        testCase.name === "capacity-config-error" ? join(tsRepo, "not-a-dir.txt") : tsRepo;
      const python =
        testCase.gate === "verify-capacity" && testCase.name === "capacity-config-error"
          ? runPythonGate(deftRoot, testCase.gate, configErrorRoot, argv, env)
          : runPythonGate(deftRoot, testCase.gate, pyRepo, argv, env);
      const ts =
        testCase.gate === "verify-capacity" && testCase.name === "capacity-config-error"
          ? runTsGate(testCase.gate, tsConfigRoot, testCase)
          : runTsGate(testCase.gate, tsRepo, testCase);
      diffs.push(diffCase(python, ts, testCase.gate, testCase.name));
    } finally {
      rmSync(pyRepo, { recursive: true, force: true });
      rmSync(tsRepo, { recursive: true, force: true });
    }
  }

  const ok = diffs.every((d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch);
  return { ok, diffs };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `validate-content parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} cases.`;
  }
  const lines = ["validate-content parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.stdoutMismatch || d.stderrMismatch) {
      lines.push(`  gate: ${d.gate} case: ${d.caseName}`);
      if (d.exitMismatch) lines.push(`    exit: python=${d.pythonExit} ts=${d.tsExit}`);
      if (d.stdoutMismatch) lines.push("    stdout mismatch");
      if (d.stderrMismatch) lines.push("    stderr mismatch");
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
    process.stderr.write(`validate-content parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}
