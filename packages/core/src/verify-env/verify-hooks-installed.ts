import * as childProcess from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type OutputStream = "stdout" | "stderr" | "none";

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
}

export const REQUIRED_HOOKS = ["pre-commit", "pre-push"] as const;

/** Substrings each hook must contain when it dispatches through the deft CLI (#2049). */
export const PRE_COMMIT_DEFT_COMMANDS = ["verify:branch", "verify:encoding"] as const;
export const PRE_PUSH_DEFT_COMMANDS = ["preflight-gh"] as const;

/** Patterns that indicate legacy Python-dispatched hooks (pre-#2049). */
const LEGACY_HOOK_PATTERNS = [
  /\.py\b/i,
  /\bpython\b/i,
  /\bdeft_py\b/,
  /\bSCRIPTS_DIR\b/,
  /\bpreflight_branch\.py\b/,
] as const;

export type GitConfigReader = (projectRoot: string) => {
  hooksPath: string | null;
  error: string | null;
};

export interface EvaluateOptions {
  readonly gitConfigReader?: GitConfigReader;
  readonly platform?: NodeJS.Platform;
}

function defaultGitConfigReader(projectRoot: string): {
  hooksPath: string | null;
  error: string | null;
} {
  try {
    const stdout = childProcess.execFileSync(
      "git",
      ["-C", projectRoot, "config", "--get", "core.hooksPath"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const value = stdout.trim();
    return { hooksPath: value.length > 0 ? value : null, error: null };
  } catch (err: unknown) {
    const e = err as { code?: string; status?: number; stdout?: string };
    if (e.code === "ENOENT") {
      return { hooksPath: null, error: "git executable not found on PATH" };
    }
    if (typeof e.status === "number" && e.status !== 0) {
      return { hooksPath: null, error: null };
    }
    return { hooksPath: null, error: null };
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isPosix(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

function hookExecutable(hookPath: string): boolean {
  try {
    accessSync(hookPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readHookContent(hookPath: string): string | null {
  try {
    return readFileSync(hookPath, "utf8");
  } catch {
    return null;
  }
}

/** Drop shell ``#`` comment lines before pattern scans (#2049 shipped-hook false positives). */
export function stripShellCommentLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function executableHookBody(content: string): string {
  return stripShellCommentLines(content);
}

function usesLegacyPythonDispatch(content: string): boolean {
  const body = executableHookBody(content);
  return LEGACY_HOOK_PATTERNS.some((pattern) => pattern.test(body));
}

function hookInvokesDeftCli(content: string, requiredCommands: readonly string[]): boolean {
  const body = executableHookBody(content);
  if (!/\bdeft\b/.test(body)) return false;
  if (usesLegacyPythonDispatch(content)) return false;
  return requiredCommands.every((cmd) => body.includes(cmd));
}

function prePushInvokesVerifyBranch(content: string): boolean {
  const body = executableHookBody(content);
  return /\bdeft\s+verify:branch\b/.test(body);
}

function validateHookContent(
  hookName: string,
  content: string | null,
  requiredCommands: readonly string[],
): string | null {
  if (content === null) {
    return `${hookName}: unreadable hook file`;
  }
  if (usesLegacyPythonDispatch(content)) {
    return `${hookName}: still dispatches through Python scripts (expected deft CLI only, #2049)`;
  }
  if (!hookInvokesDeftCli(content, requiredCommands)) {
    return `${hookName}: missing required deft CLI gate(s): ${requiredCommands.join(", ")}`;
  }
  return null;
}

/** Pure evaluator mirroring scripts/verify_hooks_installed.py::evaluate. */
export function evaluate(projectRoot: string, options: EvaluateOptions = {}): EvaluateResult {
  const root = resolve(projectRoot);
  const gitReader = options.gitConfigReader ?? defaultGitConfigReader;
  const platform = options.platform ?? process.platform;

  if (!isDirectory(root)) {
    return {
      code: 2,
      message: `❌ deft hooks: project root ${root} does not exist (config error).`,
      stream: "stderr",
    };
  }

  const { hooksPath, error: gitErr } = gitReader(root);
  if (gitErr) {
    return {
      code: 2,
      message:
        `❌ deft hooks: cannot read core.hooksPath -- ${gitErr}.\n` +
        "  Recovery: install git (https://git-scm.com/) so the check can run.",
      stream: "stderr",
    };
  }
  if (!hooksPath) {
    return {
      code: 1,
      message:
        "❌ deft hooks not installed: core.hooksPath is unset.\n" +
        "  Recovery: run `task setup` (or re-run the deft installer).",
      stream: "stderr",
    };
  }

  let hooksDir = hooksPath;
  if (!hooksPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(hooksPath)) {
    hooksDir = join(root, hooksPath);
  }

  if (!isDirectory(hooksDir)) {
    return {
      code: 1,
      message:
        `❌ deft hooks wired but NON-FUNCTIONAL: core.hooksPath=${hooksPath} ` +
        `but the directory ${hooksDir} does not exist (#1463 false-green).\n` +
        "  Recovery: re-run the deft installer / `task setup` to deposit the hooks.",
      stream: "stderr",
    };
  }

  const missingHooks = REQUIRED_HOOKS.filter((h) => !isFile(join(hooksDir, h)));
  if (missingHooks.length > 0) {
    return {
      code: 1,
      message:
        `❌ deft hooks wired but NON-FUNCTIONAL: ${hooksDir} is missing ` +
        `${missingHooks.join(", ")} (#1463 false-green).\n` +
        "  Recovery: re-run the deft installer / `task setup`.",
      stream: "stderr",
    };
  }

  if (isPosix(platform)) {
    const nonExec = REQUIRED_HOOKS.filter((h) => !hookExecutable(join(hooksDir, h)));
    if (nonExec.length > 0) {
      return {
        code: 1,
        message:
          `❌ deft hooks wired but NON-FUNCTIONAL: ${hooksDir} hook(s) ` +
          `${nonExec.join(", ")} are not executable (git mode is not ` +
          "100755); git silently skips non-executable hooks on Unix (#1477).\n" +
          "  Recovery: re-run the deft installer / `task setup`, or " +
          "`chmod +x .githooks/pre-commit .githooks/pre-push`.",
        stream: "stderr",
      };
    }
  }

  const preCommitIssue = validateHookContent(
    "pre-commit",
    readHookContent(join(hooksDir, "pre-commit")),
    PRE_COMMIT_DEFT_COMMANDS,
  );
  if (preCommitIssue) {
    return {
      code: 1,
      message:
        `❌ deft hooks wired but NON-FUNCTIONAL: ${preCommitIssue} (#2049).\n` +
        "  Recovery: re-run the deft installer / `task setup` to refresh .githooks/.",
      stream: "stderr",
    };
  }

  const prePushContent = readHookContent(join(hooksDir, "pre-push"));
  const prePushIssue = validateHookContent("pre-push", prePushContent, PRE_PUSH_DEFT_COMMANDS);
  if (prePushIssue) {
    return {
      code: 1,
      message:
        `❌ deft hooks wired but NON-FUNCTIONAL: ${prePushIssue} (#2049).\n` +
        "  Recovery: re-run the deft installer / `task setup` to refresh .githooks/.",
      stream: "stderr",
    };
  }
  if (prePushContent && prePushInvokesVerifyBranch(prePushContent)) {
    return {
      code: 1,
      message:
        "❌ deft hooks wired but NON-FUNCTIONAL: pre-push must not invoke verify:branch (#1814).\n" +
        "  Recovery: re-run the deft installer / `task setup` to refresh .githooks/.",
      stream: "stderr",
    };
  }

  return {
    code: 0,
    message:
      `✓ deft hooks installed and functional: core.hooksPath=${hooksPath}, ` +
      `hooks ${REQUIRED_HOOKS.join(", ")} present and dispatch via deft CLI (#2049).`,
    stream: "stdout",
  };
}
