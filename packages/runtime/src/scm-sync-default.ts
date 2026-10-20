/**
 * CLI for `scm:sync-default` (#3391).
 *
 * Opens dest-targeted default-branch sync PRs using the shared detector and
 * syncMaxFiles. Over-limit legs are new branches and new PRs.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySyncDefault,
  formatSyncDefaultHuman,
  parseGithubOwnerRepo,
  planSyncDefault,
  SYNC_DEFAULT_VERB,
  type SyncDefaultForge,
  type SyncDefaultOpenPull,
} from "@deftai/directive-core/policy";
import { runGhApi, splitRepo } from "@deftai/directive-core/scm";
import { defaultGitRunner } from "@deftai/directive-core/session";

export const USAGE =
  `usage: deft ${SYNC_DEFAULT_VERB} [--dry-run] [--json] [--max-files N] [--repo OWNER/REPO]\n` +
  "  Open dest-targeted sync PRs under syncMaxFiles. Under the limit: one new PR\n" +
  "  from source tip to dest. Over: merge-commit cuts; each dest-based leg is a\n" +
  "  new branch and a new PR. After a leg merges, run again. Never retarget or\n" +
  "  reuse an oversized PR. Each leg must be new when the reviewer first sees it.\n" +
  "  Required checks stay on except the Wave 1 core-guard sync exemption.\n";

export interface SyncDefaultCliArgs {
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly help?: boolean;
  readonly maxFiles?: number;
  readonly projectRoot?: string;
  readonly repo?: string;
}

export function parseSyncDefaultArgs(argv: readonly string[]): {
  args: SyncDefaultCliArgs;
  error: string | null;
} {
  const out: {
    dryRun?: boolean;
    json?: boolean;
    help?: boolean;
    maxFiles?: number;
    projectRoot?: string;
    repo?: string;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--max-files") {
      const raw = argv[++i];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { args: out, error: `--max-files expects a non-negative integer, got ${raw ?? ""}` };
      }
      out.maxFiles = parsed;
    } else if (arg === "--project-root") {
      const value = argv[++i];
      if (value === undefined) {
        return { args: out, error: "--project-root expects a path" };
      }
      out.projectRoot = value;
    } else if (arg === "--repo") {
      const value = argv[++i];
      if (value === undefined) {
        return { args: out, error: "--repo expects OWNER/REPO" };
      }
      out.repo = value;
    } else if (arg.startsWith("-")) {
      return { args: out, error: `unknown flag ${JSON.stringify(arg)}` };
    } else {
      return { args: out, error: `unexpected argument ${JSON.stringify(arg)}` };
    }
  }
  return { args: out, error: null };
}

export function pullsFromRestJson(payload: unknown): readonly SyncDefaultOpenPull[] {
  if (!Array.isArray(payload)) return [];
  const pulls: SyncDefaultOpenPull[] = [];
  for (const row of payload) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    const head = rec.head;
    const baseRec = rec.base;
    if (typeof head !== "object" || head === null) continue;
    if (typeof baseRec !== "object" || baseRec === null) continue;
    const headRec = head as Record<string, unknown>;
    const baseObj = baseRec as Record<string, unknown>;
    const number = rec.number;
    const htmlUrl = rec.html_url;
    const headRef = headRec.ref;
    const headSha = headRec.sha;
    const baseRef = baseObj.ref;
    if (
      typeof number !== "number" ||
      typeof htmlUrl !== "string" ||
      typeof headRef !== "string" ||
      typeof headSha !== "string" ||
      typeof baseRef !== "string"
    ) {
      continue;
    }
    pulls.push({ number, htmlUrl, headRef, headSha, baseRef });
  }
  return pulls;
}

export function createGhSyncDefaultForge(): SyncDefaultForge {
  return {
    listOpenPulls(repo, base) {
      const [owner, name] = splitRepo(repo);
      const endpoint = `repos/${owner}/${name}/pulls`;
      const result = runGhApi([
        endpoint,
        "--method",
        "GET",
        "--raw-field",
        `base=${base}`,
        "--raw-field",
        "state=open",
        "--raw-field",
        "per_page=100",
      ]);
      if (result.returncode !== 0) {
        throw new Error(result.stderr || `failed to list open pulls for ${repo}`);
      }
      return pullsFromRestJson(JSON.parse(result.stdout || "[]") as unknown);
    },
    createPull(repo, input) {
      const [owner, name] = splitRepo(repo);
      const endpoint = `repos/${owner}/${name}/pulls`;
      const bodyPath = join(tmpdir(), `deft-sync-default-${Date.now()}.json`);
      writeFileSync(
        bodyPath,
        JSON.stringify({
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
        }),
        { encoding: "utf8" },
      );
      const result = runGhApi(["-X", "POST", endpoint, "--input", bodyPath]);
      if (result.returncode !== 0) {
        throw new Error(result.stderr || `failed to create pull for ${repo}`);
      }
      const created = JSON.parse(result.stdout) as { number?: number; html_url?: string };
      if (typeof created.number !== "number" || typeof created.html_url !== "string") {
        throw new Error("create pull returned no number/html_url");
      }
      return { number: created.number, htmlUrl: created.html_url };
    },
  };
}

export function resolveRepoFromGit(projectRoot: string): string | null {
  const remote = defaultGitRunner(projectRoot, ["remote", "get-url", "origin"]);
  if (remote.code !== 0) return null;
  return parseGithubOwnerRepo(remote.stdout);
}

export function runSyncDefaultCli(
  args: SyncDefaultCliArgs,
  options: {
    writeOut?: (s: string) => void;
    writeErr?: (s: string) => void;
    forge?: SyncDefaultForge;
    cwd?: string;
    runGit?: Parameters<typeof planSyncDefault>[0]["runGit"];
    resolveRepo?: (projectRoot: string) => string | null;
  } = {},
): number {
  const writeOut = options.writeOut ?? ((s) => process.stdout.write(s));
  const writeErr = options.writeErr ?? ((s) => process.stderr.write(s));
  if (args.help === true) {
    writeOut(USAGE);
    return 0;
  }
  const projectRoot = args.projectRoot ?? options.cwd ?? process.cwd();
  const plan = planSyncDefault({
    projectRoot,
    maxFiles: args.maxFiles,
    runGit: options.runGit,
  });
  if (plan.action === "noop") {
    if (args.json === true) {
      writeOut(`${JSON.stringify({ ...plan, opened: [], retargeted: false }, null, 2)}\n`);
    } else {
      writeOut(`${plan.message}\n`);
    }
    return plan.noopReason === "fetch-failed" || plan.noopReason === "diff-failed" ? 2 : 0;
  }

  const resolveRepo = options.resolveRepo ?? resolveRepoFromGit;
  const repo = args.repo ?? resolveRepo(projectRoot);
  if (repo === null && args.dryRun !== true) {
    writeErr("scm:sync-default: could not resolve OWNER/REPO from origin; pass --repo\n");
    return 2;
  }

  try {
    const result = applySyncDefault({
      projectRoot,
      repo: repo ?? "owner/repo",
      plan,
      dryRun: args.dryRun === true,
      runGit: options.runGit,
      forge: args.dryRun === true ? undefined : (options.forge ?? createGhSyncDefaultForge()),
    });
    if (args.json === true) {
      writeOut(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      writeOut(formatSyncDefaultHuman(result));
    }
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`scm:sync-default: ${message}\n`);
    return 1;
  }
}

export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  const { args, error } = parseSyncDefaultArgs(argv);
  if (error !== null) {
    process.stderr.write(`error: ${error}\n${USAGE}`);
    return 2;
  }
  return runSyncDefaultCli(args);
}

export function main(argv: string[] = process.argv.slice(2)): number {
  return mainEntry(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(mainEntry());
}
