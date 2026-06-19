import * as childProcess from "node:child_process";
import { accessSync, constants } from "node:fs";

export type ProbeFn = (command: string) => string | null;
export type InputFn = (prompt: string) => string;
export type OutputFn = (line: string) => void;

export interface RunResult {
  readonly returncode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunFn = (command: readonly string[]) => RunResult;

export interface ToolSpec {
  readonly name: string;
  readonly commands: readonly string[];
  readonly url: string;
  readonly manualCommands: Readonly<Record<string, string>>;
  readonly packages: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly foundational?: boolean;
}

export interface ToolStatus {
  readonly name: string;
  readonly installed: boolean;
  readonly command: string | null;
  readonly installable: boolean;
  readonly installCommand: readonly string[] | null;
  readonly manualCommand: string | null;
  readonly url: string | null;
  readonly installedAfterOffer: boolean;
  readonly declined: boolean;
  readonly installError: string | null;
  readonly foundational: boolean;
}

export interface VerificationResult {
  readonly statuses: readonly ToolStatus[];
  readonly platformId: string;
  readonly packageManager: string | null;
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1 | 2;
}

const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "git",
    commands: ["git"],
    url: "https://git-scm.com/downloads",
    manualCommands: {
      windows: "winget install --id Git.Git -e",
      macos: "brew install git",
      linux: "sudo apt-get install git",
      unknown: "Install Git from https://git-scm.com/downloads",
    },
    packages: {},
    foundational: true,
  },
  {
    name: "task",
    commands: ["task"],
    url: "https://taskfile.dev/installation/",
    manualCommands: {
      windows: "winget install --id Task.Task -e",
      macos: "brew install go-task",
      linux: "sudo apt-get install go-task",
      unknown: "Install Task from https://taskfile.dev/installation/",
    },
    packages: {
      windows: {
        winget: ["winget", "install", "--id", "Task.Task", "-e"],
        scoop: ["scoop", "install", "go-task"],
        choco: ["choco", "install", "go-task", "-y"],
      },
      macos: { brew: ["brew", "install", "go-task"] },
      linux: {
        "apt-get": ["sudo", "apt-get", "install", "-y", "go-task"],
        dnf: ["sudo", "dnf", "install", "-y", "go-task"],
        pacman: ["sudo", "pacman", "-S", "--noconfirm", "go-task"],
      },
    },
  },
  {
    name: "uv",
    commands: ["uv"],
    url: "https://docs.astral.sh/uv/getting-started/installation/",
    manualCommands: {
      windows: "winget install --id astral-sh.uv -e",
      macos: "brew install uv",
      linux: "sudo apt-get install uv",
      unknown: "Install uv from https://docs.astral.sh/uv/getting-started/installation/",
    },
    packages: {
      windows: {
        winget: ["winget", "install", "--id", "astral-sh.uv", "-e"],
        scoop: ["scoop", "install", "uv"],
        choco: ["choco", "install", "uv", "-y"],
      },
      macos: { brew: ["brew", "install", "uv"] },
      linux: {
        "apt-get": ["sudo", "apt-get", "install", "-y", "uv"],
        dnf: ["sudo", "dnf", "install", "-y", "uv"],
        pacman: ["sudo", "pacman", "-S", "--noconfirm", "uv"],
      },
    },
  },
  {
    name: "python",
    commands: ["python3", "python"],
    url: "https://www.python.org/downloads/",
    manualCommands: {
      windows: "winget install --id Python.Python.3 -e",
      macos: "brew install python",
      linux: "sudo apt-get install python3",
      unknown: "Install Python from https://www.python.org/downloads/",
    },
    packages: {
      windows: {
        winget: ["winget", "install", "--id", "Python.Python.3", "-e"],
        scoop: ["scoop", "install", "python"],
        choco: ["choco", "install", "python", "-y"],
      },
      macos: { brew: ["brew", "install", "python"] },
      linux: {
        "apt-get": ["sudo", "apt-get", "install", "-y", "python3"],
        dnf: ["sudo", "dnf", "install", "-y", "python3"],
        pacman: ["sudo", "pacman", "-S", "--noconfirm", "python"],
      },
    },
  },
  {
    name: "gh",
    commands: ["gh"],
    url: "https://cli.github.com/",
    manualCommands: {
      windows: "winget install --id GitHub.cli -e",
      macos: "brew install gh",
      linux: "sudo apt-get install gh",
      unknown: "Install GitHub CLI from https://cli.github.com/",
    },
    packages: {
      windows: {
        winget: ["winget", "install", "--id", "GitHub.cli", "-e"],
        scoop: ["scoop", "install", "gh"],
        choco: ["choco", "install", "gh", "-y"],
      },
      macos: { brew: ["brew", "install", "gh"] },
      linux: {
        "apt-get": ["sudo", "apt-get", "install", "-y", "gh"],
        dnf: ["sudo", "dnf", "install", "-y", "gh"],
        pacman: ["sudo", "pacman", "-S", "--noconfirm", "github-cli"],
      },
    },
  },
];

