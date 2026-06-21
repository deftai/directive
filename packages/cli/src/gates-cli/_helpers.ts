import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Built `deft-ts` dispatcher binary. */
export function binPath(): string {
  return join(repoRoot(), "packages/cli/dist/bin.js");
}

/** Invoke `node packages/cli/dist/bin.js <verb> [...args]`. Pass an empty verb for `--help`. */
export function runDeftTs(
  verb: string,
  args: readonly string[] = [],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): DeftTsResult {
  const root = repoRoot();
  const argv = verb.length > 0 ? [binPath(), verb, ...args] : [binPath(), ...args];
  const res = spawnSync(process.execPath, argv, {
    cwd: opts.cwd ?? root,
    env: {
      ...process.env,
      DEFT_ROOT: root,
      DEFT_CACHE_DISABLE: "1",
      PYTHONUTF8: "1",
      ...opts.env,
    },
    encoding: "utf8",
  });
  return {
    exitCode: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
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
  mkdirSync(join(root, "vbrief"), { recursive: true });
  writeFileSync(
    join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
    JSON.stringify({
      vBRIEFInfo: { version: "0.6" },
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
