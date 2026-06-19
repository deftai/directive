#!/usr/bin/env node
/**
 * Golden-output parity harness (#1784): compares TS intake modules vs Python oracle via python -c.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildIssueVbrief,
  CandidatesLogError,
  extractCrossRefs,
  IssueState,
  reconcile,
  renderIssueBody,
  resultToDict,
  validateCandidatesEntry,
  validateGithubAuth,
} from "@deftai/core/intake";
import {
  PARITY_SCENARIO_NAMES,
  type ParityScenarioName,
  SAMPLE_ISSUE,
  SAMPLE_VBRIEF,
} from "@deftai/core/intake/parity-scenarios";
import { pythonJsonStringify } from "@deftai/core/scm";

export interface Capture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityCase {
  readonly name: ParityScenarioName;
  readonly runPython: (deftRoot: string) => Capture;
  readonly runTs: (deftRoot: string) => Capture;
}

function capture(exitCode: number, stdout: string, stderr = ""): Capture {
  return { exitCode, stdout, stderr };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${pythonJsonStringify(sortKeysDeep(value))}\n`;
}

function runPythonScript(deftRoot: string, script: string): Capture {
  const code = `import importlib.util, json, sys\nfrom pathlib import Path\nroot = Path(${JSON.stringify(deftRoot)})\nsys.path.insert(0, str(root / "scripts"))\n${script}`;
  const result = spawnSync("uv", ["run", "python", "-c", code], {
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

function loadModule(name: string, rel: string): string {
  return `spec = importlib.util.spec_from_file_location(${JSON.stringify(name)}, root / ${JSON.stringify(rel)})
mod = importlib.util.module_from_spec(spec)
sys.modules[${JSON.stringify(name)}] = mod
spec.loader.exec_module(mod)`;
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "issue-ingest-build-vbrief",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("issue_ingest", "scripts/issue_ingest.py")}
issue = ${JSON.stringify(SAMPLE_ISSUE)}
vbrief, folder = mod._build_issue_vbrief(issue, "proposed", "https://github.com/owner/repo")
print(json.dumps({"folder": folder, "vbrief": vbrief}, ensure_ascii=False, sort_keys=True))
sys.exit(0)`,
      );
    },
    runTs() {
      const [vbrief, folder] = buildIssueVbrief(
        SAMPLE_ISSUE as unknown as Record<string, unknown>,
        "proposed",
        "https://github.com/owner/repo",
      );
      return capture(0, stableJson({ folder, vbrief }));
    },
  },
  {
    name: "issue-ingest-cross-refs",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("issue_ingest", "scripts/issue_ingest.py")}
body = "Closes #10\\nRefs #11\\nBlocked by #12"
refs = mod._extract_cross_refs(body, "https://github.com/o/r", exclude={10})
print(json.dumps(refs, ensure_ascii=False, sort_keys=True))
sys.exit(0)`,
      );
    },
    runTs() {
      const refs = extractCrossRefs(
        "Closes #10\nRefs #11\nBlocked by #12",
        "https://github.com/o/r",
        new Set([10]),
      );
      return capture(0, stableJson(refs));
    },
  },
  {
    name: "issue-emit-render-body",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("issue_emit", "scripts/issue_emit.py")}
data = ${JSON.stringify(SAMPLE_VBRIEF)}
print(mod.render_issue_body(data), end="")
sys.exit(0)`,
      );
    },
    runTs() {
      return capture(0, renderIssueBody(SAMPLE_VBRIEF as unknown as Record<string, unknown>));
    },
  },
  {
    name: "reconcile-classify",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("reconcile_issues", "scripts/reconcile_issues.py")}
report = mod.reconcile({1: ["proposed/a.vbrief.json"]}, {1: mod.IssueState("OPEN")})
print(json.dumps(report, ensure_ascii=False, sort_keys=True))
sys.exit(0)`,
      );
    },
    runTs() {
      const report = reconcile(
        new Map([[1, ["proposed/a.vbrief.json"]]]),
        new Map([[1, new IssueState("OPEN")]]),
      );
      return capture(0, stableJson(report));
    },
  },
  {
    name: "candidates-validate-reject",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("candidates_log", "scripts/candidates_log.py")}
try:
    mod._validate_entry({"decision": "accept"})
except mod.CandidatesLogError as exc:
    print(str(exc))
    sys.exit(1)
sys.exit(0)`,
      );
    },
    runTs() {
      try {
        validateCandidatesEntry({ decision: "accept" });
        return capture(0, "");
      } catch (exc) {
        if (exc instanceof CandidatesLogError) {
          return capture(1, `${exc.message}\n`);
        }
        throw exc;
      }
    },
  },
  {
    name: "github-auth-invalid-mode",
    runPython(deftRoot) {
      return runPythonScript(
        deftRoot,
        `${loadModule("github_auth_modes", "scripts/github_auth_modes.py")}
result = mod.validate_github_auth("bogus", environ={})
print(json.dumps(result.to_dict(), ensure_ascii=False, sort_keys=True))
sys.exit(0)`,
      );
    },
    runTs() {
      const result = validateGithubAuth("bogus", { environ: {} });
      return capture(0, stableJson(resultToDict(result)));
    },
  },
];

export interface ParityDiff {
  readonly name: string;
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

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function diffCase(python: Capture, ts: Capture, name: string): ParityDiff {
  return {
    name,
    exitMismatch: python.exitCode !== ts.exitCode,
    stdoutMismatch: python.stdout !== ts.stdout,
    stderrMismatch: python.stderr !== ts.stderr,
    pythonExit: python.exitCode,
    tsExit: ts.exitCode,
  };
}

export function runParity(deftRoot = resolveDeftRoot()): ParityResult {
  const diffs: ParityDiff[] = [];
  for (const testCase of PARITY_CASES) {
    diffs.push(diffCase(testCase.runPython(deftRoot), testCase.runTs(deftRoot), testCase.name));
  }
  return {
    ok: diffs.every((d) => !d.exitMismatch && !d.stdoutMismatch && !d.stderrMismatch),
    diffs,
  };
}

export function renderReport(result: ParityResult): string {
  if (result.ok) {
    return `intake parity: CLEAN -- Python and TS agree on ${PARITY_CASES.length} case(s).`;
  }
  const lines = ["intake parity: DIVERGENCE"];
  for (const d of result.diffs) {
    if (d.exitMismatch || d.stdoutMismatch || d.stderrMismatch) {
      lines.push(`  case: ${d.name}`);
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
    process.stderr.write(`intake parity: harness error -- ${String(err)}\n`);
    process.exit(2);
  }
}

export { PARITY_SCENARIO_NAMES };
