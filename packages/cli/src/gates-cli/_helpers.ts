import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HandlerProcessExit } from "../cli-router/handler-process-exit.js";
import { routeAndDispatch } from "../cli-router/index.js";
import { resetHandlerCacheForTests } from "../dispatch.js";

export interface DeftTsResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const gatesDir = dirname(fileURLToPath(import.meta.url));

/** Repo root (deft framework checkout). */
export function repoRoot(): string {
  return resolve(gatesDir, "..", "..", "..", "..");
}

/** Built deft-ts dispatcher binary. Spawn leftovers use this path. */
export function binPath(): string {
  return join(repoRoot(), "packages/cli/dist/bin.js");
}

export interface RunDeftTsOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Invoke the CLI router in-process (#4591). Coverage excludes packages/cli/src/bin.ts,
 * so a node+bin.js spawn does not credit the child and is the Windows execute-scan
 * chokepoint documented in vitest.config.ts.
 */
export async function runDeftTs(
  verb: string,
  args: readonly string[] = [],
  opts: RunDeftTsOptions = {},
): Promise<DeftTsResult> {
  const argv = verb.length > 0 ? [verb, ...args] : [...args];
  return runDeftTsArgv(argv, opts);
}

export async function runDeftTsArgv(
  argv: readonly string[],
  opts: RunDeftTsOptions = {},
): Promise<DeftTsResult> {
  const out: string[] = [];
  const err: string[] = [];
  const prevOut = process.stdout.write.bind(process.stdout);
  const prevErr = process.stderr.write.bind(process.stderr);
  const prevCwd = process.cwd();
  const prevExit = process.exit;
  resetHandlerCacheForTests();
  const envSnapshot = { ...process.env };
  process.exit = ((code?: number): never => {
    throw new HandlerProcessExit(code ?? 0);
  }) as typeof process.exit;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    Object.assign(process.env, {
      DEFT_ROOT: repoRoot(),
      DEFT_CACHE_DISABLE: "1",
      PYTHONUTF8: "1",
      ...opts.env,
    });
    if (opts.cwd !== undefined) {
      process.chdir(opts.cwd);
    }
    const exitCode = await routeAndDispatch(argv, {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: (text) => {
        err.push(text);
      },
    });
    return {
      exitCode,
      stdout: out.join(""),
      stderr: err.join(""),
    };
  } catch (errCaught: unknown) {
    if (errCaught instanceof HandlerProcessExit) {
      return {
        exitCode: errCaught.code,
        stdout: out.join(""),
        stderr: err.join(""),
      };
    }
    throw errCaught;
  } finally {
    process.exit = prevExit;
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
    if (opts.cwd !== undefined) {
      process.chdir(prevCwd);
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, envSnapshot);
  }
}

export function initGitRepo(root: string): string {
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "gates-cli@test.local"], {
    cwd: root,
    encoding: "utf8",
  });
  execFileSync("git", ["config", "user.name", "gates-cli"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gates-cli",
      GIT_AUTHOR_EMAIL: "gates-cli@test.local",
      GIT_COMMITTER_NAME: "gates-cli",
      GIT_COMMITTER_EMAIL: "gates-cli@test.local",
    },
  });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

export function writeProjectDef(root: string, policy: Record<string, unknown> = {}): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "T", status: "running", items: [], policy },
    }),
    "utf8",
  );
}

export function seedProject(policy: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-gates-cli-"));
  writeProjectDef(root, policy);
  initGitRepo(root);
  return root;
}
