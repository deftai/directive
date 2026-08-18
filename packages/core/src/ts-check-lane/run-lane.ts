/**
 * ts-check-lane/run-lane.ts -- Node-toolchain-aware TypeScript lane for
 * `task check` (#1530, #1790).
 *
 * TypeScript port of scripts/ts_check_lane.py (#1731 Wave 9 Python-delete).
 *
 * `task check` -> `check:framework-source` historically ran only the Python
 * suite + gates; the TypeScript engine (biome lint, tsc build, vitest) ran only
 * in the dedicated CI job. That split let a TS lint/format/test failure pass a
 * contributor's local `task check` and redden CI after push.
 *
 * This helper closes the gap WITHOUT regressing the documented invariant that
 * `check:framework-source` must not hard-require a Node toolchain in Node-less
 * environments (the vendored-consumer guard pattern). When `pnpm` is on PATH it
 * runs `pnpm run lint`, `pnpm run build`, and `pnpm run test` in order, failing
 * fast on the first non-zero exit. When `pnpm` is absent it prints a clear
 * notice and exits 0 -- the TS lane stays validated by the CI job in that case.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { BRANCH_GATE_BYPASS_ENV, RELEASE_PREFLIGHT_ENV } from "../release/constants.js";
import { resolveCoverageDebtIssue } from "../vitest-runner/coverage-debt.js";
import { buildTestLaneCommand } from "./progress.js";

/** Release Step-5 vars that must not leak into vitest via inherited pnpm env (#2434). */
const TS_LANE_POISON_ENV_KEYS = [BRANCH_GATE_BYPASS_ENV, RELEASE_PREFLIGHT_ENV] as const;

/**
 * Run order is deliberate: lint (cheapest, catches the biome class first),
 * then build, then the test suite.
 */
export const LANE_COMMANDS: ReadonlyArray<readonly string[]> = [
  ["run", "lint"],
  ["run", "build"],
  buildTestLaneCommand(),
];

export const SKIP_NOTICE =
  "[ts:check-lane] pnpm not found on PATH -- skipping the TypeScript lane " +
  "(build/lint/test). The TS engine stays validated by the dedicated CI job. " +
  "Install the Node toolchain (pnpm) to run the TS lane locally.";

/** Result of a single lane command invocation. Mirrors a subset of SpawnSyncReturns. */
export interface RunnerResult {
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: Error;
}

export type LaneRunner = (argv: readonly string[], cwd: string) => RunnerResult;

/**
 * Strip release preflight bypass vars before spawning pnpm/vitest so nested unit
 * tests observe fail-closed branch and cache gates (#2434 / #1553 recurrence).
 */
export function sanitizeTsLaneEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of TS_LANE_POISON_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export interface RunTsLaneOptions {
  /** Resolved pnpm executable path, or null when not installed. */
  readonly pnpm: string | null;
  /** Injected command runner (defaults to a real spawnSync). */
  readonly runner?: LaneRunner;
  /** Injected sink for human-facing notices (defaults to stdout). */
  readonly out?: (message: string) => void;
  /**
   * Env used to resolve release coverage-debt before sanitizeTsLaneEnv strips
   * DEFT_RELEASE_PREFLIGHT (#2618). Defaults to process.env.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** Windows command shims (.cmd/.bat) need a shell; native executables do not. */
export function shouldUseShellForCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

/** Default runner: an inherited-stdio pnpm invocation. */
function defaultRunner(
  argv: readonly string[],
  cwd: string,
  envOverride?: NodeJS.ProcessEnv,
): RunnerResult {
  const [command, ...rest] = argv;
  const commandPath = command ?? "";
  const result = spawnSync(commandPath, rest, {
    cwd,
    env: envOverride ?? sanitizeTsLaneEnv(process.env),
    stdio: "inherit",
    shell: shouldUseShellForCommand(commandPath),
  });
  return { error: result.error, signal: result.signal, status: result.status };
}

export interface ResolvePnpmOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Injected existence probe (defaults to node:fs existsSync). */
  readonly exists?: (path: string) => boolean;
}

/** Resolve the pnpm executable path, or null when it is not installed. */
export function resolvePnpm(options: ResolvePnpmOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;

  const pathValue = env.PATH ?? env.Path ?? "";
  if (pathValue === "") {
    return null;
  }
  const isWindows = platform === "win32";
  const exts = isWindows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const sep = isWindows ? ";" : ":";
  const joinPath = isWindows ? win32.join : posix.join;
  for (const dir of pathValue.split(sep)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = joinPath(dir, `pnpm${ext}`);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Run the TS lane when pnpm is available; skip (exit 0) when it is not.
 *
 * `runner` and `out` are injected so the guard logic is unit-testable without a
 * real Node toolchain or real subprocess execution.
 */
export function runTsLane(projectRoot: string, options: RunTsLaneOptions): number {
  const { pnpm } = options;
  const runner = options.runner ?? defaultRunner;
  const out = options.out ?? ((message: string) => process.stdout.write(`${message}\n`));
  // Resolve debt from the pre-sanitize env: sanitizeTsLaneEnv strips
  // DEFT_RELEASE_PREFLIGHT (required for the env-based debt path), so forward
  // --allow-coverage-debt=#N on the vitest argv instead (#2618 / #2573).
  const debt = resolveCoverageDebtIssue([], options.env ?? process.env);
  const debtIssue = debt.kind === "valid" ? debt.issue : null;

  if (!pnpm) {
    out(SKIP_NOTICE);
    return 0;
  }

  for (const command of LANE_COMMANDS) {
    const argv = [pnpm, ...command];
    // Soft-pass via lane-private env (vitest 3 CAC rejects unknown CLI debt tokens).
    // vitest.config reads DEFT_TS_LANE_COVERAGE_DEBT without DEFT_RELEASE_PREFLIGHT
    // (sanitizeTsLaneEnv strips preflight). Refs #2573 / #2618.
    const prevDebt = process.env.DEFT_TS_LANE_COVERAGE_DEBT;
    if (debtIssue !== null && command[1] === "test") {
      process.env.DEFT_TS_LANE_COVERAGE_DEBT = String(debtIssue);
    }
    let result: RunnerResult;
    try {
      result = runner(argv, projectRoot);
    } finally {
      if (debtIssue !== null && command[1] === "test") {
        if (prevDebt === undefined) {
          delete process.env.DEFT_TS_LANE_COVERAGE_DEBT;
        } else {
          process.env.DEFT_TS_LANE_COVERAGE_DEBT = prevDebt;
        }
      }
    }
    const code = result.status;
    // A null status means the child was terminated by a signal (SIGKILL / OOM /
    // SIGTERM) before it could exit. Mapping that to 0 would silently pass a
    // half-run lint/test on a memory-constrained machine, so treat it as a hard
    // failure -- this mirrors the Python oracle, whose returncode is negative
    // (non-zero) for a signal-killed process.
    if (code === null) {
      if (result.error) {
        out(
          `[ts:check-lane] \`pnpm ${command.join(" ")}\` failed to start: ${result.error.message}`,
        );
        return 1;
      }
      out(
        `[ts:check-lane] \`pnpm ${command.join(" ")}\` was killed by ${result.signal ?? "a signal"} before exit -- treating as failure.`,
      );
      return 1;
    }
    if (code !== 0) {
      out(`[ts:check-lane] \`pnpm ${command.join(" ")}\` failed (exit ${code}).`);
      return code;
    }
  }
  return 0;
}
