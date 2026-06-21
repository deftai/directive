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
import { join } from "node:path";

/**
 * Run order is deliberate: lint (cheapest, catches the biome class first),
 * then build, then the test suite.
 */
export const LANE_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["run", "lint"],
  ["run", "build"],
  ["run", "test"],
];

export const SKIP_NOTICE =
  "[ts:check-lane] pnpm not found on PATH -- skipping the TypeScript lane " +
  "(build/lint/test). The TS engine stays validated by the dedicated CI job. " +
  "Install the Node toolchain (pnpm) to run the TS lane locally.";

/** Result of a single lane command invocation. Mirrors a subset of SpawnSyncReturns. */
export interface RunnerResult {
  readonly status: number | null;
}

export type LaneRunner = (argv: readonly string[], cwd: string) => RunnerResult;

export interface RunTsLaneOptions {
  /** Resolved pnpm executable path, or null when not installed. */
  readonly pnpm: string | null;
  /** Injected command runner (defaults to a real spawnSync). */
  readonly runner?: LaneRunner;
  /** Injected sink for human-facing notices (defaults to stdout). */
  readonly out?: (message: string) => void;
}

/** Default runner: a non-shell, inherited-stdio pnpm invocation. */
function defaultRunner(argv: readonly string[], cwd: string): RunnerResult {
  const [command, ...rest] = argv;
  const result = spawnSync(command ?? "", rest, { cwd, stdio: "inherit" });
  return { status: result.status };
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
  for (const dir of pathValue.split(sep)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, `pnpm${ext}`);
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

  if (!pnpm) {
    out(SKIP_NOTICE);
    return 0;
  }

  for (const command of LANE_COMMANDS) {
    const argv = [pnpm, ...command];
    const result = runner(argv, projectRoot);
    const code = result.status;
    // A null status means the child was terminated by a signal (SIGKILL / OOM /
    // SIGTERM) before it could exit. Mapping that to 0 would silently pass a
    // half-run lint/test on a memory-constrained machine, so treat it as a hard
    // failure -- this mirrors the Python oracle, whose returncode is negative
    // (non-zero) for a signal-killed process.
    if (code === null) {
      out(
        `[ts:check-lane] \`pnpm ${command.join(" ")}\` was killed by a signal before exit -- treating as failure.`,
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
