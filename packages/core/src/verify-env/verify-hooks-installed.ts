import * as childProcess from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type OutputStream = "stdout" | "stderr" | "none";

export interface EvaluateResult {
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
}

export const REQUIRED_HOOKS = ["pre-commit", "pre-push"] as const;
export const SCRIPTS_PROBE = "preflight_branch.py";
export const GATE_SCRIPTS = [
  "preflight_branch.py",
  "verify_encoding.py",
  "preflight_gh.py",
] as const;
export const SCRIPTS_DIR_CANDIDATES = ["scripts", ".deft/core/scripts", "deft/scripts"] as const;

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

function resolveScriptsDir(projectRoot: string): string | null {
  for (const rel of SCRIPTS_DIR_CANDIDATES) {
    const candidate = join(projectRoot, rel);
    if (isFile(join(candidate, SCRIPTS_PROBE))) {
      return candidate;
    }
  }
  return null;
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

  const scriptsDir = resolveScriptsDir(root);
  if (scriptsDir === null) {
    return {
      code: 1,
      message:
        "❌ deft hooks wired but NON-FUNCTIONAL: the gate scripts cannot be resolved.\n" +
        `  Looked for ${SCRIPTS_PROBE} under: ${SCRIPTS_DIR_CANDIDATES.join(", ")} (relative to ${root}).\n` +
        "  Recovery: re-run the deft installer so the payload is present.",
      stream: "stderr",
    };
  }

  const missingScripts = GATE_SCRIPTS.filter((s) => !isFile(join(scriptsDir, s)));
  if (missingScripts.length > 0) {
    return {
      code: 1,
      message:
        `❌ deft hooks wired but NON-FUNCTIONAL: ${scriptsDir} is missing ` +
        `gate script(s): ${missingScripts.join(", ")} (#1463 false-green).\n` +
        "  Recovery: re-run the deft installer to restore the payload.",
      stream: "stderr",
    };
  }

  return {
    code: 0,
    message:
      `✓ deft hooks installed and functional: core.hooksPath=${hooksPath}, ` +
      `hooks ${REQUIRED_HOOKS.join(", ")} present, gate scripts resolve under ${scriptsDir}.`,
    stream: "stdout",
  };
}
