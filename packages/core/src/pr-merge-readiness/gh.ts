import { execFileSync } from "node:child_process";
import { resolveBinary } from "../scm/binary.js";
import { GH_TIMEOUT_S, GREPTILE_LOGIN } from "./constants.js";
import type { RunGhFn, RunGhResult } from "./types.js";

/** UTF-8-safe gh capture via execFile (no shell) — mirrors _safe_subprocess.run_text (#1366). */
export function defaultRunGh(cmd: readonly string[]): RunGhResult {
  if (cmd.length === 0 || cmd[0] !== "gh") {
    return { returncode: -1, stdout: "", stderr: "expected gh as first argv element" };
  }
  const binary = resolveBinary();
  const args = cmd.slice(1);
  try {
    const stdout = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: GH_TIMEOUT_S * 1000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err: unknown) {
    const e = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      code?: string;
      message?: string;
    };
    if (e.code === "ENOENT") {
      return { returncode: -1, stdout: "", stderr: "gh CLI not found. Install GitHub CLI." };
    }
    if (e.code === "ETIMEDOUT") {
      return { returncode: -1, stdout: "", stderr: `gh CLI timed out: ${cmd.join(" ")}` };
    }
    return {
      returncode: typeof e.status === "number" ? e.status : -1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}

export function fetchPrHeadSha(
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
): string | null {
  const cmd = ["gh", "pr", "view", String(prNumber), "--json", "headRefOid", "--jq", ".headRefOid"];
  if (repo) {
    cmd.push("--repo", repo);
  }
  const { returncode, stdout, stderr } = runGh(cmd);
  if (returncode !== 0) {
    process.stderr.write(
      `Error: gh failed fetching PR #${prNumber} headRefOid: ${stderr.trim()}\n`,
    );
    return null;
  }
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
}

export function fetchGreptileCommentBody(
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
): string | null {
  let resolvedRepo = repo;
  if (!resolvedRepo) {
    const rc = runGh(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    if (rc.returncode !== 0) {
      process.stderr.write(`Error: could not resolve --repo from cwd: ${rc.stderr.trim()}\n`);
      return null;
    }
    resolvedRepo = rc.stdout.trim();
    if (!resolvedRepo) {
      process.stderr.write("Error: empty repo from gh repo view (specify --repo OWNER/REPO).\n");
      return null;
    }
  }

  const cmd = [
    "gh",
    "api",
    `repos/${resolvedRepo}/issues/${prNumber}/comments`,
    "--paginate",
    "--jq",
    `[.[] | select(.user.login == "${GREPTILE_LOGIN}")] | last | .body // ""`,
  ];
  const { returncode, stdout, stderr } = runGh(cmd);
  if (returncode !== 0) {
    process.stderr.write(
      `Error: gh failed fetching comments for PR #${prNumber}: ${stderr.trim()}\n`,
    );
    return null;
  }
  return stdout;
}

export function resolveRepo(
  repo: string | null,
  runGh: RunGhFn,
): { repo: string | null; error: string } {
  if (repo) {
    return { repo, error: "" };
  }
  const rc = runGh(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (rc.returncode !== 0) {
    return { repo: null, error: `could not resolve --repo from cwd: ${rc.stderr.trim()}` };
  }
  const resolved = rc.stdout.trim();
  if (!resolved) {
    return { repo: null, error: "empty repo from gh repo view (specify --repo OWNER/REPO)" };
  }
  return { repo: resolved, error: "" };
}

export function fetchGreptileBodyRest(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): { body: string | null; error: string } {
  const rc = runGh(["gh", "api", `repos/${repo}/issues/${prNumber}/comments`, "--paginate"]);
  if (rc.returncode !== 0) {
    return {
      body: null,
      error: `gh api /issues/${prNumber}/comments failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return { body: "", error: "" };
  }

  return parsePaginatedComments(rc.stdout.trim());
}

function parsePaginatedComments(text: string): { body: string | null; error: string } {
  const comments: unknown[] = [];
  const decoder = new PaginatedJsonDecoder();
  let idx = 0;
  while (idx < text.length) {
    const result = decoder.rawDecode(text, idx);
    if (result === null) {
      if (idx < text.length) {
        return { body: null, error: "could not parse REST comments JSON: invalid JSON at offset" };
      }
      break;
    }
    const [obj, end] = result;
    if (Array.isArray(obj)) {
      comments.push(...obj);
    } else if (obj !== null && typeof obj === "object") {
      comments.push(obj);
    }
    idx = end;
  }

  const greptileBodies: string[] = [];
  for (const c of comments) {
    if (
      c !== null &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      "user" in c &&
      c.user !== null &&
      typeof c.user === "object" &&
      !Array.isArray(c.user) &&
      "login" in c.user &&
      c.user.login === GREPTILE_LOGIN &&
      "body" in c &&
      typeof c.body === "string"
    ) {
      greptileBodies.push(c.body);
    }
  }
  if (greptileBodies.length === 0) {
    return { body: "", error: "" };
  }
  return { body: greptileBodies[greptileBodies.length - 1] ?? "", error: "" };
}

/** Mirrors Python json.JSONDecoder.raw_decode for concatenated paginate arrays. */
class PaginatedJsonDecoder {
  rawDecode(text: string, idx: number): [unknown, number] | null {
    let pos = idx;
    while (pos < text.length && /\s/.test(text.charAt(pos))) {
      pos += 1;
    }
    if (pos >= text.length) {
      return null;
    }
    try {
      let end = pos;
      let depth = 0;
      let inString = false;
      let isEscaped = false;
      const startChar = text.charAt(pos);
      if (startChar !== "[" && startChar !== "{") {
        return null;
      }
      for (; end < text.length; end += 1) {
        const ch = text.charAt(end);
        if (inString) {
          if (isEscaped) {
            isEscaped = false;
          } else if (ch === "\\") {
            isEscaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "[" || ch === "{") {
          depth += 1;
        } else if (ch === "]" || ch === "}") {
          depth -= 1;
          if (depth === 0) {
            end += 1;
            break;
          }
        }
      }
      const slice = text.slice(pos, end);
      const obj = JSON.parse(slice) as unknown;
      return [obj, end];
    } catch {
      return null;
    }
  }
}

export function fetchPrHeadShaRest(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): { sha: string | null; error: string } {
  const rc = runGh(["gh", "api", `repos/${repo}/pulls/${prNumber}`]);
  if (rc.returncode !== 0) {
    return { sha: null, error: `gh api /pulls/${prNumber} failed: ${rc.stderr.trim()}` };
  }
  if (!rc.stdout.trim()) {
    return { sha: null, error: "empty body from gh api /pulls/<N>" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { sha: null, error: `could not parse PR JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { sha: null, error: "unexpected PR JSON shape (not a dict)" };
  }
  const head = (payload as Record<string, unknown>).head;
  if (head !== null && typeof head === "object" && !Array.isArray(head)) {
    const sha = (head as Record<string, unknown>).sha;
    if (typeof sha === "string" && sha.length > 0) {
      return { sha, error: "" };
    }
  }
  return { sha: null, error: "PR JSON missing head.sha" };
}

export function fetchCheckRunsRest(
  sha: string,
  repo: string,
  runGh: RunGhFn,
): { summary: Record<string, unknown> | null; error: string } {
  const rc = runGh(["gh", "api", `repos/${repo}/commits/${sha}/check-runs`]);
  if (rc.returncode !== 0) {
    return {
      summary: null,
      error: `gh api /commits/${"<"}sha>/check-runs failed: ${rc.stderr.trim()}`,
    };
  }
  if (!rc.stdout.trim()) {
    return { summary: null, error: "empty body from gh api /commits/<sha>/check-runs" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rc.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return { summary: null, error: `could not parse check-runs JSON: ${message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { summary: null, error: "unexpected check-runs JSON shape (not a dict)" };
  }
  const runs = (payload as Record<string, unknown>).check_runs;
  if (!Array.isArray(runs)) {
    return { summary: null, error: "check-runs JSON missing check_runs list" };
  }
  const summary: Record<string, unknown> = {
    total: runs.length,
    by_status: {} as Record<string, number>,
    by_conclusion: {} as Record<string, number>,
    greptile_review: null,
  };
  const byStatus = summary.by_status as Record<string, number>;
  const byConclusion = summary.by_conclusion as Record<string, number>;
  for (const run of runs) {
    if (run === null || typeof run !== "object" || Array.isArray(run)) {
      continue;
    }
    const r = run as Record<string, unknown>;
    const status = typeof r.status === "string" ? r.status : "unknown";
    const conclusion = typeof r.conclusion === "string" ? r.conclusion : "none";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byConclusion[conclusion] = (byConclusion[conclusion] ?? 0) + 1;
    if (r.name === "Greptile Review") {
      summary.greptile_review = { status, conclusion };
    }
  }
  return { summary, error: "" };
}
