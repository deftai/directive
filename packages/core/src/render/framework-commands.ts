import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { cmdDoctor } from "../doctor/main.js";

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
  "core:lint": spec("core:lint", "framework_commands:_cmd_core_lint", { cwd: "framework" }),
  "core:test": spec("core:test", "framework_commands:_cmd_core_test", { cwd: "framework" }),
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
  "migrate:vbrief": spec("migrate:vbrief", "framework_commands:_cmd_migrate_vbrief"),
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
    defaultArgs: ["--version", "__DEFT_VERSION__"],
    cwd: "framework",
  }),
  "check:consumer": aggregate("check:consumer", [
    "doctor",
    "toolchain:check",
    "verify:branch",
    "verify:cache-fresh",
    "verify:wip-cap",
    "vbrief:validate",
    "verify-strategy-output",
  ]),
  "check:framework-source": aggregate("check:framework-source", [
    "core:validate",
    "core:lint",
    "core:test",
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

const EXCLUDE_PARTS = new Set([".git", "backup"]);

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

export function cmdCoreValidate(argv: readonly string[]): number {
  if (argv.length > 0) {
    process.stderr.write(`error: core:validate does not accept arguments: ${argv.join(" ")}\n`);
    return 2;
  }
  const files = collectMarkdownFiles(".");
  for (const path of files) process.stdout.write(`✓ ${path}\n`);
  process.stdout.write(`✓ All ${files.length} markdown files validated\n`);
  return 0;
}

function runUv(args: string[], frameworkRoot: string): number {
  try {
    execFileSync("uv", ["--project", frameworkRoot, "run", ...args], {
      encoding: "utf8",
      stdio: "inherit",
    });
    return 0;
  } catch (err) {
    const e = err as { status?: number };
    return e.status ?? 1;
  }
}

export function cmdCoreLint(argv: readonly string[]): number {
  if (argv.length > 0) {
    process.stderr.write(`error: core:lint does not accept arguments: ${argv.join(" ")}\n`);
    return 2;
  }
  const ruffCode = runUv(["ruff", "check", "."], resolveFrameworkRoot());
  if (ruffCode !== 0) return ruffCode;
  const targets = ["run.py"];
  if (existsSync("tests")) targets.push("tests");
  return runUv(["python", "-m", "mypy", ...targets], resolveFrameworkRoot());
}

export function cmdCoreTest(argv: readonly string[]): number {
  if (argv.length > 0) {
    process.stderr.write(`error: core:test does not accept arguments: ${argv.join(" ")}\n`);
    return 2;
  }
  if (!existsSync("tests")) {
    process.stdout.write("no tests/ (vendored consumer) -- skipping\n");
    return 0;
  }
  try {
    execFileSync("python3", ["-m", "pytest", "tests"], { encoding: "utf8", stdio: "inherit" });
    return 0;
  } catch (err) {
    const e = err as { status?: number };
    return e.status ?? 1;
  }
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
    resolved.push(item === "__DEFT_VERSION__" ? resolveVersion() : item);
  }
  if (commandSpec.projectRootArg) resolved.push(commandSpec.projectRootArg, projectRoot);
  if (commandSpec.frameworkRootArg) resolved.push(commandSpec.frameworkRootArg, frameworkRoot);
  if (commandSpec.vbriefDirArg)
    resolved.push(commandSpec.vbriefDirArg, join(projectRoot, "vbrief"));
  if (commandSpec.rootArg) resolved.push(commandSpec.rootArg, frameworkRoot);
  resolved.push(...normalizeTaskSeparator(argv));
  return resolved;
}

const TS_INLINE: Record<string, (argv: string[]) => number> = {
  "framework_commands:_cmd_core_validate": (argv) => cmdCoreValidate(argv),
  "framework_commands:_cmd_core_lint": (argv) => cmdCoreLint(argv),
  "framework_commands:_cmd_core_test": (argv) => cmdCoreTest(argv),
  "doctor:cmd_doctor": (argv) => cmdDoctor(argv),
};

function spawnPythonEntrypoint(
  entrypoint: string,
  argv: string[],
  cwd: string,
  frameworkRoot: string,
  noArgv: boolean,
): CommandResult {
  const scriptsDir = join(frameworkRoot, "scripts").replace(/\\/g, "/");
  const code = [
    "import sys, importlib, importlib.util, inspect, os",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    `os.chdir(${JSON.stringify(cwd.replace(/\\/g, "/"))})`,
    `entrypoint = ${JSON.stringify(entrypoint)}`,
    "module_ref, _, func_name = entrypoint.partition(':')",
    "if module_ref.endswith('.py'):",
    "    path = __import__('pathlib').Path(module_ref)",
    "    if not path.is_absolute():",
    `        path = __import__('pathlib').Path(${JSON.stringify(scriptsDir)}) / module_ref`,
    "    module_name = '_deft_cmd_' + path.stem.replace('-', '_')",
    "    spec = importlib.util.spec_from_file_location(module_name, path)",
    "    mod = importlib.util.module_from_spec(spec)",
    "    spec.loader.exec_module(mod)",
    "else:",
    "    mod = importlib.import_module(module_ref)",
    "func = getattr(mod, func_name)",
    `argv = ${JSON.stringify(argv)}`,
    "if not callable(func):",
    "    raise TypeError('not callable')",
    noArgv
      ? "code = func() if len(inspect.signature(func).parameters) == 0 else func([])"
      : "code = func() if len(inspect.signature(func).parameters) == 0 else func(argv)",
    "sys.exit(int(code or 0))",
  ].join("\n");

  try {
    const stdout = execFileSync("uv", ["--project", frameworkRoot, "run", "python", "-c", code], {
      cwd: frameworkRoot,
      encoding: "utf8",
      env: { ...process.env, PYTHONUTF8: "1", DEFT_CACHE_DISABLE: "1" },
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
        code = inline(argv);
      } finally {
        process.stdout.write = prevOut;
        process.stderr.write = prevErr;
      }
      return { code, stdout: chunks.out, stderr: chunks.err };
    }
    return { code: inline(argv), stdout: "", stderr: "" };
  }
  return spawnPythonEntrypoint(entrypoint, argv, cwd, frameworkRoot, noArgv);
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
