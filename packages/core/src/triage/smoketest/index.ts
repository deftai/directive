#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FIXTURE_REL = "tests/fixtures/triage_smoketest";
export const LAST_RUN_FILENAME = "last_run.json";
export const TOTAL_STAGES = 9;

export const STAGE_LABELS: readonly string[] = [
  "",
  "bootstrap + auto-classify",
  "audit decision counts",
  "queue ranking determinism",
  "defer with resume-on",
  "evaluate-resume marker",
  "scope:promote (D18 fallback)",
  "scope:demote single-file",
  "scope:undo idempotency",
  "triage:summary bounded output",
];

export const FIXTURE_REPO = "deftai/smoketest";
const WARN_GLYPH = "\u26a0";
const SUMMARY_MAX_CHARS = 120;

export class SmoketestError extends Error {
  readonly stage: number;
  readonly failureName: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly failureCause: string;

  constructor(stage: number, name: string, expected: unknown, actual: unknown, cause: string) {
    super(
      `[${stage}/${TOTAL_STAGES}] ${name} FAIL: expected=${JSON.stringify(expected)} ` +
        `actual=${JSON.stringify(actual)} cause=${cause}`,
    );
    this.stage = stage;
    this.failureName = name;
    this.expected = expected;
    this.actual = actual;
    this.failureCause = cause;
  }
}

export interface AssertRecord {
  stage: number;
  name: string;
  status: string;
  detail?: string;
  expected?: unknown;
  actual?: unknown;
  cause?: string;
  reason?: string;
}

export class AssertLog {
  readonly records: AssertRecord[] = [];
  readonly verbose: boolean;

  constructor(options: { verbose: boolean }) {
    this.verbose = options.verbose;
  }

  private emit(stage: number, suffix: string): void {
    const label = stage >= 1 && stage < STAGE_LABELS.length ? STAGE_LABELS[stage] : "stage";
    const prefix = `[${stage}/${TOTAL_STAGES}] ${label} `.padEnd(56, ".");
    process.stderr.write(`${prefix} ${suffix}\n`);
  }

  passed(stage: number, name: string, detail = ""): void {
    this.records.push({ stage, name, status: "PASS", detail });
    if (this.verbose) {
      this.emit(stage, "PASS");
    }
  }

  fail(
    stage: number,
    name: string,
    options: { expected: unknown; actual: unknown; cause: string },
  ): SmoketestError {
    this.records.push({
      stage,
      name,
      status: "FAIL",
      expected: options.expected,
      actual: options.actual,
      cause: options.cause,
    });
    return new SmoketestError(stage, name, options.expected, options.actual, options.cause);
  }

  skipped(stage: number, name: string, reason: string): void {
    this.records.push({ stage, name, status: "SKIP", reason });
    if (this.verbose) {
      this.emit(stage, `SKIP (${reason})`);
    }
  }

