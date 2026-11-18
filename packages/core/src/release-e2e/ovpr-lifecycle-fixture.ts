/**
 * No-agent lifecycle harness, #6614. Packs the launcher and runtime from this
 * workspace, installs them into throwaway projects, and runs the hook commands
 * each host config registers exactly as a host would (`sh -c` in the project,
 * JSON payload on stdin). No agent, no LLM, no network beyond the workspace's
 * own install.
 *
 * Built as an ordered list of named steps over one shared context. Each step
 * builds its own fixture folder, so a step can run alone (`--step 4`). Steps
 * 1-3 are one chain (bump, install, refresh): each builds the earlier links it
 * needs, memoised so a full run does the work once. A later ticket adds a step
 * by replacing its `skip` entry; no other step changes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { defaultWhich, spawnText } from "../release/spawn.js";
import {
  backupPackageManifests,
  installPackedConsumer,
  packAndInstallGlobally,
  restorePackageManifests,
  type SpawnTextFn,
} from "./packed-consumer.js";
import type { E2ESeams } from "./types.js";

export const FIXTURE_VERSION = "9.9.9-fixture";
const PROGRESS_PREFIX = "lifecycle fixture";
/** npm installs can be slow on a busy machine; the CI job has its own 12-minute cap. */
const INSTALL_TIMEOUT_MS = 300_000;

export type FixtureHost = "claude" | "codex" | "cursor" | "grok";
export const FIXTURE_HOSTS: readonly FixtureHost[] = ["claude", "codex", "cursor", "grok"];

export type FixtureStepId =
  | "1-bump"
  | "2-install"
  | "3-refresh"
  | "4-missing-packages"
  | "5-upgrade-commit"
  | "6-old-layout";

export type StepStatus = "pass" | "fail" | "skip";

export interface StepResult {
  status: StepStatus;
  detail: string;
}

export interface FixtureContext {
  repoRoot: string;
  /** Temp folder holding packs, the npm prefix and every step's fixture. */
  work: string;
  packDir: string;
  npmPrefix: string;
  /** Clean env with the packed launcher's bin first on PATH. */
  env: NodeJS.ProcessEnv;
  npm: string;
  /** Packed launcher `deft` and `deft-hook` in the temp prefix. */
  deft: string;
  deftHook: string;
  packed: readonly string[];
  version: string;
  seams: E2ESeams;
  spawn: SpawnTextFn;
  which: (name: string) => string | null;
  log: (message: string) => void;
  /** Per-run cache, so chained steps (1-3) reuse earlier work when run together. */
  memo: Map<string, unknown>;
}

export interface FixtureStep {
  id: FixtureStepId;
  title: string;
  /** True when the step needs the packed launcher and runtime. */
  needsPackages: boolean;
  run(ctx: FixtureContext): StepResult;
}

// ---------------------------------------------------------------------------
// Host configs and the hook runner
// ---------------------------------------------------------------------------

/** Where each host reads its hook registrations. */
export const HOST_CONFIG_PATHS: Readonly<Record<FixtureHost, string>> = {
  claude: ".claude/settings.json",
  codex: ".codex/hooks.json",
  cursor: ".cursor/hooks.json",
  grok: ".grok/hooks/deft.json",
};

/** The host's own key for the event under `hooks` in its config. */
const HOST_EVENT_KEYS: Readonly<Record<string, Readonly<Record<FixtureHost, string>>>> = {
  "tool.before": {
    claude: "PreToolUse",
    codex: "PreToolUse",
    cursor: "preToolUse",
    grok: "PreToolUse",
  },
};

/** Minimal host-shaped `tool.before` payload for a shell tool running `command`. */
export function shellToolPayload(
  host: FixtureHost,
  fixtureDir: string,
  command = "echo hi",
): Record<string, unknown> {
  if (host === "cursor") {
    return {
      hook_event_name: "preToolUse",
      tool_name: "Shell",
      tool_input: { command, cwd: fixtureDir },
      conversation_id: "fixture",
      session_id: "fixture",
    };
  }
  if (host === "grok") {
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command, cwd: fixtureDir },
      session_id: "fixture",
    };
  }
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: fixtureDir,
    session_id: "fixture",
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function matcherMatches(matcher: unknown, toolName: string): boolean {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return false;
  }
}

export type CommandLookup = { ok: true; command: string } | { ok: false; reason: string };

/**
 * The command a host would run for `event` and `toolName`, read from the
 * config Directive deposited. Cursor lists entries directly; the other hosts
 * nest `hooks[].command` in matcher groups. Grok resolves a relative command
 * beside its config file, so a `./x` command is made absolute here.
 */
export function registeredHookCommand(
  fixtureDir: string,
  host: FixtureHost,
  event: string,
  toolName: string,
): CommandLookup {
  const rel = HOST_CONFIG_PATHS[host];
  const path = join(fixtureDir, ...rel.split("/"));
  if (!existsSync(path)) return { ok: false, reason: `${host}: ${rel} is missing` };
  let config: Record<string, unknown> | null;
  try {
    config = asObject(JSON.parse(readFileSync(path, "utf8")));
  } catch (exc) {
    return { ok: false, reason: `${host}: ${rel} is not valid JSON (${String(exc)})` };
  }
  const key = HOST_EVENT_KEYS[event]?.[host];
  if (key === undefined) return { ok: false, reason: `${host}: no host key for event ${event}` };
  const entries = asObject(config?.hooks)?.[key];
  if (!Array.isArray(entries)) return { ok: false, reason: `${host}: ${rel} has no ${key} entry` };
  for (const raw of entries) {
    const entry = asObject(raw);
    if (entry === null || !matcherMatches(entry.matcher, toolName)) continue;
    let command: unknown = entry.command;
    if (host !== "cursor") {
      const nested = Array.isArray(entry.hooks) ? entry.hooks.map(asObject) : [];
      command = nested.find((h) => typeof h?.command === "string")?.command;
    }
    if (typeof command !== "string" || command.trim() === "") continue;
    if (host === "grok" && command.startsWith("./")) {
      // Forward slashes so `sh -c` keeps the path on Windows too.
      command = resolve(dirname(path), command).replaceAll("\\", "/");
    }
    return { ok: true, command: command as string };
  }
  return { ok: false, reason: `${host}: ${rel} ${key} has no entry for tool ${toolName}` };
}

