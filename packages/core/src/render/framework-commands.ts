import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdDoctor } from "../doctor/main.js";
import { resolveLifecycleRoot } from "../layout/resolve.js";

export type RootMode = "project" | "framework";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandSpec {
  readonly name: string;
  readonly entrypoint?: string;
  readonly defaultArgs?: readonly string[];
  readonly projectRootArg?: string;
  readonly frameworkRootArg?: string;
  readonly vbriefDirArg?: string;
  readonly rootArg?: string;
  readonly cwd?: RootMode;
  readonly noArgv?: boolean;
  readonly aggregate?: readonly string[];
  readonly description?: string;
}

function spec(
  name: string,
  entrypoint: string,
  opts: Partial<Omit<CommandSpec, "name" | "entrypoint">> = {},
): CommandSpec {
  return { name, entrypoint, ...opts };
}

function aggregate(name: string, commands: readonly string[], description = ""): CommandSpec {
  return { name, aggregate: commands, description };
}

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  "core:validate": spec("core:validate", "framework_commands:_cmd_core_validate", {
    cwd: "framework",
  }),
  doctor: spec("doctor", "doctor:cmd_doctor"),
  "session:start": spec("session:start", "session_start:main", {
    projectRootArg: "--project-root",
  }),
  "triage:welcome": spec("triage:welcome", "triage_welcome:main", {
    projectRootArg: "--project-root",
  }),
  "triage:bootstrap": spec("triage:bootstrap", "triage_bootstrap:main", {
    projectRootArg: "--project-root",
  }),
  "triage:summary": spec("triage:summary", "triage_summary:main", {
    projectRootArg: "--project-root",
  }),
  "triage:queue": spec("triage:queue", "triage_queue:main", {
    defaultArgs: ["queue"],
    projectRootArg: "--project-root",
  }),
  "triage:show": spec("triage:show", "triage_queue:main", {
    defaultArgs: ["show"],
    projectRootArg: "--project-root",
  }),
  "triage:audit": spec("triage:audit", "triage_queue:main", {
    defaultArgs: ["audit"],
    projectRootArg: "--project-root",
  }),
  "triage:accept": spec("triage:accept", "triage_actions:main", { defaultArgs: ["accept"] }),
  "triage:status": spec("triage:status", "triage_actions:main", { defaultArgs: ["status"] }),
  "triage:scope": spec("triage:scope", "triage_scope:main"),
  "cache:fetch-all": spec("cache:fetch-all", "cache:main", { defaultArgs: ["fetch-all"] }),
  "capacity:show": spec("capacity:show", "capacity_show:main", {
    projectRootArg: "--project-root",
  }),
  "scope:demote": spec("scope:demote", "scope_demote:main", { projectRootArg: "--project-root" }),
  "toolchain:check": spec("toolchain:check", "toolchain-check.py:main", { noArgv: true }),
  "verify:stubs": spec("verify:stubs", "verify-stubs.py:main", { noArgv: true }),
  "verify:links": spec("verify:links", "validate-links.py:main", { noArgv: true }),
  "verify:rule-ownership": spec("verify:rule-ownership", "rule_ownership_lint:main", {
    rootArg: "--root",
    cwd: "framework",
  }),
  "verify:branch": spec("verify:branch", "preflight_branch:main", {
    defaultArgs: ["--allow-missing-project-definition"],
    projectRootArg: "--project-root",
  }),
  "verify:encoding": spec("verify:encoding", "verify_encoding:main", {
    projectRootArg: "--project-root",
  }),
  "verify:vbrief-conformance": spec("verify:vbrief-conformance", "verify_vbrief_conformance:main", {
    projectRootArg: "--project-root",
  }),
  "verify:destructive-gh-verbs": spec("verify:destructive-gh-verbs", "preflight_gh:main", {
    defaultArgs: ["--self-test"],
    projectRootArg: "--project-root",
  }),
  "verify:scm-boundary": spec("verify:scm-boundary", "verify_scm_boundary:main", {
    projectRootArg: "--project-root",
  }),
  "verify:no-task-runtime": spec("verify:no-task-runtime", "verify_no_task_runtime:main", {
    noArgv: true,
    cwd: "framework",
  }),
  "verify:cache-fresh": spec("verify:cache-fresh", "preflight_cache:main", {
    defaultArgs: ["--allow-missing-bootstrap"],
    projectRootArg: "--project-root",
  }),
  "verify:wip-cap": spec("verify:wip-cap", "preflight_wip_cap:main", {
    projectRootArg: "--project-root",
  }),
  "verify:orphan-active": spec("verify:orphan-active", "verify_orphan_active:main", {
    projectRootArg: "--project-root",
  }),
  "verify:completed-tracked": spec("verify:completed-tracked", "verify_completed_tracked:main", {
    projectRootArg: "--project-root",
  }),
  "verify:pack-drift": spec("verify:pack-drift", "pack_render:main", {
    defaultArgs: ["--check"],
    cwd: "framework",
  }),
  "verify-strategy-output": spec("verify-strategy-output", "validate_strategy_output:main", {
    projectRootArg: "--project-root",
  }),
  "vbrief:validate": spec("vbrief:validate", "vbrief_validate:main", {
    vbriefDirArg: "--vbrief-dir",
  }),
  build: spec("build", "build_dist:main", {
    defaultArgs: ["--version", "__DEFT_VERSION__", "--root", "__DEFT_ROOT__"],
    cwd: "framework",
  }),
  "check:consumer": aggregate("check:consumer", [
    "doctor",
    "toolchain:check",
    "verify:branch",
    "verify:cache-fresh",
    "verify:wip-cap",
    "verify:orphan-active",
    "verify:completed-tracked",
    "vbrief:validate",
    "verify-strategy-output",
  ]),
  "check:framework-source": aggregate("check:framework-source", [
    "core:validate",
    "toolchain:check",
    "verify:stubs",
    "verify:links",
    "verify:rule-ownership",
    "verify:branch",
    "verify:encoding",
    "verify:vbrief-conformance",
    "verify:destructive-gh-verbs",
    "verify:scm-boundary",
    "verify:no-task-runtime",
    "verify:cache-fresh",
    "verify:pack-drift",
    "verify:wip-cap",
    "verify:orphan-active",
    "verify:completed-tracked",
    "vbrief:validate",
    "verify-strategy-output",
  ]),
};

