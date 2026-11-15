import { execFileSync } from "node:child_process";
import { defaultWhich } from "../scm/binary.js";
import { classifyScmArgv, resolveBinaryForArgv } from "../scm/call-shape.js";
import { ghxSpawnFallbackBinary } from "../scm/spawn-status.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { plainGhEnv } from "../subprocess/plain-gh-env.js";
import { GH_TIMEOUT_S } from "./constants.js";
import type { RefFileRead, RunGhFn, RunGhResult } from "./types.js";

/** UTF-8-safe gh capture via execFile (no shell) — mirrors _safe_subprocess.run_text (#1366). */
export function defaultRunGh(cmd: readonly string[]): RunGhResult {
  if (cmd.length === 0 || cmd[0] !== "gh") {
    return { returncode: -1, stdout: "", stderr: "expected gh as first argv element" };
  }
  const args = cmd.slice(1);
  const binary = resolveBinaryForArgv(args[0] ?? "", args.slice(1));
  const execOpts = {
    encoding: "utf8" as const,
    timeout: GH_TIMEOUT_S * 1000,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    maxBuffer: SUBPROCESS_MAX_BUFFER,
    // Plain output for JSON.parse on first run and ghx fallback retry (#6023).
    env: plainGhEnv(),
  };
  const runOnce = (bin: string) => execFileSync(bin, args, execOpts);
  try {
    const stdout = runOnce(binary);
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (caught: unknown) {
    let err: unknown = caught;
    const first = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      code?: string;
      message?: string;
    };
    const retry = ghxSpawnFallbackBinary(
      classifyScmArgv(args[0] ?? "", args.slice(1)),
      binary,
      defaultWhich,
      {
        status: typeof first.status === "number" ? first.status : null,
        error:
          first.code === "ENOENT" || first.code === "ETIMEDOUT" || typeof first.status !== "number"
            ? { code: first.code, message: first.message }
            : undefined,
        stdout: typeof first.stdout === "string" ? first.stdout : "",
        stderr: typeof first.stderr === "string" ? first.stderr : "",
      },
    );
    if (retry !== null) {
      try {
        const stdout = runOnce(retry);
        return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
      } catch (retryErr: unknown) {
        err = retryErr;
      }
    }
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
      return {
        returncode: -1,
        stdout: "",
        stderr: `gh CLI timed out fetching PR #${args.includes("view") ? (args[2] ?? "?") : "?"}.`,
      };
    }
    return {
      returncode: typeof e.status === "number" ? e.status : -1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}

export function fetchPrBody(prNumber: number, repo: string | null, runGh: RunGhFn): string | null {
  const cmd = ["gh", "pr", "view", String(prNumber), "--json", "body"];
  if (repo) {
    cmd.push("--repo", repo);
  }
  const { returncode, stdout, stderr } = runGh(cmd);
  if (returncode === -1 && stderr.includes("not found")) {
    process.stderr.write("Error: gh CLI not found. Install GitHub CLI.\n");
    return null;
  }
  if (returncode === -1 && stderr.includes("timed out")) {
    process.stderr.write(`Error: gh CLI timed out fetching PR #${prNumber}.\n`);
    return null;
  }
  if (returncode !== 0) {
    process.stderr.write(`Error: gh CLI failed fetching PR #${prNumber}: ${stderr.trim()}\n`);
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`Error: failed to parse gh CLI output: ${message}\n`);
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    process.stderr.write("Error: failed to parse gh CLI output: unexpected shape\n");
    return null;
  }
  const body = (payload as Record<string, unknown>).body ?? "";
  if (typeof body !== "string") {
    process.stderr.write(`Error: unexpected body shape: ${typeof body}\n`);
    return null;
  }
  return body;
}