  writeJson(path: string, options: { exitCode: number; fixtureRepo: string }): void {
    const payload = {
      schema: "deft.triage.smoketest.v1",
      fixture_repo: options.fixtureRepo,
      emitted_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      exit_code: options.exitCode,
      stage_count: TOTAL_STAGES,
      records: this.records,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8" });
  }
}

export interface ScriptCapture {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScriptRunner {
  run(
    scriptName: string,
    args: readonly string[],
    options: { projectRoot: string; includeRepoEnv?: boolean; extraEnv?: Record<string, string> },
  ): ScriptCapture;
}

export interface SmoketestDeps {
  readonly scriptsDir: string;
  readonly scriptRunner: ScriptRunner;
  readonly runInlinePython?: (code: string, stdin: string, cwd: string) => ScriptCapture;
}

function defaultScriptRunner(scriptsDir: string): ScriptRunner {
  return {
    run(scriptName, args, options) {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PYTHONUTF8: "1",
        DEFT_PROJECT_ROOT: options.projectRoot,
      };
      if (options.includeRepoEnv !== false) {
        env.DEFT_TRIAGE_REPO = FIXTURE_REPO;
      } else {
        delete env.DEFT_TRIAGE_REPO;
      }
      if (options.extraEnv !== undefined) {
        Object.assign(env, options.extraEnv);
      }
      const result = spawnSync("uv", ["run", "python", join(scriptsDir, scriptName), ...args], {
        cwd: options.projectRoot,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return {
        returncode: result.status ?? 2,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
      };
    },
  };
}

export function copyFixtureToTmp(fixtureRoot: string, tmpRoot: string): string {
  const project = tmpRoot;
  mkdirSync(project, { recursive: true });
  mkdirSync(join(project, "vbrief"), { recursive: true });
  copyFileSync(
    join(fixtureRoot, "PROJECT-DEFINITION.vbrief.json"),
    join(project, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
  );
  for (const sub of ["active", "proposed", "pending", "completed", "cancelled"] as const) {
    const srcDir = join(fixtureRoot, "vbrief", sub);
    const dstDir = join(project, "vbrief", sub);
    mkdirSync(dstDir, { recursive: true });
    if (existsSync(srcDir)) {
      for (const name of readdirSync(srcDir)) {
        if (name.endsWith(".vbrief.json")) {
          copyFileSync(join(srcDir, name), join(dstDir, name));
        }
      }
    }
  }
  mkdirSync(join(project, "vbrief", ".eval"), { recursive: true });
  return project;
}

function defaultInlineRunner(): NonNullable<SmoketestDeps["runInlinePython"]> {
  return (code, stdin, cwd) => {
    const result = spawnSync("uv", ["run", "python", "-c", code], {
      input: stdin,
      encoding: "utf8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      returncode: result.status ?? 2,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  };
}

export function renderCache(
  projectRoot: string,
  issuesSpec: Record<string, unknown>,
  scriptsDir: string,
  runInline: NonNullable<SmoketestDeps["runInlinePython"]> = defaultInlineRunner(),
  cwd = dirname(scriptsDir),
): void {
  const py = `
import json, sys
from datetime import datetime
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
from cache import cache_put
spec = json.loads(sys.stdin.read())
now_dt = datetime.fromisoformat(spec['now_iso'].replace('Z', '+00:00'))
repo = spec['repo']
cache_root = Path(${JSON.stringify(projectRoot)}) / '.deft-cache'
for issue in spec['issues']:
    n = int(issue['number'])
    raw = {
        'number': n,
        'title': issue['title'],
        'state': issue.get('state', 'open'),
        'labels': [{'name': label} for label in issue.get('labels', [])],
        'body': issue.get('body', ''),
        'updated_at': issue.get('updated_at', spec['now_iso']),
        'created_at': issue.get('created_at', spec['now_iso']),
        'url': f'https://api.github.com/repos/{repo}/issues/{n}',
        'html_url': f'https://github.com/{repo}/issues/{n}',
    }
    cache_put('github-issue', f'{repo}/{n}', raw, cache_root=cache_root, fetched_at=now_dt)
`;
  const result = runInline(py, JSON.stringify(issuesSpec), cwd);
  if (result.returncode !== 0) {
    throw new Error(`renderCache failed: ${result.stderr}`);
  }
}

export function runSmoketest(
  fixtureRoot: string,
  options: {
    verbose?: boolean;
    keepTempdir?: boolean;
    cacheOnly?: boolean;
    deftRoot?: string;
    deps?: SmoketestDeps;
  } = {},
): number {
  const deftRoot =
    options.deftRoot ??
    (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0
      ? resolve(process.env.DEFT_ROOT)
      : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".."));
  const scriptsDir = join(deftRoot, "scripts");
  const deps: SmoketestDeps = options.deps ?? {
    scriptsDir,
    scriptRunner: defaultScriptRunner(scriptsDir),
  };
  const runInline = deps.runInlinePython ?? defaultInlineRunner();

  const lastRunPath = join(fixtureRoot, LAST_RUN_FILENAME);
  const log = new AssertLog({ verbose: options.verbose ?? false });

  const issuesSpecPath = join(fixtureRoot, "issues.json");
  if (!existsSync(issuesSpecPath)) {
    process.stderr.write(
      `[triage:smoketest] FAIL: fixture issues.json not found at ${issuesSpecPath}\n`,
    );
    log.records.push({
      stage: 0,
      name: "fixture-load",
      status: "FAIL",
      cause: `issues.json missing at ${issuesSpecPath}`,
    });
    log.writeJson(lastRunPath, { exitCode: 1, fixtureRepo: FIXTURE_REPO });
    return 1;
  }
  const issuesSpec = JSON.parse(readFileSync(issuesSpecPath, { encoding: "utf8" })) as Record<
    string,
    unknown
  >;

  const tmpDir = mkdtempSync(join(tmpdir(), "deft-triage-smoketest-"));
  try {
    const projectRoot = copyFixtureToTmp(fixtureRoot, join(tmpDir, "project"));
    renderCache(projectRoot, issuesSpec, deps.scriptsDir, runInline, deftRoot);

    const stageRunner = `
import json, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(deps.scriptsDir)})
from triage_smoketest import AssertLog, TOTAL_STAGES, STAGE_LABELS
import _triage_smoketest_stages as stages

payload = json.loads(sys.stdin.read())
project_root = Path(payload['project_root'])
issues_spec = payload['issues_spec']
cache_only = payload['cache_only']
verbose = payload['verbose']
log = AssertLog(verbose=verbose)
try:
    stages.stage_bootstrap_and_classify(project_root, issues_spec, log)
    stages.stage_audit_counts(project_root, log)
    stages.stage_queue_determinism(project_root, log)
    prior = stages.stage_defer_resume_on(project_root, log)
    stages.stage_evaluate_resume(project_root, prior, log)
    if cache_only:
        for stage in (6, 7, 8):
            label = STAGE_LABELS[stage] if stage < len(STAGE_LABELS) else f'stage-{stage}'
            log.skipped(stage, label, reason='--cache-only')
    else:
        pending = stages.stage_scope_promote(project_root, log)
        stages.stage_scope_demote(project_root, pending, log)
        stages.stage_scope_undo(project_root, log)
    stages.stage_triage_summary(project_root, log)
    print(json.dumps({'exit_code': 0, 'records': log.records}))
except Exception as e:
    import traceback
    from triage_smoketest import SmoketestError
    if isinstance(e, SmoketestError):
        print(json.dumps({'exit_code': 1, 'records': log.records, 'error': str(e)}))
    else:
        print(json.dumps({'exit_code': 1, 'records': log.records, 'error': traceback.format_exc()}))
        raise
`;
    const result = runInline(
      stageRunner,
      JSON.stringify({
        project_root: projectRoot,
        issues_spec: issuesSpec,
        cache_only: options.cacheOnly ?? false,
        verbose: options.verbose ?? false,
      }),
      deftRoot,
    );
    if (result.returncode !== 0) {
      process.stderr.write(`[triage:smoketest] stage runner failed: ${result.stderr}\n`);
      log.writeJson(lastRunPath, { exitCode: 1, fixtureRepo: FIXTURE_REPO });
      return 1;
    }
    const payload = JSON.parse(result.stdout) as {
      exit_code: number;
      records: AssertRecord[];
      error?: string;
    };
    log.records.push(...payload.records);
    if (payload.exit_code !== 0) {
      if (payload.error !== undefined) {
        process.stderr.write(`${payload.error}\n`);
      }
      log.writeJson(lastRunPath, { exitCode: 1, fixtureRepo: FIXTURE_REPO });
      return 1;
    }

    log.writeJson(lastRunPath, { exitCode: 0, fixtureRepo: FIXTURE_REPO });
    if (options.verbose) {
      process.stderr.write("[triage:smoketest] exit 0\n");
    }
    return 0;
  } catch (failure: unknown) {
    if (failure instanceof SmoketestError) {
      process.stderr.write(`${failure.message}\n`);
    }
    log.writeJson(lastRunPath, { exitCode: 1, fixtureRepo: FIXTURE_REPO });
    return 1;
  } finally {
    if (options.keepTempdir) {
      process.stderr.write(
        `[triage:smoketest] --keep-tempdir: temp working dir preserved at ${tmpDir}\n`,
      );
    } else {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export function parseSmoketestArgs(argv: readonly string[]): {
  fixture: string;
  verbose: boolean;
  keepTempdir: boolean;
  cacheOnly: boolean;
  showHelp: boolean;
  error?: string;
} {
  const parsed = {
    fixture: "",
    verbose: false,
    keepTempdir: false,
    cacheOnly: false,
    showHelp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--keep-tempdir") {
      parsed.keepTempdir = true;
    } else if (arg === "--cache-only") {
      parsed.cacheOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.showHelp = true;
    } else if (arg === "--fixture") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --fixture: expected one argument" };
      }
      parsed.fixture = value;
      i += 1;
    } else {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    }
  }
  return parsed;
}

// Export stage constants for tests
export { SUMMARY_MAX_CHARS, WARN_GLYPH };