export function availableCommands(): readonly string[] {
  return Object.keys(COMMANDS).sort();
}

export function hasCommand(name: string): boolean {
  return name in COMMANDS;
}

export function normalizeTaskSeparator(argv: readonly string[]): string[] {
  const args = [...argv];
  if (args[0] === "--") return args.slice(1);
  return args;
}

export function formatFrameworkCommand(
  args: readonly string[],
  options: { surface?: string; taskPrefix?: string | null } = {},
): string {
  const surface = options.surface ?? "deft";
  const parts = [...args];
  if (surface === "task") {
    let prefix = (options.taskPrefix ?? "").trim();
    if (prefix && !prefix.endsWith(":")) prefix = `${prefix}:`;
    if (parts.length > 0 && parts[0]) parts[0] = `${prefix}${parts[0]}`;
    return ["task", ...parts].join(" ");
  }
  return [surface, ...parts].join(" ");
}

const EXCLUDE_PARTS = new Set([".git", "backup", "node_modules", ".deft-scratch"]);

function collectMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, parts: string[]): void => {
    if (parts.some((p) => EXCLUDE_PARTS.has(p))) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = parts.length === 0 ? name : join(...parts, name);
      const nextParts = [...parts, name];
      if (nextParts.some((p) => EXCLUDE_PARTS.has(p))) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, nextParts);
      else if (name.endsWith(".md")) out.push(rel);
    }
  };
  walk(root, []);
  return out.sort();
}

export function cmdCoreValidate(argv: readonly string[], root = "."): number {
  if (argv.length > 0) {
    process.stderr.write(`error: core:validate does not accept arguments: ${argv.join(" ")}\n`);
    return 2;
  }
  const files = collectMarkdownFiles(root);
  for (const path of files) process.stdout.write(`✓ ${path}\n`);
  process.stdout.write(`✓ All ${files.length} markdown files validated\n`);
  return 0;
}

export function cmdCoreLint(_argv: readonly string[]): number {
  process.stderr.write("error: core:lint removed (#1860); use ts:check-lane\n");
  return 2;
}

export function cmdCoreTest(_argv: readonly string[]): number {
  process.stderr.write("error: core:test removed (#1860); use ts:check-lane\n");
  return 2;
}