export interface HookRun {
  host: FixtureHost;
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The POSIX shell a host runs hook commands with. On Windows hosts use Git's
 * shell; when `sh` is not on PATH, take the `sh.exe` that ships with Git.
 */
export function hookShell(platform = process.platform): string {
  if (platform !== "win32") return "sh";
  const where = (name: string): string[] => {
    const r = spawnSync("where", [name], { encoding: "utf8" });
    return r.status === 0
      ? (r.stdout ?? "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  };
  if (where("sh").length > 0) return "sh";
  for (const git of where("git")) {
    const gitRoot = dirname(dirname(git));
    // Git for Windows has bin\\sh.exe; MinGit has only usr\\bin\\sh.exe.
    for (const sh of [join(gitRoot, "bin", "sh.exe"), join(gitRoot, "usr", "bin", "sh.exe")]) {
      if (existsSync(sh)) return sh;
    }
  }
  return "sh";
}

export type HookRunResult = { ok: true; run: HookRun } | { ok: false; reason: string };

/**
 * Run the command the host config registers for `event`, through `sh -c` in
 * the fixture folder, with the JSON payload on stdin — what the host does.
 */
export function runRegisteredHook(
  fixtureDir: string,
  host: FixtureHost,
  event: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): HookRunResult {
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const lookup = registeredHookCommand(fixtureDir, host, event, toolName);
  if (!lookup.ok) return lookup;
  const result = spawnSync(hookShell(), ["-c", lookup.command], {
    cwd: fixtureDir,
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return {
      ok: false,
      reason: `${host}: cannot run "${lookup.command}": ${result.error.message}`,
    };
  }
  return {
    ok: true,
    run: {
      host,
      command: lookup.command,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    },
  };
}

// ---------------------------------------------------------------------------
// Block assertions (same table as P1-U1 / #6201)
// ---------------------------------------------------------------------------

export interface TextMatchers {
  /** Every pattern must match the block text. */
  include?: readonly RegExp[];
  /** No string may appear in the block text. */
  exclude?: readonly string[];
}

export interface Verdict {
  ok: boolean;
  detail: string;
}

/** Non-empty stdout lines parsed as JSON objects; null when any line is not one. */
function stdoutObjects(stdout: string): Record<string, unknown>[] | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = asObject(JSON.parse(line));
      if (parsed === null) return null;
      out.push(parsed);
    } catch {
      return null;
    }
  }
  return out;
}

function isDenyObject(host: FixtureHost, obj: Record<string, unknown>): boolean {
  if (host === "cursor") return obj.permission === "deny";
  if (host === "grok") return obj.decision === "deny";
  const specific = asObject(obj.hookSpecificOutput);
  return specific?.permissionDecision === "deny" || obj.decision === "block";
}

function denyText(obj: Record<string, unknown>): string {
  return ["user_message", "agent_message", "reason", "userMessage", "agentMessage"]
    .map((k) => obj[k])
    .filter((v): v is string => typeof v === "string")
    .join("\n");
}

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function checkText(host: FixtureHost, text: string, matchers: TextMatchers): Verdict {
  for (const pattern of matchers.include ?? []) {
    if (!pattern.test(text)) {
      return { ok: false, detail: `${host}: block text lacks ${pattern}: "${short(text)}"` };
    }
  }
  for (const banned of matchers.exclude ?? []) {
    if (text.includes(banned)) {
      return { ok: false, detail: `${host}: block text names "${banned}": "${short(text)}"` };
    }
  }
  return { ok: true, detail: `${host}: blocked` };
}

/**
 * The hook blocked in the host's own form, and its text matches.
 * Claude/Codex: exit 2, reason on stderr. Cursor: exit 0 with exactly one
 * `permission: "deny"` object (exit 2 also blocks). Grok: exit 0 with exactly
 * one `decision: "deny"` object.
 */
export function expectBlocked(
  host: FixtureHost,
  result: Pick<HookRun, "status" | "stdout" | "stderr">,
  matchers: TextMatchers = {},
): Verdict {
  if (host === "claude" || host === "codex" || (host === "cursor" && result.status === 2)) {
    if (result.status !== 2) {
      return {
        ok: false,
        detail: `${host}: expected exit 2 (block), got ${result.status}: "${short(result.stderr || result.stdout)}"`,
      };
    }
    return checkText(host, result.stderr, matchers);
  }
  if (result.status !== 0) {
    return {
      ok: false,
      detail: `${host}: expected exit 0 with a deny object, got exit ${result.status}: "${short(result.stderr || result.stdout)}"`,
    };
  }
  const objects = stdoutObjects(result.stdout);
  if (objects === null || objects.length !== 1) {
    return {
      ok: false,
      detail: `${host}: expected exactly one JSON object on stdout, got "${short(result.stdout)}"`,
    };
  }
  const [obj] = objects as [Record<string, unknown>];
  if (!isDenyObject(host, obj)) {
    return { ok: false, detail: `${host}: stdout object is not a deny: "${short(result.stdout)}"` };
  }
  return checkText(host, denyText(obj), matchers);
}

/** The hook let the tool call through: exit 0 and no deny on stdout. */
export function expectAllowed(
  host: FixtureHost,
  result: Pick<HookRun, "status" | "stdout" | "stderr">,
): Verdict {
  if (result.status !== 0) {
    return {
      ok: false,
      detail: `${host}: expected exit 0 (allow), got ${result.status}: "${short(result.stderr || result.stdout)}"`,
    };
  }
  const objects = stdoutObjects(result.stdout) ?? [];
  if (objects.some((o) => isDenyObject(host, o))) {
    return {
      ok: false,
      detail: `${host}: allowed exit but stdout denies: "${short(result.stdout)}"`,
    };
  }
  return { ok: true, detail: `${host}: allowed` };
}

/** Run `tool.before` for `echo hi` on every host and judge each result. */
function eachHost(
  fixtureDir: string,
  env: NodeJS.ProcessEnv,
  hosts: readonly FixtureHost[],
  judge: (host: FixtureHost, run: HookRun) => Verdict,
): Verdict {
  const failures: string[] = [];
  for (const host of hosts) {
    const ran = runRegisteredHook(
      fixtureDir,
      host,
      "tool.before",
      shellToolPayload(host, fixtureDir),
      env,
    );
    const verdict = ran.ok ? judge(host, ran.run) : { ok: false, detail: ran.reason };
    if (!verdict.ok) failures.push(verdict.detail);
  }
  return failures.length === 0
    ? { ok: true, detail: hosts.join(",") }
    : { ok: false, detail: failures.join("; ") };
}

// ---------------------------------------------------------------------------
// Steps 1-3: pin-only bump (AC14.10 / AC8.6, P3-U1b)
// ---------------------------------------------------------------------------

/** The "next" version W. V is the packed version; W is the same runtime repacked. */
export const FIXTURE_NEXT_VERSION = "9.9.10-fixture";
const RUNTIME_PACKAGE = "@deftai/directive-runtime";
const STAY_PUT_XBRIEF = join("xbrief", "proposed", "stay-put.xbrief.json");

/** Files under `dir` (skipping node_modules and .git) mapped to their bytes' sha256. */
export function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(childRel);
      } else if (entry.isFile()) {
        const hash = createHash("sha256")
          .update(readFileSync(join(dir, childRel)))
          .digest("hex");
        out.set(childRel, hash);
      }
    }
  };
  walk("");
  return out;
}

