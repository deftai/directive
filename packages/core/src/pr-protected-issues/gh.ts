import { execFileSync } from "node:child_process";
import { resolveBinary } from "../scm/binary.js";
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
      return { returncode: -2, stdout: "", stderr: "" };
    }
    return {
      returncode: typeof e.status === "number" ? e.status : -1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}

/**
 * Run ``gh pr view <N> --json closingIssuesReferences`` and return linked issue
 * numbers. Returns ``null`` on external error (caller maps to EXIT_EXTERNAL_ERROR).
 */
export function fetchClosingIssuesReferences(
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
): number[] | null {
  const cmd = ["gh", "pr", "view", String(prNumber), "--json", "closingIssuesReferences"];
  if (repo) {
    cmd.push("--repo", repo);
  }

  let result: RunGhResult;
  try {
    result = runGh(cmd);
  } catch {
    process.stderr.write("Error: gh CLI not found. Install GitHub CLI.\n");
    return null;
  }

  if (result.returncode === -1 && result.stderr.includes("gh CLI not found")) {
    process.stderr.write("Error: gh CLI not found. Install GitHub CLI.\n");
    return null;
  }

  if (result.returncode === -2) {
    process.stderr.write(`Error: gh CLI timed out fetching PR #${prNumber}.\n`);
    return null;
  }

  if (result.returncode !== 0) {
    process.stderr.write(
      `Error: gh CLI failed fetching PR #${prNumber}: ${result.stderr.trim()}\n`,
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`Error: failed to parse gh CLI output for PR #${prNumber}: ${message}\n`);
    return null;
  }

  const refs = (payload as Record<string, unknown>).closingIssuesReferences;
  if (!Array.isArray(refs)) {
    const typeName = refs === null ? "null" : typeof refs;
    process.stderr.write(
      `Error: unexpected closingIssuesReferences shape for PR #${prNumber} ` +
        `(expected list, got ${typeName})\n`,
    );
    return null;
  }

  const linked: number[] = [];
  for (const entry of refs) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const number = (entry as Record<string, unknown>).number;
    if (typeof number === "number" && Number.isInteger(number)) {
      linked.push(number);
    } else if (typeof number === "string" && /^[0-9]+$/.test(number)) {
      linked.push(Number(number));
    }
  }
  return linked;
}