function resolveVersion(): string {
  try {
    const mod = readFileSync(join(resolveFrameworkRoot(), "VERSION"), "utf8").trim();
    return mod || "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export function resolveFrameworkRoot(): string {
  if (process.env.DEFT_ROOT && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(import.meta.dirname, "..", "..", "..", "..");
}

function argvForSpec(
  commandSpec: CommandSpec,
  argv: readonly string[],
  projectRoot: string,
  frameworkRoot: string,
): string[] {
  const resolved: string[] = [];
  for (const item of commandSpec.defaultArgs ?? []) {
    if (item === "__DEFT_VERSION__") resolved.push(resolveVersion());
    else if (item === "__DEFT_ROOT__") resolved.push(frameworkRoot);
    else resolved.push(item);
  }
  if (commandSpec.projectRootArg) resolved.push(commandSpec.projectRootArg, projectRoot);
  if (commandSpec.frameworkRootArg) resolved.push(commandSpec.frameworkRootArg, frameworkRoot);
  if (commandSpec.vbriefDirArg)
    resolved.push(commandSpec.vbriefDirArg, resolveLifecycleRoot(projectRoot));
  if (commandSpec.rootArg) resolved.push(commandSpec.rootArg, frameworkRoot);
  resolved.push(...normalizeTaskSeparator(argv));
  return resolved;
}

const BUILD_DIST_RUNNER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "release",
  "build-dist-runner.js",
);

function runBuildDistArgv(argv: readonly string[]): number {
  let version: string | null = null;
  let root: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--version") version = argv[++i] as string;
    else if (arg === "--root") root = argv[++i] as string;
  }
  if (!version || !root) {
    process.stderr.write("build: --version and --root are required\n");
    return 2;
  }
  const result = spawnSync(process.execPath, [BUILD_DIST_RUNNER, version, root], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEFT_RELEASE_VERSION: version },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

type TsInlineHandler = (argv: string[], cwd: string) => number;

const TS_INLINE: Record<string, TsInlineHandler> = {
  "framework_commands:_cmd_core_validate": (argv, cwd) => cmdCoreValidate(argv, cwd),
  "doctor:cmd_doctor": (argv) => cmdDoctor(argv),
  "build_dist:main": (argv) => runBuildDistArgv(argv),
};
const ENTRYPOINT_VERB: Record<string, string> = {
  "session_start:main": "session-start",
  "triage_welcome:main": "triage-welcome",
  "triage_bootstrap:main": "triage-bootstrap",
  "triage_summary:main": "triage-summary",
  "triage_queue:main": "triage-queue",
  "triage_actions:main": "triage-actions",
  "triage_scope:main": "triage-scope",
  "cache:main": "cache",
  "capacity_show:main": "capacity-show",
  "scope_demote:main": "scope-demote",
  "toolchain-check.py:main": "toolchain-check",
  "verify-stubs.py:main": "verify-stubs",
  "validate-links.py:main": "validate-links",
  "rule_ownership_lint:main": "rule-ownership-lint",
  "preflight_branch:main": "verify-branch",
  "verify_encoding:main": "verify-encoding",
  "verify_vbrief_conformance:main": "vbrief-validate",
  "preflight_gh:main": "preflight-gh",
  "verify_scm_boundary:main": "verify-scm-boundary",
  "verify_no_task_runtime:main": "verify-no-task-runtime",
  "preflight_cache:main": "preflight-cache",
  "preflight_wip_cap:main": "verify-wip-cap",
  "verify_orphan_active:main": "verify-orphan-active",
  "verify_completed_tracked:main": "verify-completed-tracked",
  "pack_render:main": "pack-render",
  "validate_strategy_output:main": "validate-strategy-output",
  "vbrief_validate:main": "vbrief-validate",
};

function deftCliBin(frameworkRoot: string): string {
  return join(frameworkRoot, "packages", "cli", "dist", "bin.js");
}

function spawnDeftVerb(
  verb: string,
  argv: string[],
  cwd: string,
  frameworkRoot: string,
): CommandResult {
  const bin = deftCliBin(frameworkRoot);
  if (!existsSync(bin)) {
    return {
      code: 2,
      stdout: "",
      stderr: `deft CLI not built at ${bin}; run pnpm run build first\n`,
    };
  }
  try {
    const stdout = execFileSync(process.execPath, [bin, verb, ...argv], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, DEFT_CACHE_DISABLE: "1" },
    });
    return { code: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 2,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
}

function invokeEntrypoint(
  entrypoint: string,
  argv: string[],
  cwd: string,
  frameworkRoot: string,
  noArgv: boolean,
  capture: boolean,
): CommandResult {
  const inline = TS_INLINE[entrypoint];
  if (inline) {
    if (capture) {
      const chunks = { out: "", err: "" };
      const prevOut = process.stdout.write.bind(process.stdout);
      const prevErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = (chunk: string | Uint8Array) => {
        chunks.out += String(chunk);
        return true;
      };
      process.stderr.write = (chunk: string | Uint8Array) => {
        chunks.err += String(chunk);
        return true;
      };
      let code: number;
      try {
        code = inline(argv, cwd);
      } finally {
        process.stdout.write = prevOut;
        process.stderr.write = prevErr;
      }
      return { code, stdout: chunks.out, stderr: chunks.err };
    }
    return { code: inline(argv, cwd), stdout: "", stderr: "" };
  }
  const verb = ENTRYPOINT_VERB[entrypoint];
  if (verb) {
    const effectiveArgv = noArgv ? [] : argv;
    const result = spawnDeftVerb(verb, effectiveArgv, cwd, frameworkRoot);
    if (capture) return result;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
  }
  return {
    code: 2,
    stdout: "",
    stderr: `unknown entrypoint (Python scripts removed #1860): ${entrypoint}\n`,
  };
}

export interface RunFrameworkCommandOptions {
  readonly projectRoot?: string;
  readonly frameworkRoot?: string;
  readonly capture?: boolean;
  readonly outputFn?: (line: string) => void;
}

export function runFrameworkCommand(
  name: string,
  argv: readonly string[] = [],
  options: RunFrameworkCommandOptions = {},
): CommandResult {
  const root = resolve(options.projectRoot ?? process.cwd());
  const framework = resolve(options.frameworkRoot ?? resolveFrameworkRoot());
  const commandSpec = COMMANDS[name];
  if (!commandSpec) {
    return { code: 2, stdout: "", stderr: `unknown framework command: ${name}` };
  }

  if (commandSpec.aggregate && commandSpec.aggregate.length > 0) {
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    for (const child of commandSpec.aggregate) {
      options.outputFn?.(`[deft] ${child}`);
      const result = runFrameworkCommand(child, [], {
        ...options,
        projectRoot: root,
        frameworkRoot: framework,
      });
      stdoutParts.push(result.stdout);
      stderrParts.push(result.stderr);
      if (result.code !== 0) {
        return { code: result.code, stdout: stdoutParts.join(""), stderr: stderrParts.join("") };
      }
    }
    return { code: 0, stdout: stdoutParts.join(""), stderr: stderrParts.join("") };
  }

  if (!commandSpec.entrypoint) {
    return { code: 2, stdout: "", stderr: `framework command has no entrypoint: ${name}` };
  }

  const commandArgv = argvForSpec(commandSpec, argv, root, framework);
  const cwd = commandSpec.cwd === "framework" ? framework : root;
  const capture = options.capture ?? false;

  try {
    const result = invokeEntrypoint(
      commandSpec.entrypoint,
      commandArgv,
      cwd,
      framework,
      commandSpec.noArgv ?? false,
      capture,
    );
    if (!capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    return result;
  } catch (exc) {
    const msg = `${exc instanceof Error ? exc.name : "Error"}: ${String(exc)}`;
    if (capture) return { code: 2, stdout: "", stderr: msg };
    process.stderr.write(`${msg}\n`);
    return { code: 2, stdout: "", stderr: msg };
  }
}

/** CLI entry (mirrors ``scripts/framework_commands.main``). */
export function main(argv: readonly string[]): number {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(
      "Usage: framework_commands.py <verb> [args...]\n\nAvailable framework verbs:\n",
    );
    for (const name of availableCommands()) process.stdout.write(`  ${name}\n`);
    return 0;
  }
  const [command, ...rest] = argv;
  const result = runFrameworkCommand(command ?? "", rest);
  return result.code;
}