export function fetchPrCommitMessages(
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
): string[] | null {
  const cmd = ["gh", "pr", "view", String(prNumber), "--json", "commits"];
  if (repo) {
    cmd.push("--repo", repo);
  }
  const { returncode, stdout, stderr } = runGh(cmd);
  if (returncode === -1 && stderr.includes("not found")) {
    process.stderr.write("Error: gh CLI not found. Install GitHub CLI.\n");
    return null;
  }
  if (returncode === -1 && stderr.includes("timed out")) {
    process.stderr.write(`Error: gh CLI timed out fetching commits for PR #${prNumber}.\n`);
    return null;
  }
  if (returncode !== 0) {
    process.stderr.write(`Error: gh CLI failed fetching commits: ${stderr.trim()}\n`);
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`Error: failed to parse gh CLI output: ${message}\n`);
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    process.stderr.write("Error: failed to parse gh CLI output: unexpected shape\n");
    return null;
  }
  const commits = (payload as Record<string, unknown>).commits;
  if (!Array.isArray(commits)) {
    process.stderr.write(`Error: unexpected commits shape: ${typeof commits}\n`);
    return null;
  }
  const messages: string[] = [];
  for (const entry of commits) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const headline = typeof e.messageHeadline === "string" ? e.messageHeadline : "";
    const body = typeof e.messageBody === "string" ? e.messageBody : "";
    const combined = `${headline}\n${body}`.trim();
    if (combined.length > 0) {
      messages.push(combined);
    }
  }
  return messages;
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  try {
    const payload: unknown = JSON.parse(stdout);
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function shaAt(payload: Record<string, unknown>, key: string): string | null {
  const side = payload[key];
  if (side === null || typeof side !== "object" || Array.isArray(side)) {
    return null;
  }
  const sha = (side as Record<string, unknown>).sha;
  return typeof sha === "string" && /^[0-9a-f]{7,64}$/i.test(sha.trim()) ? sha.trim() : null;
}

/**
 * PR merge-base commit via REST (#6316): `pulls/<N>` for base/head SHAs, then
 * `compare/<base>...<head>` for `merge_base_commit.sha`. `null` on any failure.
 */
export function fetchPrMergeBaseSha(prNumber: number, repo: string, runGh: RunGhFn): string | null {
  const pull = runGh(["gh", "api", `repos/${repo}/pulls/${String(prNumber)}`]);
  if (pull.returncode !== 0) {
    return null;
  }
  const pullPayload = parseJsonObject(pull.stdout);
  if (pullPayload === null) {
    return null;
  }
  const base = shaAt(pullPayload, "base");
  const head = shaAt(pullPayload, "head");
  if (base === null || head === null) {
    return null;
  }
  const compare = runGh(["gh", "api", `repos/${repo}/compare/${base}...${head}`]);
  if (compare.returncode !== 0) {
    return null;
  }
  const comparePayload = parseJsonObject(compare.stdout);
  if (comparePayload === null) {
    return null;
  }
  return shaAt(comparePayload, "merge_base_commit");
}

/**
 * Read one repo file at a fixed ref via the REST contents API (#6316).
 * HTTP 404 is `absent` (the path did not exist at that ref); anything else unreadable
 * is `error`, so callers fail closed.
 */
export function fetchRepoFileAtRef(
  repo: string,
  path: string,
  ref: string,
  runGh: RunGhFn,
): RefFileRead {
  const encoded = path
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const result = runGh([
    "gh",
    "api",
    `repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
  ]);
  if (result.returncode !== 0) {
    if (/HTTP 404|Not Found/i.test(result.stderr)) {
      return { kind: "absent" };
    }
    return {
      kind: "error",
      detail: `gh REST failed reading ${path}@${ref}: ${result.stderr.trim() || "no output"}`,
    };
  }
  const payload = parseJsonObject(result.stdout);
  if (payload === null) {
    return { kind: "error", detail: `${path}@${ref}: contents payload is not a JSON object` };
  }
  if (
    payload.type !== "file" ||
    payload.encoding !== "base64" ||
    typeof payload.content !== "string"
  ) {
    return { kind: "error", detail: `${path}@${ref}: contents payload is not a base64 file` };
  }
  return { kind: "ok", text: Buffer.from(payload.content, "base64").toString("utf8") };
}
