/**
 * Every kill-switch reader applies one record contract (#6740): the core
 * detector (dispatcher, session:start, SessionStart hook, doctor), the runtime
 * hook dispatch, the launcher entry guard, the deposited outer hook, the
 * git-hook helper (sh, no node) and the Taskfile entry reader. They run the
 * shared fixture cases and must agree. A bare flag turns nothing off on any of
 * them and each hook event, doctor run and session:start prints one warning.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isDisableFlagActive as launcherReader } from "../../../cli/src/entry-guard.js";
import { run as hookDispatchRun } from "../../../runtime/src/hook-dispatch.js";
import { DIRECTIVE_GIT_HOOK_BODIES } from "../../../runtime/src/setup-wiring.js";
import { cmdDoctor } from "../doctor/main.js";
import { hostHookOuterSource } from "../init-deposit/host-hook-outer.js";
import type { CheapInSyncResult } from "../install-health/types.js";
import {
  detectDeftDirectiveDisable,
  resolveAbsoluteGitDir,
} from "../policy/deft-directive-disable.js";
import {
  KILL_SWITCH_BARE_FLAG_NAME,
  KILL_SWITCH_BARE_FLAG_WARNING,
  killSwitchRecordPath,
  writeKillSwitchRecord,
} from "../policy/kill-switch-record.js";
import { NO_DEFT_DIRECTIVE_FLAG_NAME } from "../policy/no-deft-directive.js";
import { runSessionStart } from "../session/session-start.js";
import { runSessionStartHookWrite } from "../session/session-start-hook.js";
import { decideHook } from "./dispatcher.js";

interface KillCase {
  readonly name: string;
  readonly kind: "file" | "symlink" | "dir";
  readonly eol: "lf" | "crlf";
  readonly finalNewline?: boolean;
  readonly lines: readonly string[];
  readonly valid: boolean;
}

const REPO = process.cwd();
const CASES = (
  JSON.parse(
    readFileSync(
      join(REPO, "packages/core/src/policy/fixtures/kill-switch-record-cases.json"),
      "utf8",
    ),
  ) as { cases: KillCase[] }
).cases;
const engineInvoke = createRequire(import.meta.url)(join(REPO, "tasks", "engine-invoke.cjs")) as {
  killRecordVerdict: (root: string) => string;
};
// The deposited git-hook helper body, not this repository's own copy: the
// repository applies its deposit with the next pin (#6740).
const HELPER_DIR = mkdtempSync(join(tmpdir(), "w6740c1-readers-helper-"));
const HELPER = join(HELPER_DIR, "_directive-run.sh");
writeFileSync(HELPER, DIRECTIVE_GIT_HOOK_BODIES[".githooks/_directive-run.sh"] ?? "");
afterAll(() => {
  rmSync(HELPER_DIR, { recursive: true, force: true });
});
const WARNING_PREFIX = "Directive warning:";

function findSh(): string | null {
  if (process.platform !== "win32") return existsSync("/bin/sh") ? "/bin/sh" : null;
  for (const c of [
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    "C:\\Program Files\\Git\\bin\\sh.exe",
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}
const SH = findSh();

function gitRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  return root;
}

function gitDirOf(root: string): string {
  const dir = resolveAbsoluteGitDir(root);
  if (dir === null) throw new Error(`no git dir for ${root}`);
  return dir;
}

function materialize(root: string, c: KillCase, gitDir: string, otherGitDir: string): boolean {
  const rec = killSwitchRecordPath(root);
  mkdirSync(dirname(rec), { recursive: true });
  rmSync(rec, { recursive: true, force: true });
  const eol = c.eol === "crlf" ? "\r\n" : "\n";
  const lines = c.lines.map((l) =>
    l.replaceAll("{gitDir}", gitDir).replaceAll("{otherGitDir}", otherGitDir),
  );
  const body = lines.length === 0 ? "" : lines.join(eol) + (c.finalNewline === false ? "" : eol);
  if (c.kind === "dir") {
    mkdirSync(rec);
    return true;
  }
  if (c.kind === "symlink") {
    const target = join(dirname(rec), "link-target.txt");
    writeFileSync(target, body);
    try {
      symlinkSync(target, rec, "file");
    } catch {
      return false;
    }
    return true;
  }
  writeFileSync(rec, body);
  return true;
}

const CHEAP_FAIL: CheapInSyncResult = {
  ok: false,
  pinVersion: "9.9.9",
  installedVersion: "9.9.8",
  identityMatch: false,
  readinessValid: false,
  failClosed: true,
  allowSetup: false,
  recoveryGuidance: null,
};

/** Runtime hook dispatch: stood down when it skips the install checks. */
function runtimeReader(root: string): { stoodDown: boolean; warnings: number } {
  let cheapCalled = false;
  const err: string[] = [];
  hookDispatchRun(["--host", "claude", "--event", "tool.before", "--kill-switch-reader", "v1"], {
    readStdin: () =>
      JSON.stringify({
        cwd: root,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: join(root, "README.md") },
      }),
    stdinEmptyRetryMs: 0,
    launchingCheckoutRoot: () => null,
    cheapInSync: () => {
      cheapCalled = true;
      return CHEAP_FAIL;
    },
    writeOut: () => undefined,
    writeErr: (t) => err.push(t),
  });
  const warnings = err
    .join("")
    .split("\n")
    .filter((l) => l.startsWith(WARNING_PREFIX)).length;
  return { stoodDown: !cheapCalled, warnings };
}

