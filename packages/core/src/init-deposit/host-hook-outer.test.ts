import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGY_DIRECTIVE_HOOK_NAME } from "../hooks/classify/agy-hook-order.js";
import { KILL_SWITCH_BARE_FLAG_WARNING } from "../policy/kill-switch-record.js";
import {
  agyEntryCommands,
  HOST_HOOK_MISSING_PIN_INSTALL_EXCEPTION,
  HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE,
  HOST_HOOK_NONDECISION_REASON,
  hostHookOuterCommand,
  hostHookOuterFileName,
  hostHookOuterRelPath,
  hostHookOuterSha8,
  hostHookOuterSource,
  isHostHookOuterCommand,
  isManagedAgyHookEntry,
  stripAgyHostHookConfig,
  stripHostHookRegistrationInPlace,
} from "./host-hook-outer.js";

type Host = "grok" | "claude" | "cursor" | "codex" | "agy";

/** The four hosts whose payloads share the Claude-style shape; agy has its own tests. */
const HOSTS: Host[] = ["grok", "claude", "cursor", "codex"];

/** The outer's missing-runtime text in a project with no lockfile (#6620). */
const MISSING_NO_LOCKFILE = HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE.replace(
  "{install}",
  "`npm install` (or `pnpm install --frozen-lockfile`)",
);

function gitInit(root: string): void {
  const r = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  expect(r.status).toBe(0);
}

/** Fake pin hook-bin.js with the given body (the fake-runtime harness). */
function writeRuntime(root: string, body: string): void {
  mkdirSync(join(root, "node_modules", "@deftai", "directive-runtime", "dist"), {
    recursive: true,
  });
  writeFileSync(join(root, "node_modules/@deftai/directive-runtime/dist/hook-bin.js"), body);
}

/** A kill record bound to this checkout's git dir (#6740). */
function writeValidKillRecord(root: string): void {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" });
  const gitDir = String(r.stdout).replace(/\n+$/, "");
  mkdirSync(join(root, ".deft", "authz"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "authz", "kill-switch.disable"),
    `schema=deft.kill-switch.v1\ngitDir=${gitDir}\nmintedVia=kill-switch:on\n`,
  );
}

function writeDenyRuntime(root: string): void {
  writeRuntime(root, 'process.stderr.write("DENY_RUNTIME_REACHED\\n"); process.exit(2);\n');
}

function writeFakeGit(binDir: string, kind: "fail" | "tracked" | "untracked"): void {
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, process.platform === "win32" ? "git.cmd" : "git");
  if (process.platform === "win32") {
    if (kind === "fail") {
      writeFileSync(script, "@echo off\r\nexit /b 1\r\n");
    } else if (kind === "tracked") {
      writeFileSync(script, "@echo off\r\necho .deft-directive-disable\r\nexit /b 0\r\n");
    } else {
      writeFileSync(script, "@echo off\r\nexit /b 0\r\n");
    }
  } else {
    if (kind === "fail") {
      writeFileSync(script, "#!/bin/sh\nexit 1\n");
    } else if (kind === "tracked") {
      writeFileSync(script, "#!/bin/sh\necho .deft-directive-disable\nexit 0\n");
    } else {
      writeFileSync(script, "#!/bin/sh\nexit 0\n");
    }
    chmodSync(script, 0o755);
  }
}

function runOuter(
  root: string,
  host: Host,
  envExtra: NodeJS.ProcessEnv = {},
  event = "tool.before",
  nodeArgs: readonly string[] = [],
  stdin?: string,
): ReturnType<typeof spawnSync> {
  const sha8 = hostHookOuterSha8();
  const abs = join(root, hostHookOuterRelPath(host, sha8));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, hostHookOuterSource());
  return spawnSync(process.execPath, [...nodeArgs, abs, "--host", host, "--event", event], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...envExtra },
    maxBuffer: 64 * 1024 * 1024,
    input: stdin,
  });
}

type ReasonKind = "missing-pin" | "nondecision";

function expectReason(text: string, kind: ReasonKind): void {
  if (kind === "missing-pin") {
    expect(text).toContain(MISSING_NO_LOCKFILE);
    expect(text).not.toContain(HOST_HOOK_NONDECISION_REASON);
    expect(text).not.toContain("npm i -g");
    expect(text).not.toContain("install --repair");
  } else {
    expect(text).toContain(HOST_HOOK_NONDECISION_REASON);
    expect(text).not.toContain(MISSING_NO_LOCKFILE);
  }
}

/**
 * #6201 per-host block table for `tool.before`. Whole stdout is parsed, so a
 * second decision or any stray text fails the assertion.
 */
function expectToolBlocked(r: ReturnType<typeof spawnSync>, host: Host, kind: ReasonKind): void {
  const stdout = String(r.stdout ?? "");
  const stderr = String(r.stderr ?? "");
  if (host === "grok") {
    expect(r.status).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["decision", "reason"]);
    expect(parsed.decision).toBe("deny");
    expectReason(String(parsed.reason), kind);
  } else if (host === "cursor") {
    expect(r.status).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["agent_message", "permission", "user_message"]);
    expect(parsed.permission).toBe("deny");
    expectReason(String(parsed.user_message), kind);
    expect(parsed.agent_message).toBe(parsed.user_message);
  } else {
    expect(r.status).toBe(2);
    expect(stdout).toBe("");
    expectReason(stderr, kind);
  }
}

