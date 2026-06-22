import { execFileSync } from "node:child_process";
import { resolveBinary } from "../scm/binary.js";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";
import { GH_TIMEOUT_S } from "./constants.js";
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
      maxBuffer: SUBPROCESS_MAX_BUFFER,
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