/** Paths added, removed or changed between two snapshots, sorted. */
export function changedPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const out = new Set<string>();
  for (const [path, hash] of before) if (after.get(path) !== hash) out.add(path);
  for (const path of after.keys()) if (!before.has(path)) out.add(path);
  return [...out].sort();
}

function sriSha512(path: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

/**
 * W: the packed runtime with only its version changed, repacked. The runtime
 * reads its own version from package.json, so this is a real second version
 * without the public registry.
 */
function nextRuntimeTarball(ctx: FixtureContext): [boolean, string, string] {
  const cached = ctx.memo.get("w-tarball");
  if (typeof cached === "string") return [true, "cached", cached];
  const runtimeTgz = ctx.packed.find((p) => p.includes("directive-runtime-"));
  if (runtimeTgz === undefined) return [false, "packed runtime tarball missing", ""];
  const tar = ctx.which("tar");
  if (tar === null) return [false, "tar not on PATH", ""];
  const unpack = join(ctx.work, "w-unpack");
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  let r = ctx.spawn(tar, ["-xzf", runtimeTgz, "-C", unpack], { timeoutMs: 120_000 });
  if (r.status !== 0) return [false, `tar -x failed: ${r.stderr.trim()}`, ""];
  const manifest = join(unpack, "package", "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  pkg.version = FIXTURE_NEXT_VERSION;
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  const out = join(ctx.packDir, `deftai-directive-runtime-${FIXTURE_NEXT_VERSION}.tgz`);
  r = ctx.spawn(tar, ["-czf", out, "-C", unpack, "package"], { timeoutMs: 120_000 });
  if (r.status !== 0) return [false, `tar -c failed: ${r.stderr.trim()}`, ""];
  ctx.memo.set("w-tarball", out);
  return [true, "repacked", out];
}

/** Change only the runtime pin and its lockfile entry from V to W (what a bump PR does). */
export function bumpRuntimePin(dir: string, version: string, tarball: string): void {
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string>>;
  for (const block of ["dependencies", "devDependencies"]) {
    if (pkg[block]?.[RUNTIME_PACKAGE] !== undefined) pkg[block][RUNTIME_PACKAGE] = version;
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const lockPath = join(dir, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
    packages?: Record<string, Record<string, unknown>>;
  };
  const root = lock.packages?.[""];
  for (const block of ["dependencies", "devDependencies"]) {
    const deps = root?.[block] as Record<string, string> | undefined;
    if (deps?.[RUNTIME_PACKAGE] !== undefined) deps[RUNTIME_PACKAGE] = version;
  }
  const entry = lock.packages?.[`node_modules/${RUNTIME_PACKAGE}`];
  if (entry !== undefined) {
    entry.version = version;
    entry.resolved = `file:${relative(dir, tarball).replaceAll("\\", "/")}`;
    entry.integrity = sriSha512(tarball);
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function installedRuntimeVersion(dir: string): unknown {
  return readJsonFile(join(dir, "node_modules", ...RUNTIME_PACKAGE.split("/"), "package.json"))
    ?.version;
}

function generationVersion(dir: string): unknown {
  return readJsonFile(join(dir, ".deft", "GENERATION.json"))?.runtimeVersion;
}

function readyMarker(dir: string, version: string): string {
  return join(dir, ".deft", "directive", `wiring-ready.${version}.json`);
}

interface BumpChain {
  dir: string;
  /** Snapshot after the bump (step 1), before the install. */
  afterBump: Map<string, string>;
  /** Snapshot after the project install (step 2), before any hook run. */
  afterInstall?: Map<string, string>;
}

type ChainResult = { ok: true; chain: BumpChain } | { ok: false; detail: string };

/** Step 1 work: an installed project at V, then a pin-only bump to W. Memoised. */
function bumpedFixture(ctx: FixtureContext): ChainResult {
  const cached = ctx.memo.get("bump-chain") as ChainResult | undefined;
  if (cached !== undefined) return cached;
  const result = ((): ChainResult => {
    const [ok, reason, dir] = makeInstalledFixture(ctx, "step-1-3");
    if (!ok) return { ok: false, detail: `installed fixture at V: ${reason}` };
    // A brief that must survive the bump untouched (as in HT-17).
    writeJson(join(dir, STAY_PUT_XBRIEF), {
      xBRIEFInfo: { version: "0.8", description: "pin-only bump must not touch this" },
      plan: { id: "stay-put", title: "stay", status: "proposed" },
    });
    if (generationVersion(dir) !== ctx.version || !existsSync(readyMarker(dir, ctx.version))) {
      return { ok: false, detail: `fixture at V lacks GENERATION/readiness for ${ctx.version}` };
    }
    const [wOk, wReason, wTgz] = nextRuntimeTarball(ctx);
    if (!wOk) return { ok: false, detail: `building W: ${wReason}` };
    const before = snapshotTree(dir);
    bumpRuntimePin(dir, FIXTURE_NEXT_VERSION, wTgz);
    const afterBump = snapshotTree(dir);
    const changed = changedPaths(before, afterBump);
    const expected = ["package-lock.json", "package.json"];
    if (changed.join(",") !== expected.join(",")) {
      return {
        ok: false,
        detail: `bump changed ${changed.join(", ") || "nothing"}, expected only ${expected.join(", ")}`,
      };
    }
    return { ok: true, chain: { dir, afterBump } };
  })();
  ctx.memo.set("bump-chain", result);
  return result;
}

/** Step 2 work: the plain project install, no agent and no Directive command. Memoised. */
function installedBump(ctx: FixtureContext): ChainResult {
  const cached = ctx.memo.get("install-chain") as ChainResult | undefined;
  if (cached !== undefined) return cached;
  const result = ((): ChainResult => {
    const bumped = bumpedFixture(ctx);
    if (!bumped.ok) return { ok: false, detail: `step 1: ${bumped.detail}` };
    const { dir } = bumped.chain;
    const r = ctx.spawn(ctx.npm, ["install"], {
      cwd: dir,
      env: ctx.env,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (r.status !== 0) {
      return {
        ok: false,
        detail: `npm install failed (exit ${r.status}): ${short(r.stderr || r.stdout)}`,
      };
    }
    const installed = installedRuntimeVersion(dir);
    if (installed !== FIXTURE_NEXT_VERSION) {
      return {
        ok: false,
        detail: `installed runtime is ${String(installed)}, expected ${FIXTURE_NEXT_VERSION}`,
      };
    }
    const afterInstall = snapshotTree(dir);
    // The project install may rewrite its own lockfile; nothing else changes.
    const changed = changedPaths(bumped.chain.afterBump, afterInstall).filter(
      (p) => p !== "package-lock.json",
    );
    if (changed.length > 0) {
      return {
        ok: false,
        detail: `project install changed ${changed.join(", ")} (no Directive step should run)`,
      };
    }
    return { ok: true, chain: { ...bumped.chain, afterInstall } };
  })();
  ctx.memo.set("install-chain", result);
  return result;
}

export const pinBumpStep: FixtureStep = {
  id: "1-bump",
  title: "pin-only bump of the runtime pin and lockfile",
  needsPackages: true,
  run(ctx) {
    const bumped = bumpedFixture(ctx);
    if (!bumped.ok) return { status: "fail", detail: bumped.detail };
    return {
      status: "pass",
      detail: `only package.json and package-lock.json changed (${ctx.version} -> ${FIXTURE_NEXT_VERSION})`,
    };
  },
};

export const projectInstallStep: FixtureStep = {
  id: "2-install",
  title: "project install, no agent and no Directive command",
  needsPackages: true,
  run(ctx) {
    const installed = installedBump(ctx);
    if (!installed.ok) return { status: "fail", detail: installed.detail };
    const dir = installed.chain.dir;
    if (generationVersion(dir) !== ctx.version) {
      return {
        status: "fail",
        detail: "the install alone changed GENERATION.json (no lifecycle script should run)",
      };
    }
    return {
      status: "pass",
      detail: `npm install put ${FIXTURE_NEXT_VERSION} in node_modules; wiring still describes ${ctx.version}`,
    };
  },
};

export const hookRefreshStep: FixtureStep = {
  id: "3-refresh",
  title: "first hook run refreshes the wiring",
  needsPackages: true,
  run(ctx) {
    const installed = installedBump(ctx);
    if (!installed.ok) return { status: "fail", detail: installed.detail };
    const { dir, afterInstall } = installed.chain;
    const ran = runRegisteredHook(
      dir,
      "claude",
      "tool.before",
      shellToolPayload("claude", dir),
      ctx.env,
    );
    if (!ran.ok) return { status: "fail", detail: ran.reason };
    const allowed = expectAllowed("claude", ran.run);
    if (!allowed.ok) return { status: "fail", detail: `hook did not proceed: ${allowed.detail}` };
    const failures: string[] = [];
    const gen = generationVersion(dir);
    if (gen !== FIXTURE_NEXT_VERSION) failures.push(`GENERATION.json records ${String(gen)}`);
    if (!existsSync(readyMarker(dir, FIXTURE_NEXT_VERSION)))
      failures.push("no readiness marker for W");
    if (existsSync(readyMarker(dir, ctx.version)))
      failures.push("readiness marker for V still present");
    for (const host of FIXTURE_HOSTS) {
      const found = registeredHookCommand(
        dir,
        host,
        "tool.before",
        String(shellToolPayload(host, dir).tool_name),
      );
      const outer = found.ok ? /\S+\.mjs/.exec(found.command)?.[0] : undefined;
      if (outer === undefined || !existsSync(join(dir, ...outer.split("/")))) {
        failures.push(
          `${host}: registered outer missing (${found.ok ? found.command : found.reason})`,
        );
      }
    }
    const after = snapshotTree(dir);
    for (const path of [
      "package.json",
      "package-lock.json",
      STAY_PUT_XBRIEF.replaceAll("\\", "/"),
    ]) {
      if (afterInstall?.get(path) !== after.get(path)) failures.push(`${path} changed`);
    }
    if (failures.length > 0) return { status: "fail", detail: failures.join("; ") };
    return {
      status: "pass",
      detail: `one Claude hook run proceeded and refreshed the wiring to ${FIXTURE_NEXT_VERSION}; pin, lockfile and xbrief unchanged`,
    };
  },
};

// ---------------------------------------------------------------------------
// Step 4: missing packages
// ---------------------------------------------------------------------------

/** Key phrases only (P4-U3a may reword). */
export const PROJECT_INSTALL_TEXT: TextMatchers = {
  include: [/\b(?:npm|pnpm) install\b/],
  exclude: ["npm i -g", "install --repair"],
};

function freshFixtureDir(ctx: FixtureContext, name: string): string {
  const dir = join(ctx.work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeInstalledFixture(ctx: FixtureContext, name: string): [boolean, string, string] {
  const dir = freshFixtureDir(ctx, name);
  const [ok, reason] = installPackedConsumer({
    spawn: ctx.spawn,
    which: ctx.which,
    npm: ctx.npm,
    deft: ctx.deft,
    projectDir: dir,
    repairCwd: ctx.work,
    packed: ctx.packed,
    version: ctx.version,
    packageName: `lifecycle-fixture-${name}`,
    env: ctx.env,
    prefix: PROGRESS_PREFIX,
    onProgress: ctx.log,
    installTimeoutMs: INSTALL_TIMEOUT_MS,
  });
  return [ok, reason, dir];
}

export const missingPackagesStep: FixtureStep = {
  id: "4-missing-packages",
  title: "node_modules deleted: every host blocks with the project install text",
  needsPackages: true,
  run(ctx) {
    const [ok, reason, dir] = makeInstalledFixture(ctx, "step-4");
    if (!ok) return { status: "fail", detail: `installed fixture: ${reason}` };

    ctx.log(`${PROGRESS_PREFIX}: step 4 sanity (echo hi allowed while installed)`);
    const sanity = eachHost(dir, ctx.env, FIXTURE_HOSTS, expectAllowed);
    if (!sanity.ok)
      return { status: "fail", detail: `sanity (packages installed): ${sanity.detail}` };

    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    ctx.log(`${PROGRESS_PREFIX}: step 4 node_modules deleted; expecting blocks`);
    const blocked = eachHost(dir, ctx.env, FIXTURE_HOSTS, (host, run) =>
      expectBlocked(host, run, PROJECT_INSTALL_TEXT),
    );
    if (!blocked.ok)
      return { status: "fail", detail: `after deleting node_modules: ${blocked.detail}` };
    return {
      status: "pass",
      detail:
        "echo hi allowed while installed; all 4 hosts block with the project install text once node_modules is gone",
    };
  },
};

// ---------------------------------------------------------------------------
// Step 6: old layout
// ---------------------------------------------------------------------------

/** RC-12 old-project message, key phrases only (§A6.7 / AC10.2). */
export const OLD_PROJECT_TEXT: TextMatchers = {
  include: [/older version of Directive/, /\bdirective upgrade\b/, /\b(?:npm|pnpm) install\b/],
};

const OLD_PROJECT_MARKER = "older version of Directive";

/** v0.126.2 host configs (static fixture files, never downloaded). */
export function preOvprFixtureDir(repoRoot: string): string {
  return join(
    repoRoot,
    "packages",
    "core",
    "src",
    "release-e2e",
    "fixtures",
    "pre-ovpr",
    "v0.126.2",
  );
}

/** v0.126.2 Grok wrapper bytes, from tag v0.126.2 (shared with the launcher tests). */
export function preOvprGrokWrapperPath(repoRoot: string): string {
  return join(
    repoRoot,
    "packages",
    "cli",
    "src",
    "fixtures",
    "pre-ovpr",
    "deft-pretooluse-wrapper.v0.126.2.sh",
  );
}

const PRE_OVPR_CONFIG_FILES: Readonly<Record<FixtureHost, string>> = {
  claude: "claude-settings.json",
  codex: "codex-hooks.json",
  cursor: "cursor-hooks.json",
  grok: "grok-deft.json",
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Copy the four v0.126.2 host configs and the Grok wrapper into `dir`. */
export function writePreOvprHostConfigs(repoRoot: string, dir: string): void {
  const source = preOvprFixtureDir(repoRoot);
  for (const host of FIXTURE_HOSTS) {
    const target = join(dir, ...HOST_CONFIG_PATHS[host].split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, PRE_OVPR_CONFIG_FILES[host]), target);
  }
  const wrapper = join(dir, ".grok", "hooks", "deft-pretooluse-wrapper.sh");
  copyFileSync(preOvprGrokWrapperPath(repoRoot), wrapper);
  chmodSync(wrapper, 0o755);
}

export type OldLayoutId = "6a" | "6b" | "6c" | "6d" | "6e" | "6g";

export interface OldLayoutFixture {
  id: OldLayoutId;
  title: string;
  /** Build the static fixture in `dir`. */
  build(repoRoot: string, dir: string): void;
  /** What every host must do. */
  expect: "old-project-block" | "block" | "allow";
}

function oldRootPackage(dir: string, spec: string | null): void {
  const pkg: Record<string, unknown> = {
    name: "old-layout-fixture",
    private: true,
    version: "0.0.0",
  };
  if (spec !== null) pkg.devDependencies = { "@deftai/directive": spec };
  writeJson(join(dir, "package.json"), pkg);
}

function coreVersionFile(dir: string): void {
  mkdirSync(join(dir, ".deft", "core"), { recursive: true });
  writeFileSync(join(dir, ".deft", "core", "VERSION"), "0.126.2\n", "utf8");
}

/** Marker file the stand-in project copy writes when the launcher hands off to it. */
export const LOCAL_COPY_MARKER = "local-copy-ran.log";

/**
 * A stand-in for the project's own installed pre-split `@deftai/directive`
 * (RC-12): a tiny package that depends on `@deftai/directive-core` and whose
 * `deft-hook` bin records the call and allows. Not old Directive code.
 */
function standInLocalCopy(dir: string): void {
  const pkgDir = join(dir, "node_modules", "@deftai", "directive");
  writeJson(join(pkgDir, "package.json"), {
    name: "@deftai/directive",
    version: "0.126.2",
    dependencies: { "@deftai/directive-core": "0.126.2" },
    bin: { "deft-hook": "bin/deft-hook.js", deft: "bin/deft.js" },
  });
  const script =
    "const { appendFileSync } = require('node:fs');\n" +
    "const { join } = require('node:path');\n" +
    `appendFileSync(join(process.cwd(), ${JSON.stringify(LOCAL_COPY_MARKER)}), process.argv.slice(2).join(' ') + '\\n');\n` +
    "process.exit(0);\n";
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "bin", "deft-hook.js"), script, "utf8");
  writeFileSync(join(pkgDir, "bin", "deft.js"), script, "utf8");
  writeJson(join(pkgDir, "bin", "package.json"), { type: "commonjs" });
}

export const OLD_LAYOUT_FIXTURES: readonly OldLayoutFixture[] = [
  {
    id: "6a",
    title: 'exact "0.126.2" + .deft/core/VERSION',
    expect: "old-project-block",
    build(repoRoot, dir) {
      oldRootPackage(dir, "0.126.2");
      coreVersionFile(dir);
      writePreOvprHostConfigs(repoRoot, dir);
    },
  },
  {
    id: "6b",
    title: 'range "^0.126.2" + .deft/core/VERSION',
    expect: "old-project-block",
    build(repoRoot, dir) {
      oldRootPackage(dir, "^0.126.2");
      coreVersionFile(dir);
      writePreOvprHostConfigs(repoRoot, dir);
    },
  },
  {
    // RC-12 recognises top-level evidence only, so this shape (no root
    // dependency) is not an old-style project. It must still fail closed.
    id: "6c",
    title: "no root dependency, nested tools/deft-cli + .deft/core deposit (fails closed)",
    expect: "block",
    build(repoRoot, dir) {
      oldRootPackage(dir, null);
      writeJson(join(dir, "tools", "deft-cli", "package.json"), {
        name: "deft-cli",
        private: true,
        dependencies: { "@deftai/directive": "^0.126.1" },
      });
      writeJson(join(dir, ".deft", "core", "package.json"), {
        name: "deft-core-deposit",
        deftConsumerDeposit: true,
      });
      writePreOvprHostConfigs(repoRoot, dir);
    },
  },
  {
    id: "6d",
    title: '"^0.126.2", no .deft/core, .githooks/_deft-run.sh (fresh clone)',
    expect: "old-project-block",
    build(repoRoot, dir) {
      oldRootPackage(dir, "^0.126.2");
      mkdirSync(join(dir, ".githooks"), { recursive: true });
      writeFileSync(join(dir, ".githooks", "_deft-run.sh"), "#!/usr/bin/env sh\nexit 0\n", "utf8");
      writePreOvprHostConfigs(repoRoot, dir);
    },
  },
  {
    id: "6e",
    title: "like 6b, Claude registers deft hook:dispatch",
    expect: "old-project-block",
    build(repoRoot, dir) {
      oldRootPackage(dir, "^0.126.2");
      coreVersionFile(dir);
      writePreOvprHostConfigs(repoRoot, dir);
      const claudePath = join(dir, ".claude", "settings.json");
      const text = readFileSync(claudePath, "utf8").replaceAll(
        "deft-hook --host claude",
        "deft hook:dispatch --host claude",
      );
      writeFileSync(claudePath, text, "utf8");
    },
  },
  {
    id: "6g",
    title: "like 6a, with the project's own pre-split copy installed (runs it)",
    expect: "allow",
    build(repoRoot, dir) {
      oldRootPackage(dir, "0.126.2");
      coreVersionFile(dir);
      writePreOvprHostConfigs(repoRoot, dir);
      standInLocalCopy(dir);
    },
  },
];

function judgeOldLayout(fixture: OldLayoutFixture, dir: string, env: NodeJS.ProcessEnv): Verdict {
  const verdict = eachHost(dir, env, FIXTURE_HOSTS, (host, run) => {
    if (fixture.expect === "old-project-block") return expectBlocked(host, run, OLD_PROJECT_TEXT);
    if (fixture.expect === "block") return expectBlocked(host, run);
    return expectAllowed(host, run);
  });
  if (!verdict.ok || fixture.expect !== "allow") return verdict;
  const marker = join(dir, LOCAL_COPY_MARKER);
  const calls = existsSync(marker) ? readFileSync(marker, "utf8") : "";
  const missing = FIXTURE_HOSTS.filter((h) => !calls.includes(`--host ${h} --event tool.before`));
  return missing.length === 0
    ? verdict
    : { ok: false, detail: `project copy did not run for: ${missing.join(", ")}` };
}

/**
 * 6f negative control: a new-layout installed project whose Claude config
 * still has a bare `deft-hook` entry. The launcher hands the call to the
 * pinned runtime; the old-project message must not appear.
 */
function negativeControl(ctx: FixtureContext): Verdict {
  const [ok, reason, dir] = makeInstalledFixture(ctx, "step-6f");
  if (!ok) return { ok: false, detail: `6f installed fixture: ${reason}` };
  const claudePath = join(dir, ".claude", "settings.json");
  copyFileSync(join(preOvprFixtureDir(ctx.repoRoot), PRE_OVPR_CONFIG_FILES.claude), claudePath);
  const ran = runRegisteredHook(
    dir,
    "claude",
    "tool.before",
    shellToolPayload("claude", dir),
    ctx.env,
  );
  if (!ran.ok) return { ok: false, detail: `6f: ${ran.reason}` };
  const text = `${ran.run.stdout}\n${ran.run.stderr}`;
  if (text.includes(OLD_PROJECT_MARKER)) {
    return {
      ok: false,
      detail: `6f: new-layout project got the old-project message: "${short(text)}"`,
    };
  }
  const allowed = expectAllowed("claude", ran.run);
  return allowed.ok
    ? { ok: true, detail: "6f" }
    : { ok: false, detail: `6f (bare deft-hook in a runtime-pinned project): ${allowed.detail}` };
}

export const oldLayoutStep: FixtureStep = {
  id: "6-old-layout",
  title: "old-layout projects block with the old-project message (or run their own copy)",
  needsPackages: true,
  run(ctx) {
    const failures: string[] = [];
    for (const fixture of OLD_LAYOUT_FIXTURES) {
      const dir = freshFixtureDir(ctx, `step-6${fixture.id.slice(1)}`);
      fixture.build(ctx.repoRoot, dir);
      // A real old project is a Git repo; this also stops discovery walking up.
      const git = ctx.which("git");
      if (git !== null)
        ctx.spawn(git, ["init", "-q"], { cwd: dir, env: ctx.env, timeoutMs: 30_000 });
      ctx.log(`${PROGRESS_PREFIX}: step 6 fixture ${fixture.id} (${fixture.title})`);
      const verdict = judgeOldLayout(fixture, dir, ctx.env);
      if (!verdict.ok) failures.push(`${fixture.id}: ${verdict.detail}`);
    }
    ctx.log(`${PROGRESS_PREFIX}: step 6 fixture 6f (negative control)`);
    const control = negativeControl(ctx);
    if (!control.ok) failures.push(control.detail);
    if (failures.length > 0) return { status: "fail", detail: failures.join(" | ") };
    return {
      status: "pass",
      detail: `${OLD_LAYOUT_FIXTURES.map((f) => f.id).join(",")},6f on all 4 hosts`,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry and runner
// ---------------------------------------------------------------------------

function pendingStep(id: FixtureStepId, title: string, addedBy: string): FixtureStep {
  return {
    id,
    title,
    needsPackages: false,
    run: () => ({ status: "skip", detail: `added by ${addedBy}` }),
  };
}

/** Ordered steps. Step 5 is added by a later ticket (P4-U1). */
export const FIXTURE_STEPS: readonly FixtureStep[] = [
  pinBumpStep,
  projectInstallStep,
  hookRefreshStep,
  missingPackagesStep,
  pendingStep("5-upgrade-commit", "directive upgrade + commit passes the gate", "P4-U1"),
  oldLayoutStep,
];

/** `--step 4` / `--step 4-missing-packages` → the matching step, else null. */
export function findStep(
  selector: string,
  steps: readonly FixtureStep[] = FIXTURE_STEPS,
): FixtureStep | null {
  const s = selector.trim();
  return steps.find((step) => step.id === s || step.id.split("-")[0] === s) ?? null;
}

export interface StepReport extends StepResult {
  id: FixtureStepId;
  title: string;
  durationMs: number;
}

export interface FixtureRunReport {
  ok: boolean;
  steps: StepReport[];
  setupMs: number;
  durationMs: number;
}

export interface FixtureRunOptions {
  /** Steps to run; default all. */
  steps?: readonly FixtureStep[];
  seams?: E2ESeams;
  onProgress?: (message: string) => void;
  /** Keep the temp work folder (debugging). */
  keepWork?: boolean;
}

const HOST_ENV_PREFIXES = ["DEFT_", "DIRECTIVE_", "CLAUDE", "CURSOR_", "GROK_", "CODEX_"];

/** Process env without Directive or agent-host variables, so no agent context leaks in. */
export function cleanFixtureEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (HOST_ENV_PREFIXES.some((p) => key.toUpperCase().startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}

export function formatStepLine(report: StepReport): string {
  const secs = (report.durationMs / 1000).toFixed(1);
  return `${report.status.toUpperCase().padEnd(4)} ${report.id} (${secs}s): ${report.detail}`;
}

const IS_WINDOWS = process.platform === "win32";

/** npm's global bin folder: `<prefix>/bin` on POSIX, `<prefix>` on Windows. */
export function globalBinDir(npmPrefix: string, platform = process.platform): string {
  return platform === "win32" ? npmPrefix : join(npmPrefix, "bin");
}

/** npm bin file name: `deft` on POSIX, `deft.cmd` on Windows. */
export function binFileName(name: string, platform = process.platform): string {
  return platform === "win32" ? `${name}.cmd` : name;
}

/** `env` with `dir` first on PATH, keeping the platform's PATH key and separator. */
export function prependPath(
  env: NodeJS.ProcessEnv,
  dir: string,
  platform = process.platform,
): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = platform === "win32" ? ";" : ":";
  const current = env[key] ?? "";
  return { ...env, [key]: current.length > 0 ? `${dir}${sep}${current}` : dir };
}

/** On Windows prefer the runnable `.cmd` / `.exe` that `where` lists. */
function platformWhich(name: string): string | null {
  if (!IS_WINDOWS) return defaultWhich(name);
  const result = spawnSync("where", [name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const lines = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /\.(?:cmd|exe|bat)$/i.test(l)) ?? lines[0] ?? null;
}

/** Windows cannot spawn a `.cmd` without a shell; elsewhere this is `spawnText`. */
const platformSpawnText: SpawnTextFn = (cmd, args, options = {}) => {
  if (!(IS_WINDOWS && /\.(?:cmd|bat)$/i.test(cmd))) return spawnText(cmd, args, options);
  const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a);
  const result = spawnSync([cmd, ...args].map(quote).join(" "), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 128,
    stdout: result.stdout ?? "",
    stderr: result.stderr || (result.error?.message ?? ""),
  };
};

/**
 * Run the selected steps in order. Packing and the global install happen
 * once, and only when a selected step needs them.
 */
export function runLifecycleFixture(
  repoRoot: string,
  options: FixtureRunOptions = {},
): FixtureRunReport {
  const started = Date.now();
  const steps = options.steps ?? FIXTURE_STEPS;
  const seams = options.seams ?? {};
  const log = options.onProgress ?? (() => {});
  const spawn = seams.spawnText ?? platformSpawnText;
  const which = seams.which ?? platformWhich;
  const reports: StepReport[] = [];
  const record = (step: FixtureStep, result: StepResult, ms: number) =>
    reports.push({ id: step.id, title: step.title, durationMs: ms, ...result });

  const needsPackages = steps.some((s) => s.needsPackages);
  let ctx: FixtureContext | null = null;
  let setupFailure: string | null = null;
  let setupMs = 0;
  let work: string | null = null;
  const manifestBackup = needsPackages ? backupPackageManifests(repoRoot) : new Map();

  try {
    if (needsPackages) {
      const setupStarted = Date.now();
      const npm = which("npm");
      if (npm === null) {
        setupFailure = "npm not on PATH";
      } else {
        work = mkdtempSync(join(tmpdir(), "deft-lifecycle-fixture-"));
        const packDir = join(work, "packs");
        const npmPrefix = join(work, "npm-prefix");
        mkdirSync(packDir, { recursive: true });
        const clean = cleanFixtureEnv();
        const envBase: NodeJS.ProcessEnv = { ...clean, npm_config_prefix: npmPrefix };
        const [ok, reason, packed] = packAndInstallGlobally({
          repoRoot,
          version: FIXTURE_VERSION,
          packDir,
          npm,
          env: envBase,
          seams,
          spawn,
          which,
          prefix: PROGRESS_PREFIX,
          onProgress: log,
          installTimeoutMs: INSTALL_TIMEOUT_MS,
        });
        const bin = globalBinDir(npmPrefix);
        const deft = join(bin, binFileName("deft"));
        const deftHook = join(bin, binFileName("deft-hook"));
        if (!ok) {
          setupFailure = reason;
        } else if (!existsSync(deft) || !existsSync(deftHook)) {
          setupFailure = `packed launcher bins missing under ${bin}`;
        } else {
          ctx = {
            repoRoot,
            work,
            packDir,
            npmPrefix,
            env: prependPath(envBase, bin),
            npm,
            deft,
            deftHook,
            packed,
            version: FIXTURE_VERSION,
            seams,
            spawn,
            which,
            log,
            memo: new Map(),
          };
        }
      }
      setupMs = Date.now() - setupStarted;
      log(`${PROGRESS_PREFIX}: setup ${setupFailure === null ? "OK" : "FAILED"} (${setupMs}ms)`);
    }

    for (const step of steps) {
      const stepStarted = Date.now();
      if (!step.needsPackages) {
        record(step, step.run(ctx as FixtureContext), Date.now() - stepStarted);
        continue;
      }
      if (ctx === null) {
        record(step, { status: "fail", detail: `setup failed: ${setupFailure}` }, 0);
        continue;
      }
      let result: StepResult;
      try {
        result = step.run(ctx);
      } catch (exc) {
        result = {
          status: "fail",
          detail: `threw: ${exc instanceof Error ? exc.message : String(exc)}`,
        };
      }
      record(step, result, Date.now() - stepStarted);
    }
  } finally {
    restorePackageManifests(manifestBackup);
    if (work !== null && options.keepWork !== true) {
      rmSync(work, { recursive: true, force: true });
    }
  }

  return {
    ok: reports.every((r) => r.status !== "fail"),
    steps: reports,
    setupMs,
    durationMs: Date.now() - started,
  };
}