/** Deposited outer hook with no node_modules: exit 0 only when it stands down. */
function outerReader(root: string): { stoodDown: boolean; warnings: number } {
  const r = spawnSync(
    process.execPath,
    [join(root, ".claude", "deft-hook-test.mjs"), "--host", "claude", "--event", "tool.before"],
    { input: "{}", encoding: "utf8", cwd: root },
  );
  const warnings = String(r.stderr)
    .split("\n")
    .filter((l) => l.startsWith(WARNING_PREFIX)).length;
  return { stoodDown: r.status === 0, warnings };
}

/** Git-hook helper with only git, grep, tr and sh on PATH (no node). */
function helperReader(root: string, pathEnv: string): { stoodDown: boolean; warnings: number } {
  const script = `. "$HELPER_PATH"\nif run_directive probe; then echo STOOD_DOWN; fi\n`;
  const env: NodeJS.ProcessEnv = { REPO_ROOT: root, HELPER_PATH: HELPER, PATH: pathEnv };
  if (process.platform === "win32") env.SYSTEMROOT = process.env.SYSTEMROOT;
  const r = spawnSync(SH as string, ["-c", script], { env, encoding: "utf8" });
  const warnings = String(r.stderr)
    .split("\n")
    .filter((l) => l.startsWith(WARNING_PREFIX)).length;
  return { stoodDown: String(r.stdout).includes("STOOD_DOWN"), warnings };
}

/** PATH holding git, grep, tr and sh but not node. */
function noNodePath(): string {
  if (process.platform === "win32") {
    return ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\usr\\bin"].join(";");
  }
  const bin = mkdtempSync(join(tmpdir(), "w6740c1-bin-"));
  for (const tool of ["git", "grep", "tr"]) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    symlinkSync(found, join(bin, tool));
  }
  return bin;
}

describe("every reader applies the shared kill record cases (#6740)", () => {
  let root = "";
  let other = "";
  let gitDir = "";
  let otherGitDir = "";
  let pathEnv = "";
  beforeAll(() => {
    root = gitRepo("w6740c1-readers-");
    other = gitRepo("w6740c1-readers-other-");
    gitDir = gitDirOf(root);
    otherGitDir = gitDirOf(other);
    writeFileSync(join(root, "package.json"), "{}\n");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "deft-hook-test.mjs"), hostHookOuterSource());
    writeFileSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), "1\n");
    if (SH !== null) {
      pathEnv = noNodePath();
      // The git-hook helper must reach its verdict with no node on PATH.
      const env: NodeJS.ProcessEnv = { PATH: pathEnv };
      if (process.platform === "win32") env.SYSTEMROOT = process.env.SYSTEMROOT;
      const probe = spawnSync(SH, ["-c", "command -v node"], { env, encoding: "utf8" });
      expect(probe.status).not.toBe(0);
    }
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it.for(CASES.map((c) => [c.name, c] as const))("%s", ([, c], ctx) => {
    if (!materialize(root, c, gitDir, otherGitDir)) {
      ctx.skip();
      return;
    }
    const expectedWarnings = c.valid ? 0 : 1;
    expect(detectDeftDirectiveDisable(root).active, "core").toBe(c.valid);
    expect(launcherReader(root), "launcher").toBe(c.valid);
    expect(engineInvoke.killRecordVerdict(root) === "valid", "taskfile").toBe(c.valid);
    const runtime = runtimeReader(root);
    expect(runtime.stoodDown, "runtime").toBe(c.valid);
    expect(runtime.warnings, "runtime warnings").toBe(expectedWarnings);
    const outer = outerReader(root);
    expect(outer.stoodDown, "outer").toBe(c.valid);
    expect(outer.warnings, "outer warnings").toBe(expectedWarnings);
    if (SH !== null) {
      const helper = helperReader(root, pathEnv);
      expect(helper.stoodDown, "git-hook helper").toBe(c.valid);
      expect(helper.warnings, "git-hook helper warnings").toBe(expectedWarnings);
    }
  });
});