const PACKAGE_MANAGERS: Readonly<Record<string, readonly string[]>> = {
  windows: ["winget", "scoop", "choco"],
  macos: ["brew"],
  linux: ["apt-get", "dnf", "pacman"],
};

/** Detect host platform id (mirrors Python detect_platform). */
export function detectPlatform(platform?: NodeJS.Platform): string {
  const system = platform ?? process.platform;
  if (system === "win32") return "windows";
  if (system === "darwin") return "macos";
  if (system === "linux") return "linux";
  return "unknown";
}

/** Detect first available package manager on PATH. */
export function detectPackageManager(
  platformId: string,
  probe: ProbeFn = defaultProbe,
): string | null {
  for (const manager of PACKAGE_MANAGERS[platformId] ?? []) {
    if (probe(manager)) return manager;
  }
  return null;
}

function pathDelimiter(): string {
  return process.platform === "win32" ? ";" : ":";
}

/** Default PATH probe mirroring shutil.which (best-effort). */
export function defaultProbe(command: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(pathDelimiter()).filter((d) => d.length > 0);
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = ext.length > 0 ? `${dir}/${command}${ext}` : `${dir}/${command}`;
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}

function installedCommand(spec: ToolSpec, probe: ProbeFn): string | null {
  for (const command of spec.commands) {
    if (probe(command)) return command;
  }
  return null;
}

function installCommand(
  spec: ToolSpec,
  platformId: string,
  packageManager: string | null,
): readonly string[] | null {
  if (packageManager === null) return null;
  return spec.packages[platformId]?.[packageManager] ?? null;
}

function guidanceLines(status: ToolStatus, willPrompt: boolean): string[] {
  if (status.foundational) {
    return [
      `[deft tools] Required foundational tool \`${status.name}\` is missing; install it before continuing.`,
      `[deft tools] Manual install: ${status.manualCommand}`,
      `[deft tools] Canonical install URL: ${status.url}`,
    ];
  }
  if (status.installCommand) {
    const headline = willPrompt
      ? `[deft tools] \`${status.name}\` is not installed on this machine. Install it now? (Y/n)`
      : `[deft tools] \`${status.name}\` is not installed on this machine; re-run with \`--install\` to set it up.`;
    return [
      headline,
      `[deft tools] Auto-install command: ${status.installCommand.join(" ")}`,
      `[deft tools] Manual install: ${status.manualCommand}`,
      `[deft tools] Canonical install URL: ${status.url}`,
    ];
  }
  return [
    `[deft tools] \`${status.name}\` is not installed and no safe automated installer was detected.`,
    `[deft tools] Manual install: ${status.manualCommand}`,
    `[deft tools] Canonical install URL: ${status.url}`,
  ];
}

function isUnresolved(status: ToolStatus): boolean {
  return !status.installed && !status.installedAfterOffer;
}

function missingStatuses(statuses: readonly ToolStatus[]): ToolStatus[] {
  return statuses.filter(isUnresolved);
}

function computeExitCode(statuses: readonly ToolStatus[]): 0 | 1 | 2 {
  if (statuses.some((s) => s.foundational && isUnresolved(s))) return 2;
  return missingStatuses(statuses).length > 0 ? 1 : 0;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const sorted: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      sorted[key] = sortJson(val);
    }
    return sorted;
  }
  return value;
}