/** Missing pin on tool.before (kept name for the #6122 conformance tests). */
function expectHostFailClosed(r: ReturnType<typeof spawnSync>, host: Host): void {
  expectToolBlocked(r, host, "missing-pin");
}

/** Pin present but exits 2: a non-decision, blocked on every host. */
function expectHostDenyRuntime(r: ReturnType<typeof spawnSync>, host: Host): void {
  expectToolBlocked(r, host, "nondecision");
}

describe("host-hook-outer (#5994)", () => {
  it("hashes to stable sha8 and builds per-host paths", () => {
    const source = hostHookOuterSource();
    const sha8 = hostHookOuterSha8(source);
    expect(sha8).toMatch(/^[a-f0-9]{8}$/);
    expect(hostHookOuterRelPath("grok", sha8)).toBe(`.grok/hooks/deft-hook-${sha8}.mjs`);
    expect(hostHookOuterCommand("cursor", sha8)).toBe(`node .cursor/hooks/deft-hook-${sha8}.mjs`);
    expect(isHostHookOuterCommand(hostHookOuterCommand("claude", sha8))).toBe(true);
    expect(
      isHostHookOuterCommand("node node_modules/@deftai/directive-runtime/dist/hook-bin.js"),
    ).toBe(false);
  });

  it("F1 (#6740): a valid kill record quiet-allows without pin present", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-disable-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeValidKillRecord(root);
      const r = runOuter(root, "grok");
      expect(r.status).toBe(0);
      expect(r.stdout ?? "").toBe("");
      expect(r.stderr ?? "").toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("F1 (#6740): a bare untracked flag does not quiet-allow and prints one warning", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-bareflag-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      const r = runOuter(root, "claude");
      expectHostFailClosed(r, "claude");
      const warnings = String(r.stderr)
        .split("\n")
        .filter((l) => l === KILL_SWITCH_BARE_FLAG_WARNING);
      expect(warnings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes --kill-switch-reader v1 to the runtime hook binary (#6740)", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-reader-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeRuntime(root, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      const r = runOuter(root, "claude");
      expect(r.status).toBe(0);
      expect(JSON.parse(String(r.stdout))).toEqual([
        "--host",
        "claude",
        "--event",
        "tool.before",
        "--kill-switch-reader",
        "v1",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an older runtime that refuses the reader flag fails closed as a hook failure (#6740)", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-oldrt-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeRuntime(
        root,
        'if (process.argv.includes("--kill-switch-reader")) { process.stderr.write("unrecognized argument: --kill-switch-reader\\n"); process.exit(2); }\n',
      );
      for (const host of HOSTS) expectHostDenyRuntime(runOuter(root, host), host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("F1: missing pin fail-closed with project PM guidance (not AC9.7)", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-misspin-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      const r = runOuter(root, "grok");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(MISSING_NO_LOCKFILE);
      expect(r.stdout).not.toContain("npm i -g @deftai/directive");
      expect(r.stdout).not.toContain("directive install --repair");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("source mentions pin hook-bin and the kill record contract (#6740)", () => {
    const source = hostHookOuterSource();
    expect(source).toContain("node_modules/@deftai/directive-runtime/dist/hook-bin.js");
    expect(source).toContain(".deft-directive-disable");
    expect(source).toContain(".deft/authz/kill-switch.disable");
    expect(source).toContain("schema=deft.kill-switch.v1");
    expect(source).toContain("--absolute-git-dir");
    expect(source).toContain('"--kill-switch-reader"');
    expect(source).toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
    expect(source).toContain(HOST_HOOK_NONDECISION_REASON);
    expect(source).toContain("isRegularFile");
    expect(source).toContain("killRecordVerdict");
    expect(source).not.toContain("gitTrackListing");
    expect(source).not.toContain("ls-files");
    expect(source).not.toContain("error-unmatch");
  });

  it("uses Node built-ins only and one failure exit (AC9.1 / #6201)", () => {
    const source = hostHookOuterSource();
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^node:/);
    expect(source).toContain("function blockToolCall(host, event, reason)");
    expect(source).toMatch(/if \(child\.error\)/);
    expect(source).toMatch(/if \(child\.status === null\)/);
    expect(source).not.toContain('stdio: "inherit"');
    expect(source).not.toContain("failClosedUnusablePin");
  });

  it("F1: unusable pin (non-zero child) emits Grok deny JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-unusable-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeDenyRuntime(root);
      const r = runOuter(root, "grok");
      expectToolBlocked(r, "grok", "nondecision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host-hook-outer eligibility conformance (#6122)", () => {
  it.each(HOSTS)("%s: tracked flag reaches deny runtime (not quietAllow)", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-tracked-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      const add = spawnSync("git", ["add", "-f", ".deft-directive-disable"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(add.status).toBe(0);
      writeDenyRuntime(root);
      const r = runOuter(root, host);
      expectHostDenyRuntime(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: absent flag with deny runtime reaches refusal", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-absent-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeDenyRuntime(root);
      const r = runOuter(root, host);
      expectHostDenyRuntime(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: directory-named flag is ineligible; deny runtime reached", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-dirflag-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      mkdirSync(join(root, ".deft-directive-disable"));
      writeDenyRuntime(root);
      const r = runOuter(root, host);
      expectHostDenyRuntime(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: indeterminate git probe does not quietAllow (no pin)", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-indet-${host}-`));
    const bin = join(root, ".bin");
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      writeFakeGit(bin, "fail");
      const r = runOuter(root, host, {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      });
      expectHostFailClosed(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: indeterminate git probe with deny runtime keeps refusal", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-indet-rt-${host}-`));
    const bin = join(root, ".bin");
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      writeFakeGit(bin, "fail");
      writeDenyRuntime(root);
      const r = runOuter(root, host, {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      });
      expectHostDenyRuntime(r, host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: a valid kill record quietAllows without pin (#6740)", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-eligible-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeValidKillRecord(root);
      const r = runOuter(root, host);
      expect(r.status).toBe(0);
      expect(r.stdout ?? "").toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(HOSTS)("%s: a bare untracked flag fails closed without pin (#6740)", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-bare-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      expectHostFailClosed(runOuter(root, host), host);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("symlink flag does not quietAllow (lstat regular-file parity)", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-symlink-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, "target.txt"), "x\n");
      try {
        symlinkSync(join(root, "target.txt"), join(root, ".deft-directive-disable"));
      } catch {
        return;
      }
      const r = runOuter(root, "grok");
      expectHostFailClosed(r, "grok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host-hook-outer prompt.submit never blocks a prompt (#7420)", () => {
  it.each(HOSTS)("%s: a missing pin exits 0 with empty stdout", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-7420-prompt-${host}-`));
    try {
      gitInit(root);
      const r = runOuter(root, host, {}, "prompt.submit", [], "{}");
      expect(r.status).toBe(0);
      expect(String(r.stdout ?? "")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host-hook-outer bytes stay put (#6613)", () => {
  it("pins the deposited outer sha8 so byte changes are deliberate", () => {
    // The outer `.mjs` bytes must not churn consumer hook paths; outer-byte
    // changes belong to their own issues. #6201 changed the bytes on purpose
    // (block the tool call when the hook cannot decide): a598056e -> 8edf26e9.
    // #6620 changed them on purpose (shared message table, install named by
    // lockfile): 8edf26e9 -> 8149fb11.
    // #6740 changed them on purpose (kill record instead of the bare flag,
    // `--kill-switch-reader v1` passed to hook-bin): 8149fb11 -> 665df6a9.
    // #7275 changed them on purpose (missing-runtime admits the named project
    // install; refusal names that exception): 665df6a9 -> bc294904.
    // #7378 changed them on purpose (agy: explicit allow, one-decision check,
    // per-call hook-order check over workspace, plugin and user-scope hook files):
    // bc294904 -> eb73f41c.
    // #7347 changed them on purpose (agy missing-runtime install admit reads the
    // real `run_command` / `toolCall.args.CommandLine` payload): eb73f41c -> aee61ba9.
    // #7420 changed them on purpose (prompt.submit never blocks a prompt: a
    // missing pin allows quietly): aee61ba9 -> 869d8615.
    expect(hostHookOuterSha8()).toBe("869d8615");
  });
});

describe("host-hook-outer names the project install from the lockfile (#6620)", () => {
  it.each([
    ["pnpm-lock.yaml", "`pnpm install --frozen-lockfile`"],
    ["package-lock.json", "`npm install`"],
  ])("with %s, the missing-runtime block names %s and the install exception", (lockfile, command) => {
    const root = mkdtempSync(join(tmpdir(), "outer-6620-lock-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, lockfile), "");
      const r = runOuter(root, "claude");
      expect(r.status).toBe(2);
      const stderr = String(r.stderr);
      expect(stderr).toContain(
        `Directive can't run: @deftai/directive-runtime is not installed in this project. Run ${command} in a terminal in this project.`,
      );
      expect(stderr).toContain(
        "The exact project install named above is allowed through a shell tool at the project root",
      );
      expect(stderr).not.toContain("Agent tool calls stay blocked until a person runs it.");
      expect(stderr).not.toMatch(/yarn|npm i -g|install --repair/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names no Yarn and no global install anywhere in the outer source", () => {
    const source = hostHookOuterSource();
    expect(source).not.toContain("(or yarn)");
    expect(source).not.toContain("npm i -g @deftai/directive, then");
  });
});

describe("host-hook-outer blocks the tool call when it cannot decide (#6201 / #6166)", () => {
  const ALLOW_THEN_EXIT_2 =
    'process.stdout.write(JSON.stringify({ decision: "allow" }) + "\\n"); process.exit(2);\n';

  function project(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    writeFileSync(join(root, "package.json"), "{}\n");
    return root;
  }

  function withProject(prefix: string, fn: (root: string) => void): void {
    const root = project(prefix);
    try {
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it.each(HOSTS)("%s tool.before: missing pin blocks with the missing-pin text", (host) => {
    withProject(`outer-6201-miss-${host}-`, (root) => {
      expectToolBlocked(runOuter(root, host), host, "missing-pin");
    });
  });

  it.each(HOSTS)("%s tool.before: spawn error blocks with the non-decision text", (host) => {
    withProject(`outer-6201-spawn-${host}-`, (root) => {
      writeRuntime(root, 'process.stdout.write("{}");\n');
      // Point the outer's process.execPath at a file that does not exist so
      // spawnSync sets child.error (ENOENT).
      const preload = join(root, "preload.cjs");
      writeFileSync(preload, `process.execPath = ${JSON.stringify(join(root, "no-such-node"))};\n`);
      const r = runOuter(root, host, {}, "tool.before", ["--require", preload]);
      expectToolBlocked(r, host, "nondecision");
      const reason = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(reason).toContain("failed to run pin hook-bin");
    });
  });

  it.skipIf(process.platform === "win32").each(HOSTS)(
    "%s tool.before: child killed by a signal blocks",
    (host) => {
      withProject(`outer-6201-signal-${host}-`, (root) => {
        writeRuntime(
          root,
          'process.stdout.write(JSON.stringify({ decision: "allow" })); process.kill(process.pid, "SIGKILL");\n',
        );
        const r = runOuter(root, host);
        expectToolBlocked(r, host, "nondecision");
        expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("SIGKILL");
      });
    },
  );

  it.each(HOSTS)("%s tool.before: allow then exit 2 blocks and drops the allow", (host) => {
    withProject(`outer-6201-allow2-${host}-`, (root) => {
      writeRuntime(root, ALLOW_THEN_EXIT_2);
      const r = runOuter(root, host);
      expectToolBlocked(r, host, "nondecision");
      expect(String(r.stdout ?? "")).not.toContain('"allow"');
    });
  });

  it.each(HOSTS)("%s tool.before: exit 1 with no output blocks", (host) => {
    withProject(`outer-6201-exit1-${host}-`, (root) => {
      writeRuntime(root, "process.exit(1);\n");
      expectToolBlocked(runOuter(root, host), host, "nondecision");
    });
  });

  it.each(HOSTS)("%s tool.before: stdout over the capture limit blocks", (host) => {
    withProject(`outer-6201-big-${host}-`, (root) => {
      writeRuntime(
        root,
        'const s = "x".repeat(17 * 1024 * 1024); require("node:fs").writeSync(1, s); process.exit(0);\n',
      );
      const r = runOuter(root, host);
      expectToolBlocked(r, host, "nondecision");
    });
  });

  it("missing --host on tool.before blocks with exit 2", () => {
    withProject("outer-6201-nohost-", (root) => {
      const sha8 = hostHookOuterSha8();
      const abs = join(root, hostHookOuterRelPath("claude", sha8));
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, hostHookOuterSource());
      const r = spawnSync(process.execPath, [abs, "--event", "tool.before"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expectReason(r.stderr ?? "", "missing-pin");
    });
  });

  it.each([
    "session.start",
    "session.compact",
    "session.end",
  ])("non-tool event %s keeps exit 1 on Claude/Codex/Cursor (D-018)", (event) => {
    withProject("outer-6201-event-", (root) => {
      for (const host of ["claude", "codex", "cursor"] as const) {
        const r = runOuter(root, host, {}, event);
        expect(r.status).toBe(1);
        expect(r.stdout).toBe("");
        expectReason(r.stderr ?? "", "missing-pin");
      }
      const failed = runOuter(root, "claude", {}, event);
      expect(failed.status).not.toBe(2);
    });
  });

  it.each([
    "session.start",
    "session.compact",
  ])("non-tool event %s on Grok stays one deny JSON on exit 0", (event) => {
    withProject("outer-6201-grok-event-", (root) => {
      const r = runOuter(root, "grok", {}, event);
      expect(r.status).toBe(0);
      expect(JSON.parse(String(r.stdout))).toEqual({
        decision: "deny",
        reason: MISSING_NO_LOCKFILE,
      });
    });
  });

  it("non-tool event with a crashing pin exits 1 with the non-decision text", () => {
    withProject("outer-6201-event-crash-", (root) => {
      writeRuntime(root, "process.exit(1);\n");
      for (const host of ["claude", "codex", "cursor"] as const) {
        const r = runOuter(root, host, {}, "session.compact");
        expect(r.status).toBe(1);
        expect(r.stdout).toBe("");
        expectReason(r.stderr ?? "", "nondecision");
      }
    });
  });

  describe("Grok exit 0 output check (#6166)", () => {
    function grokWith(stdout: string): ReturnType<typeof spawnSync> {
      const root = project("outer-6166-");
      try {
        writeRuntime(root, `process.stdout.write(${JSON.stringify(stdout)});\n`);
        return runOuter(root, "grok");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it.each(["", "   \n\t\n"])("whitespace-only %j stays an empty allow", (stdout) => {
      const r = grokWith(stdout);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });

    it.each([
      '{"decision":"allow","reason":"x"}',
      '{"decision":"deny","reason":"no"}\n',
      '{"decision":"allow","hookSpecificOutput":{"additionalContext":"ctx"}}\n',
    ])("one decision %j passes through unchanged", (stdout) => {
      const r = grokWith(stdout);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(stdout);
    });

    it.each([
      '{"decision":"allow"}\n{"decision":"deny","reason":"x"}\n',
      '{"decision":"allow"} trailing',
      "[]",
      '{"foo":1}',
      '{"decision":"maybe"}',
      "not json",
    ])("malformed %j becomes one deny", (stdout) => {
      expectToolBlocked(grokWith(stdout), "grok", "nondecision");
    });
  });

  it.each([
    "claude",
    "codex",
    "cursor",
  ] as const)("%s exit 0: child stdout passes through byte for byte", (host) => {
    withProject(`outer-6201-pass-${host}-`, (root) => {
      const wire =
        host === "cursor"
          ? '{"permission":"allow"}\n'
          : '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n';
      // Odd bytes too: no parsing or re-encoding on these hosts.
      const payload = `${wire}  trailing é\r\n`;
      writeRuntime(root, `process.stdout.write(${JSON.stringify(payload)});\n`);
      const r = runOuter(root, host);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(payload);
    });
  });

  it.each([
    "claude",
    "codex",
    "cursor",
  ] as const)("%s exit 0 with empty stdout stays empty", (host) => {
    withProject(`outer-6201-empty-${host}-`, (root) => {
      writeRuntime(root, "process.exit(0);\n");
      const r = runOuter(root, host);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });
  });
});

describe("host-hook-outer missing-runtime project-install admit (#7275)", () => {
  function shellPayload(
    host: Host,
    command: string,
    opts: { cwd?: string; toolName?: string } = {},
  ): string {
    const toolName = opts.toolName ?? (host === "grok" ? "run_terminal_command" : "Bash");
    const cwd = opts.cwd;
    if (host === "grok") {
      return JSON.stringify({
        tool_name: toolName,
        tool_input: { command, ...(cwd !== undefined ? { cwd } : {}) },
        cwd,
      });
    }
    if (host === "cursor") {
      return JSON.stringify({
        tool_name: toolName,
        tool_input: { command, ...(cwd !== undefined ? { working_directory: cwd } : {}) },
        cwd,
      });
    }
    if (host === "codex") {
      return JSON.stringify({
        tool_name: toolName,
        tool_input: { command, ...(cwd !== undefined ? { workdir: cwd } : {}) },
      });
    }
    return JSON.stringify({
      tool_name: toolName,
      tool_input: { command, ...(cwd !== undefined ? { cwd } : {}) },
      cwd,
    });
  }

  function expectQuietAllow(r: ReturnType<typeof spawnSync>): void {
    expect(r.status).toBe(0);
    expect(String(r.stdout ?? "")).toBe("");
  }

  it.each(HOSTS)("%s: admits npm install at project root on missing pin", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-7275-admit-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      const r = runOuter(
        root,
        host,
        {},
        "tool.before",
        [],
        shellPayload(host, "npm install", { cwd: root }),
      );
      expectQuietAllow(r);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("agy: admits npm install from a run_command CommandLine payload on missing pin (#7438)", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-7275-admit-agy-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      // agy merges user-scope hook files into its order check: keep the real home out.
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const env = { HOME: home, USERPROFILE: home };
      const payload = (commandLine: string): string =>
        JSON.stringify({
          hookEventName: "PreToolUse",
          workspacePaths: [root],
          cwd: root,
          toolCall: { id: "c1", name: "run_command", args: { CommandLine: commandLine } },
        });
      const admitted = runOuter(root, "agy", env, "tool.before", [], payload("npm install"));
      expect(admitted.status).toBe(0);
      expect(JSON.parse(String(admitted.stdout))).toEqual({ decision: "allow" });
      const refused = runOuter(root, "agy", env, "tool.before", [], payload("rm -rf build"));
      expect(refused.status).toBe(0);
      expect(JSON.parse(String(refused.stdout)).decision).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "pnpm install --frozen-lockfile",
    "npm ci",
  ])("admits %s at project root (grok)", (command) => {
    const root = mkdtempSync(join(tmpdir(), "outer-7275-cmd-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      const r = runOuter(
        root,
        "grok",
        {},
        "tool.before",
        [],
        shellPayload("grok", command, { cwd: root }),
      );
      expectQuietAllow(r);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses non-shell payload carrying command npm install", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-7275-nonshell-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      const r = runOuter(
        root,
        "claude",
        {},
        "tool.before",
        [],
        shellPayload("claude", "npm install", { cwd: root, toolName: "Write" }),
      );
      expectToolBlocked(r, "claude", "missing-pin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses foreign cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-7275-foreign-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      const foreign = mkdtempSync(join(tmpdir(), "outer-7275-other-"));
      try {
        const r = runOuter(
          root,
          "grok",
          {},
          "tool.before",
          [],
          shellPayload("grok", "npm install", { cwd: foreign }),
        );
        expectToolBlocked(r, "grok", "missing-pin");
      } finally {
        rmSync(foreign, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses subdirectory cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-7275-subdir-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      const sub = join(root, "packages", "core");
      mkdirSync(sub, { recursive: true });
      const r = runOuter(
        root,
        "cursor",
        {},
        "tool.before",
        [],
        shellPayload("cursor", "npm install", { cwd: sub }),
      );
      expectToolBlocked(r, "cursor", "missing-pin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses malformed stdin", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-7275-malformed-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      const r = runOuter(root, "claude", {}, "tool.before", [], "{not-json");
      expectToolBlocked(r, "claude", "missing-pin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "npm i -g @deftai/directive",
    "directive install --repair",
  ])("refuses %s as missing-runtime recovery", (command) => {
    const root = mkdtempSync(join(tmpdir(), "outer-7275-global-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      const r = runOuter(
        root,
        "grok",
        {},
        "tool.before",
        [],
        shellPayload("grok", command, { cwd: root }),
      );
      expectToolBlocked(r, "grok", "missing-pin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refusal text names the install exception, not the person-only suffix", () => {
    expect(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE).toContain(
      HOST_HOOK_MISSING_PIN_INSTALL_EXCEPTION,
    );
    expect(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE).not.toContain(
      "Agent tool calls stay blocked until a person runs it.",
    );
    const source = hostHookOuterSource();
    expect(source).toContain(HOST_HOOK_MISSING_PIN_INSTALL_EXCEPTION);
    expect(source).not.toContain("Agent tool calls stay blocked until a person runs it.");
  });

  it("installed-pin path still forwards stdin bytes to hook-bin", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-7275-forward-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      writeRuntime(
        root,
        [
          "import { readFileSync } from 'node:fs';",
          "let raw = '';",
          "try { raw = readFileSync(0, 'utf8'); } catch {}",
          "process.stdout.write(JSON.stringify({ decision: 'allow', echo: raw }));",
        ].join("\n"),
      );
      const payload = JSON.stringify({ tool_name: "Bash", marker: "7275-forward" });
      const r = runOuter(root, "grok", {}, "tool.before", [], payload);
      expect(r.status).toBe(0);
      const parsed = JSON.parse(String(r.stdout)) as { decision: string; echo: string };
      expect(parsed.decision).toBe("allow");
      expect(parsed.echo).toBe(payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host-hook-outer agy exit paths and hook ordering (#7378)", () => {
  const PRE = { PreToolUse: [{ matcher: "*", hooks: [{ command: "x" }] }] };

  function withRoot(run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "outer-7378-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function writeHooks(root: string, hooks: Record<string, unknown>): void {
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", "hooks.json"), JSON.stringify(hooks));
  }

  function agyPayload(root: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      hookEventName: "PreToolUse",
      workspacePaths: [root],
      cwd: root,
      toolCall: { id: "c1", name: "run_command", args: { CommandLine: "echo hi" } },
      ...extra,
    });
  }

  function runAgy(
    root: string,
    stdin: string,
    event = "tool.before",
    env: NodeJS.ProcessEnv = {},
  ): ReturnType<typeof spawnSync> {
    const abs = join(root, ".agents", "deft-hook-test.mjs");
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(abs, hostHookOuterSource());
    return spawnSync(process.execPath, [abs, "--host", "agy", "--event", event], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HOME: homeOf(root), USERPROFILE: homeOf(root), ...env },
      input: stdin,
    });
  }

  function decisionOf(r: ReturnType<typeof spawnSync>): Record<string, unknown> {
    expect(r.status).toBe(0);
    const parsed = JSON.parse(String(r.stdout)) as Record<string, unknown>;
    expect(String(r.stdout).trim().split("\n")).toHaveLength(1);
    return parsed;
  }

  function writeEchoRuntime(root: string, output: string): void {
    writeRuntime(
      root,
      [
        "import { readFileSync } from 'node:fs';",
        "let raw = ''; try { raw = readFileSync(0, 'utf8'); } catch {}",
        `process.stdout.write(${JSON.stringify(output)}.replace('{raw}', () => JSON.stringify(raw)));`,
      ].join("\n"),
    );
  }

  it("allows a valid kill record with one explicit allow decision", () => {
    withRoot((root) => {
      gitInit(root);
      writeValidKillRecord(root);
      const r = runAgy(root, agyPayload(root));
      expect(decisionOf(r)).toEqual({ decision: "allow" });
    });
  });

  it("keeps the kill record silent on non-tool events", () => {
    withRoot((root) => {
      gitInit(root);
      writeValidKillRecord(root);
      const r = runAgy(root, "{}", "session.start");
      expect(r.status).toBe(0);
      expect(String(r.stdout)).toBe("");
    });
  });

  it("denies with one deny decision when the runtime is missing", () => {
    withRoot((root) => {
      const decision = decisionOf(runAgy(root, agyPayload(root)));
      expect(decision.decision).toBe("deny");
      expect(String(decision.reason)).toContain(MISSING_NO_LOCKFILE);
    });
  });

  it("prints an explicit allow for the missing-runtime project install admit", () => {
    withRoot((root) => {
      const payload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "npm install", cwd: root },
        cwd: root,
      });
      expect(decisionOf(runAgy(root, payload))).toEqual({ decision: "allow" });
    });
  });

  it("admits the project install from a real agy run_command payload (#7347)", () => {
    withRoot((root) => {
      const install = JSON.stringify({
        hookEventName: "PreToolUse",
        workspacePaths: [root],
        cwd: root,
        toolCall: { id: "c1", name: "run_command", args: { CommandLine: "npm install" } },
      });
      expect(decisionOf(runAgy(root, install))).toEqual({ decision: "allow" });
      expect(decisionOf(runAgy(root, agyPayload(root))).decision).toBe("deny");
    });
  });

  it("denies a later-running foreign hook and never reaches the runtime", () => {
    withRoot((root) => {
      writeHooks(root, { "zzzz-directive": PRE, zzzzz: PRE });
      writeRuntime(root, 'process.stderr.write("RUNTIME_REACHED\\n"); process.stdout.write("{}");');
      const r = runAgy(root, agyPayload(root));
      const decision = decisionOf(r);
      expect(decision.decision).toBe("deny");
      expect(String(decision.reason)).toContain('Hook "zzzzz"');
      expect(String(decision.reason)).toContain(
        "deft policy:disable-host-hooks --host agy --confirm",
      );
      expect(String(r.stderr)).not.toContain("RUNTIME_REACHED");
    });
  });

  /** Per-test home folder, so user-scope files never touch the real one. */
  function homeOf(root: string): string {
    return join(root, "home");
  }

  function writeHome(root: string, rel: string, hooksObject: Record<string, unknown>): void {
    const file = join(homeOf(root), ".gemini", "config", rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(hooksObject));
  }

  it("denies a later user-scope hook, which agy merges into the same order (n02)", () => {
    withRoot((root) => {
      writeHooks(root, { "zzzz-directive": PRE });
      writeHome(root, "hooks.json", { "zzzzz-user": PRE });
      writeEchoRuntime(root, '{"decision":"allow"}');
      const decision = decisionOf(runAgy(root, agyPayload(root)));
      expect(decision.decision).toBe("deny");
      expect(String(decision.reason)).toContain('Hook "zzzzz-user"');
      expect(String(decision.reason)).toContain(join(".gemini", "config", "hooks.json"));
    });
  });

  it("denies a later plugin hook in user and workspace plugin folders (n03, n04)", () => {
    withRoot((root) => {
      writeHooks(root, { "zzzz-directive": PRE });
      writeEchoRuntime(root, '{"decision":"allow"}');
      writeHome(root, "plugins/obsplug/hooks.json", { "zzzzz-plug": PRE });
      expect(String(decisionOf(runAgy(root, agyPayload(root))).reason)).toContain("zzzzz-plug");
      writeHome(root, "plugins/obsplug/hooks.json", {});
      mkdirSync(join(root, ".agents", "plugins", "w1"), { recursive: true });
      writeFileSync(
        join(root, ".agents", "plugins", "w1", "hooks.json"),
        JSON.stringify({ "zzzzz-wsplug": PRE }),
      );
      expect(String(decisionOf(runAgy(root, agyPayload(root))).reason)).toContain("zzzzz-wsplug");
    });
  });

  it("reads the hook files again on every call, so a hook added later is caught (n05)", () => {
    withRoot((root) => {
      writeHooks(root, { "zzzz-directive": PRE });
      writeEchoRuntime(root, '{"decision":"allow"}');
      expect(decisionOf(runAgy(root, agyPayload(root))).decision).toBe("allow");
      writeHooks(root, { "zzzz-directive": PRE, "zzzzz-late-ws": PRE });
      expect(String(decisionOf(runAgy(root, agyPayload(root))).reason)).toContain("zzzzz-late-ws");
      writeHooks(root, { "zzzz-directive": PRE });
      writeHome(root, "hooks.json", { "zzzzz-late-user": PRE });
      expect(String(decisionOf(runAgy(root, agyPayload(root))).reason)).toContain(
        "zzzzz-late-user",
      );
    });
  });

  it("allows earlier user and plugin hooks", () => {
    withRoot((root) => {
      writeHooks(root, { "zzzz-directive": PRE });
      writeHome(root, "hooks.json", { "aaaa-user": PRE });
      writeHome(root, "plugins/p/hooks.json", { "aaaa-plug": PRE });
      writeEchoRuntime(root, '{"decision":"allow"}');
      expect(decisionOf(runAgy(root, agyPayload(root))).decision).toBe("allow");
    });
  });

  it("denies on an unparseable hook config and on an unresolvable workspace", () => {
    withRoot((root) => {
      mkdirSync(join(root, ".agents"), { recursive: true });
      writeFileSync(join(root, ".agents", "hooks.json"), "{bad");
      writeEchoRuntime(root, '{"decision":"allow"}');
      expect(decisionOf(runAgy(root, agyPayload(root))).decision).toBe("deny");
      rmSync(join(root, ".agents", "hooks.json"));
      expect(decisionOf(runAgy(root, agyPayload(root, { workspacePaths: [] }))).decision).toBe(
        "deny",
      );
      expect(decisionOf(runAgy(root, "not json")).decision).toBe("deny");
    });
  });

  it("forwards stdin and one valid child decision when ordering is clean", () => {
    withRoot((root) => {
      writeHooks(root, { "zzzz-directive": PRE, "obs-a": PRE });
      writeEchoRuntime(root, '{"decision":"ask","echo":{raw}}');
      const payload = agyPayload(root);
      const decision = decisionOf(runAgy(root, payload));
      expect(decision.decision).toBe("ask");
      expect(decision.echo).toBe(payload);
    });
  });

  it("allows when there is no project hook file and the child decides allow", () => {
    withRoot((root) => {
      writeEchoRuntime(root, '{"decision":"allow"}');
      expect(decisionOf(runAgy(root, agyPayload(root)))).toEqual({ decision: "allow" });
    });
  });

  it.each([
    ["empty stdout", "", "exit 0"],
    ["whitespace only", "  \n", "exit 0"],
    ["invalid JSON", "not json", "exit 0"],
    ["two objects", '{"decision":"allow"}\n{"decision":"allow"}', "exit 0"],
    ["an array", '[{"decision":"allow"}]', "exit 0"],
    ["a non-decision object", '{"ok":true}', "exit 0"],
    ["an unknown decision", '{"decision":"maybe"}', "exit 0"],
  ])("denies when the child prints %s", (_label, output) => {
    withRoot((root) => {
      writeEchoRuntime(root, output);
      const decision = decisionOf(runAgy(root, agyPayload(root)));
      expect(decision.decision).toBe("deny");
      expect(String(decision.reason)).toContain(HOST_HOOK_NONDECISION_REASON);
    });
  });

  it("denies when the child exits non-zero or cannot run", () => {
    withRoot((root) => {
      writeRuntime(root, "process.exit(2);");
      expect(decisionOf(runAgy(root, agyPayload(root))).decision).toBe("deny");
      writeRuntime(root, "throw new Error('boom');");
      expect(decisionOf(runAgy(root, agyPayload(root))).decision).toBe("deny");
    });
  });

  it("leaves non-tool agy events on today's pass-through", () => {
    withRoot((root) => {
      writeRuntime(root, 'process.stdout.write("");');
      const r = runAgy(root, "{}", "session.start");
      expect(r.status).toBe(0);
      expect(String(r.stdout)).toBe("");
    });
  });

  it("does not change other hosts' outputs", () => {
    withRoot((root) => {
      writeHooks(root, { "zzzz-directive": PRE, zzzzz: PRE });
      writeRuntime(root, 'process.stdout.write("");');
      const r = runOuter(root, "grok", {}, "tool.before", [], agyPayload(root));
      expect(r.status).toBe(0);
      expect(String(r.stdout)).toBe("");
    });
  });
});

describe("agy entry readers accept flat and grouped handlers (#7440)", () => {
  const cmd = (event: string): string =>
    `node ${hostHookOuterFileName("abcdef12")} --host agy --event ${event}`;
  const flat = { SessionStart: [{ command: cmd("session.start"), timeout: 5 }] };
  const grouped = { PreToolUse: [{ matcher: "*", hooks: [{ command: cmd("tool.before") }] }] };

  it("reads commands from a flat SessionStart and a grouped PreToolUse", () => {
    expect(agyEntryCommands({ ...flat, ...grouped })).toEqual([
      cmd("session.start"),
      cmd("tool.before"),
    ]);
  });

  it("still reads an earlier grouped SessionStart", () => {
    expect(agyEntryCommands({ SessionStart: [{ hooks: flat.SessionStart }] })).toEqual([
      cmd("session.start"),
    ]);
  });

  it("recognises and strips a flat-only entry, and keeps foreign flat entries", () => {
    expect(isManagedAgyHookEntry(flat)).toBe(true);
    const foreign = { SessionStart: [{ command: "echo hi" }] };
    expect(isManagedAgyHookEntry(foreign)).toBe(false);
    expect(stripAgyHostHookConfig({ [AGY_DIRECTIVE_HOOK_NAME]: flat, aaaa: foreign })).toEqual({
      aaaa: foreign,
    });
  });
});

describe("agy strip keeps the outer a kept entry still runs (#7438)", () => {
  const sha8 = "abcdef12";
  const outerRel = `.agents/${hostHookOuterFileName(sha8)}`;
  const chained = {
    [AGY_DIRECTIVE_HOOK_NAME]: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              command: `node ${hostHookOuterFileName(sha8)} --host agy --event tool.before && node mine.mjs`,
            },
          ],
        },
      ],
    },
  };

  function projectWith(registration: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "outer-strip-keep-"));
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents", "hooks.json"), `${JSON.stringify(registration)}\n`);
    writeFileSync(join(root, outerRel), "// outer\n");
    return root;
  }

  it("keeps the outer file when the entry is kept", () => {
    const root = projectWith(chained);
    try {
      const result = stripHostHookRegistrationInPlace(root, "agy");
      expect(result.error).toBeUndefined();
      expect(existsSync(join(root, outerRel))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes the outer file when Directive's entry is stripped", () => {
    const managed = {
      [AGY_DIRECTIVE_HOOK_NAME]: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { command: `node ${hostHookOuterFileName(sha8)} --host agy --event tool.before` },
            ],
          },
        ],
      },
    };
    const root = projectWith(managed);
    try {
      stripHostHookRegistrationInPlace(root, "agy");
      expect(existsSync(join(root, outerRel))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches a long run of dashes in linear time (no backtracking blow-up)", () => {
    const attack = `node ${hostHookOuterFileName(sha8)} --host agy${" ---".repeat(30000)} !`;
    const started = Date.now();
    expect(isManagedAgyHookEntry({ PreToolUse: [{ hooks: [{ command: attack }] }] })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