describe("a bare flag turns nothing off (#6740)", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  function flagged(): string {
    const root = gitRepo("w6740c1-bare-");
    roots.push(root);
    writeFileSync(join(root, KILL_SWITCH_BARE_FLAG_NAME), "1\n");
    return root;
  }
  const noopCompact = {
    markCompactStale: () => ({ changed: false, statePath: "", message: "noop" }),
  };

  it("dispatcher keeps enforcing; a valid record stands it down", () => {
    const root = flagged();
    const input = {
      host: "claude" as const,
      event: "session.compact" as const,
      projectRoot: root,
      payload: {},
    };
    expect(decideHook(input, noopCompact).code).not.toBe("directive-disabled");
    writeKillSwitchRecord(root, {
      gitDir: gitDirOf(root),
      mintedAt: "t",
      mintedVia: "kill-switch:on",
    });
    expect(decideHook(input, noopCompact).code).toBe("directive-disabled");
  });

  it("SessionStart hook keeps its bookkeeping; a valid record skips it", () => {
    const root = flagged();
    expect(runSessionStartHookWrite(root).stdout).not.toContain("DISABLED");
    writeKillSwitchRecord(root, {
      gitDir: gitDirOf(root),
      mintedAt: "t",
      mintedVia: "kill-switch:on",
    });
    expect(runSessionStartHookWrite(root).stdout).toContain("DISABLED");
  });

  it("session:start prints the warning once and does not stand down on the flag", () => {
    const root = flagged();
    // The opt-out flag short-circuits the ritual cheaply; the kill flag must not.
    writeFileSync(join(root, NO_DEFT_DIRECTIVE_FLAG_NAME), "", "utf8");
    const result = runSessionStart(root, { writeHistory: false });
    expect(result.payload.kill_switch).toBeUndefined();
    expect(result.payload.kill_switch_warning).toBe(KILL_SWITCH_BARE_FLAG_WARNING);
    expect(result.lines.filter((l) => l === KILL_SWITCH_BARE_FLAG_WARNING)).toHaveLength(1);
  });

  it("session:start shows mintedVia and mintedAt of a valid record", () => {
    const root = flagged();
    writeKillSwitchRecord(root, {
      gitDir: gitDirOf(root),
      mintedAt: "2026-11-22T10:00:00Z",
      mintedVia: "kill-switch:on",
    });
    const result = runSessionStart(root, { writeHistory: false });
    expect(result.payload.disabled).toBe(true);
    expect(result.lines.join("\n")).toContain("mintedVia=kill-switch:on");
    expect(result.lines.join("\n")).toContain("mintedAt=2026-11-22T10:00:00Z");
  });

  it("doctor reports one kill-switch warning and keeps checking", () => {
    const root = flagged();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    cmdDoctor(["--project-root", root, "--json"]);
    const payload = JSON.parse(out.join("")) as { findings: { check?: string; message: string }[] };
    const kill = payload.findings.filter((f) => f.check === "kill-switch");
    expect(kill).toHaveLength(1);
    expect(kill[0]?.message).toBe(KILL_SWITCH_BARE_FLAG_WARNING);
  });

  it("doctor shows mintedVia and mintedAt of a valid record", () => {
    const root = flagged();
    writeKillSwitchRecord(root, {
      gitDir: gitDirOf(root),
      mintedAt: "2026-11-22T10:00:00Z",
      mintedVia: "kill-switch:on",
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
      out.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    expect(cmdDoctor(["--project-root", root, "--json"])).toBe(0);
    const payload = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(payload.disabled).toBe(true);
    expect(payload.kill_record).toEqual({
      minted_at: "2026-11-22T10:00:00Z",
      minted_via: "kill-switch:on",
    });
  });
});