/** Serialize verification result to JSON (mirrors Python to_json). */
export function verificationResultToJson(result: VerificationResult): string {
  const payload = {
    exit_code: result.exitCode,
    package_manager: result.packageManager,
    platform: result.platformId,
    tools: result.statuses.map((status) => ({
      command: status.command,
      declined: status.declined,
      foundational: status.foundational,
      install_command: [...(status.installCommand ?? [])],
      install_error: status.installError,
      installable: status.installable,
      installed: status.installed || status.installedAfterOffer,
      manual_command: status.manualCommand,
      name: status.name,
      url: status.url,
    })),
  };
  return JSON.stringify(sortJson(payload));
}

export interface VerifyRequiredToolsOptions {
  readonly install?: boolean;
  readonly assumeYes?: boolean;
  readonly includeTask?: boolean;
  readonly platformId?: string;
  readonly probe?: ProbeFn;
  readonly inputFn?: InputFn;
  readonly runFn?: RunFn;
  readonly outputFn?: OutputFn;
}

/** Verify required host tooling (mirrors verify_tools.verify_required_tools). */
export function verifyRequiredTools(options: VerifyRequiredToolsOptions = {}): VerificationResult {
  const resolvedPlatform = options.platformId ?? detectPlatform();
  const probe = options.probe ?? defaultProbe;
  const packageManager = detectPackageManager(resolvedPlatform, probe);
  const statuses: ToolStatus[] = [];
  const lines: string[] = [];

  const selectedSpecs = options.includeTask
    ? TOOL_SPECS
    : TOOL_SPECS.filter((spec) => spec.name !== "task");

  for (const spec of selectedSpecs) {
    const found = installedCommand(spec, probe);
    if (found) {
      statuses.push({
        name: spec.name,
        installed: true,
        command: found,
        installable: false,
        installCommand: null,
        manualCommand: null,
        url: null,
        installedAfterOffer: false,
        declined: false,
        installError: null,
        foundational: spec.foundational ?? false,
      });
      continue;
    }

    const manualCommand =
      spec.manualCommands[resolvedPlatform] ?? spec.manualCommands.unknown ?? null;
    const installCmd = installCommand(spec, resolvedPlatform, packageManager);
    const base: ToolStatus = {
      name: spec.name,
      installed: false,
      command: null,
      installable: installCmd !== null && !(spec.foundational ?? false),
      installCommand: installCmd,
      manualCommand,
      url: spec.url,
      installedAfterOffer: false,
      declined: false,
      installError: null,
      foundational: spec.foundational ?? false,
    };

    const willPrompt = (options.install ?? false) && !(options.assumeYes ?? false);
    lines.push(...guidanceLines(base, willPrompt));

    if (!(options.install ?? false) || base.foundational || installCmd === null) {
      statuses.push(base);
      continue;
    }

    let approved = options.assumeYes ?? false;
    if (!approved) {
      const prompt = `${spec.name} is not installed on this machine. Install it now? (Y/n) `;
      const answer = (options.inputFn ?? (() => ""))(prompt);
      approved =
        answer.trim().toLowerCase() === "" || ["y", "yes"].includes(answer.trim().toLowerCase());
    }
    if (!approved) {
      statuses.push({ ...base, declined: true });
      continue;
    }

    const proc = (options.runFn ?? defaultRun)(installCmd);
    const rechecked = installedCommand(spec, probe);
    if (proc.returncode === 0 && rechecked) {
      statuses.push({ ...base, installedAfterOffer: true, command: rechecked });
    } else {
      const error = (proc.stderr || proc.stdout || "installer did not put tool on PATH").trim();
      statuses.push({ ...base, installError: error });
    }
  }

  const missing = missingStatuses(statuses);
  if (missing.length > 0) {
    lines.push(`[deft tools] Unresolved required tools: ${missing.map((s) => s.name).join(", ")}.`);
  } else if (lines.length > 0) {
    lines.push("[deft tools] Required tools are now available.");
  } else {
    lines.push("[deft tools] Required tools are available.");
  }

  const exitCode = computeExitCode(statuses);
  if (options.outputFn) {
    for (const line of lines) {
      options.outputFn(line);
    }
  }

  return {
    statuses,
    platformId: resolvedPlatform,
    packageManager,
    lines,
    exitCode,
  };
}

export function defaultRun(command: readonly string[]): RunResult {
  try {
    const stdout = childProcess.execFileSync(command[0] ?? "", command.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { returncode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      returncode: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}
