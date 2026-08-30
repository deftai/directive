#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cmdPrCheckClosingKeywords } from "@deftai/directive-core/dist/pr-closing-keywords/main.js";

const BASE_CANDIDATES = ["origin/master", "origin/main"] as const;

export type RunGitFn = (args: readonly string[]) => {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type RangeResolution =
  | { readonly kind: "pr"; readonly pr: string }
  | { readonly kind: "range"; readonly range: string }
  | { readonly kind: "missing-base"; readonly reason: string };

export function defaultRunGit(args: readonly string[]): {
  returncode: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync("git", [...args], {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      returncode: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

/**
 * Resolve the candidate commit range against a merge-base, not a hardcoded
 * origin/master two-dot range (#3969 Greptile leftover).
 */
export function resolveClosingKeywordsSource(
  env: NodeJS.ProcessEnv,
  runGit: RunGitFn = defaultRunGit,
): RangeResolution {
  const raw = env.GITHUB_PR_NUMBER ?? env.PR_NUMBER;
  const pr = raw?.trim() ?? "";
  if (/^\d+$/.test(pr)) {
    return { kind: "pr", pr };
  }
  const bases = [
    env.GITHUB_BASE_REF?.trim() ? `origin/${env.GITHUB_BASE_REF.trim()}` : null,
    ...BASE_CANDIDATES,
  ].filter((base): base is string => base !== null && base.length > 0);
  const seen = new Set<string>();
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    const merged = runGit(["merge-base", base, "HEAD"]);
    const sha = firstLine(merged.stdout);
    if (merged.returncode === 0 && /^[0-9a-f]{7,40}$/i.test(sha)) {
      return { kind: "range", range: `${sha}..HEAD` };
    }
  }
  return {
    kind: "missing-base",
    reason:
      "no merge-base against origin/master or origin/main. Recovery: git fetch origin master.",
  };
}

export function buildClosingKeywordsCheckArgv(
  env: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
  runGit: RunGitFn = defaultRunGit,
): { argv: string[]; error?: string } {
  const source = resolveClosingKeywordsSource(env, runGit);
  if (source.kind === "pr") {
    return { argv: ["--mode", "fp", "--pr", source.pr, ...extra] };
  }
  if (source.kind === "missing-base") {
    return { argv: [], error: source.reason };
  }
  return { argv: ["--mode", "fp", "--from-git-range", source.range, ...extra] };
}

export function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  invoke: (args: readonly string[]) => number = cmdPrCheckClosingKeywords,
  runGit: RunGitFn = defaultRunGit,
): number {
  const built = buildClosingKeywordsCheckArgv(env, argv, runGit);
  if (built.error !== undefined) {
    process.stderr.write("verify:closing-keywords: fail -- " + built.error + "\n");
    return 2;
  }
  return invoke(built.argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
