import { execFileSync } from "node:child_process";
import { SUBPROCESS_MAX_BUFFER } from "../subprocess/max-buffer.js";

export interface TextCaptureResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** UTF-8-safe subprocess capture — mirrors scripts/_safe_subprocess.run_text (#1366). */
export function runText(
  command: readonly string[],
  options: { cwd?: string } = {},
): TextCaptureResult {
  if (command.length === 0) {
    return { returncode: -1, stdout: "", stderr: "empty command" };
  }
  const [binary, ...args] = command;
  try {
    const stdout = execFileSync(binary ?? "", args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });
    return {
      returncode: 0,
      stdout: typeof stdout === "string" ? stdout : "",
      stderr: "",
    };
  } catch (err: unknown) {
    const e = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      code?: string;
      message?: string;
    };
    if (e.code === "ENOENT") {
      return { returncode: -1, stdout: "", stderr: String(e.message ?? "command not found") };
    }
    return {
      returncode: typeof e.status === "number" ? e.status : -1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.message ?? ""),
    };
  }
}
