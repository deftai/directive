import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE,
  HOST_HOOK_NONDECISION_REASON,
  hostHookOuterCommand,
  hostHookOuterFileName,
  hostHookOuterRelPath,
  hostHookOuterSha8,
  hostHookOuterSource,
  isHostHookOuterCommand,
  stageTipRequiredCursorDeposit,
  tipRequiredCursorDepositPaths,
  validateCursorDepositAssociation,
} from "./host-hook-outer.js";

type Host = "grok" | "claude" | "cursor" | "codex";

const HOSTS: Host[] = ["grok", "claude", "cursor", "codex"];

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
  });
}

type ReasonKind = "missing-pin" | "nondecision";

function expectReason(text: string, kind: ReasonKind): void {
  if (kind === "missing-pin") {
    expect(text).toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
    expect(text).not.toContain(HOST_HOOK_NONDECISION_REASON);
    expect(text).not.toContain("npm i -g");
    expect(text).not.toContain("install --repair");
  } else {
    expect(text).toContain(HOST_HOOK_NONDECISION_REASON);
    expect(text).not.toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
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

  it("F1: eligible disable quiet-allows without pin present", () => {
    const root = mkdtempSync(join(tmpdir(), "outer-disable-"));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      const r = runOuter(root, "grok");
      expect(r.status).toBe(0);
      expect(r.stdout ?? "").toBe("");
      expect(r.stderr ?? "").toBe("");
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
      expect(r.stdout).toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
      expect(r.stdout).not.toContain("npm i -g @deftai/directive");
      expect(r.stdout).not.toContain("directive install --repair");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("source mentions pin hook-bin and disable flag", () => {
    const source = hostHookOuterSource();
    expect(source).toContain("node_modules/@deftai/directive-runtime/dist/hook-bin.js");
    expect(source).toContain(".deft-directive-disable");
    expect(source).toContain(HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE);
    expect(source).toContain(HOST_HOOK_NONDECISION_REASON);
    expect(source).toContain("isRegularFile");
    expect(source).toContain("gitTrackListing");
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

  it.each(
    HOSTS,
  )("%s: eligible untracked still quietAllows without pin (missing-runtime)", (host) => {
    const root = mkdtempSync(join(tmpdir(), `outer-eligible-${host}-`));
    try {
      writeFileSync(join(root, "package.json"), "{}\n");
      gitInit(root);
      writeFileSync(join(root, ".deft-directive-disable"), "1\n");
      const r = runOuter(root, host);
      expect(r.status).toBe(0);
      expect(r.stdout ?? "").toBe("");
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

describe("tip-required Cursor deposit co-travel (#6163 Prefer-A Bound 6772886751)", () => {
  function git(root: string, args: string[]): ReturnType<typeof spawnSync> {
    return spawnSync("git", args, { cwd: root, encoding: "utf8" });
  }

  function seedRepo(root: string): string {
    writeFileSync(join(root, "package.json"), "{}\n");
    gitInit(root);
    expect(git(root, ["config", "user.email", "t@t.dev"]).status).toBe(0);
    expect(git(root, ["config", "user.name", "t"]).status).toBe(0);
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), ".cursor/\n", "utf8");
    const source = hostHookOuterSource();
    const sha8 = hostHookOuterSha8(source);
    const shimRel = hostHookOuterRelPath("cursor", sha8);
    mkdirSync(join(root, ".cursor", "hooks"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "hooks.json"),
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [{ command: hostHookOuterCommand("cursor", sha8), timeout: 5 }],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(join(root, shimRel), source, "utf8");
    return sha8;
  }

  it("enumerates exact tip-required Cursor paths for the new hash", () => {
    const sha8 = hostHookOuterSha8();
    expect(tipRequiredCursorDepositPaths(sha8)).toEqual([
      ".cursor/hooks.json",
      `.cursor/hooks/deft-hook-${sha8}.mjs`,
    ]);
  });

  it("ordinary add misses excluded Cursor shim; force-add stages the bounded set", () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-force-add-"));
    try {
      const sha8 = seedRepo(root);
      const paths = tipRequiredCursorDepositPaths(sha8);
      // Ignored paths may make plain `git add` exit non-zero; either way they must not stage.
      git(root, ["add", "--", ...paths]);
      const stagedOrdinary = git(root, ["diff", "--cached", "--name-only"]).stdout ?? "";
      expect(stagedOrdinary.trim()).toBe("");
      const staged = stageTipRequiredCursorDeposit(root, { sha8 });
      expect(staged.staged).toEqual([...paths]);
      const stagedForce = (git(root, ["diff", "--cached", "--name-only"]).stdout ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .sort();
      expect(stagedForce).toEqual([...paths].sort());
      const indexAssoc = validateCursorDepositAssociation(root, { source: "index" });
      expect(indexAssoc.ok).toBe(true);
      expect(indexAssoc.sha8).toBe(sha8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("committed pair passes HEAD association; omitted shim and staging-only fail HEAD", () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-assoc-"));
    try {
      const sha8 = seedRepo(root);
      const paths = tipRequiredCursorDepositPaths(sha8);
      stageTipRequiredCursorDeposit(root, { sha8 });
      expect(
        git(root, ["-c", "commit.gpgsign=false", "commit", "-qm", "cursor-deposit"]).status,
      ).toBe(0);
      const goodHead = (git(root, ["rev-parse", "HEAD"]).stdout ?? "").trim();
      const headOk = validateCursorDepositAssociation(root, { source: "HEAD" });
      expect(headOk.ok).toBe(true);
      expect(headOk.sha8).toBe(sha8);

      // Staging-only new hash without commit: HEAD stays associated; index for fake fails.
      const fakeSha = "deadbeef";
      const fakeRel = hostHookOuterRelPath("cursor", fakeSha);
      writeFileSync(join(root, fakeRel), "not-outer\n", "utf8");
      writeFileSync(
        join(root, ".cursor", "hooks.json"),
        `${JSON.stringify(
          {
            version: 1,
            hooks: {
              sessionStart: [{ command: hostHookOuterCommand("cursor", fakeSha), timeout: 5 }],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      stageTipRequiredCursorDeposit(root, { sha8: fakeSha });
      const headStillOld = validateCursorDepositAssociation(root, {
        source: "HEAD",
        outerSource: hostHookOuterSource(),
      });
      expect(headStillOld.ok).toBe(true);
      expect(headStillOld.sha8).toBe(sha8);
      const indexFake = validateCursorDepositAssociation(root, {
        source: "index",
        outerSource: "not-outer\n",
      });
      expect(indexFake.ok).toBe(false);

      // Omitted shim on HEAD fails (reset to good tip first so hooks.json still names sha8).
      expect(git(root, ["reset", "--hard", goodHead]).status).toBe(0);
      expect(git(root, ["rm", "-f", "--", paths[1]]).status).toBe(0);
      expect(git(root, ["-c", "commit.gpgsign=false", "commit", "-qm", "omit-shim"]).status).toBe(
        0,
      );
      const omitted = validateCursorDepositAssociation(root, { source: "HEAD" });
      expect(omitted.ok).toBe(false);
      expect(omitted.detail).toMatch(/missing .cursor\/hooks\/deft-hook-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unrelated filename text and wrong-path commands in hooks.json", () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-assoc-json-"));
    try {
      const sha8 = seedRepo(root);
      const paths = tipRequiredCursorDepositPaths(sha8);
      const source = hostHookOuterSource();
      // Unrelated string containing the shim token must not pass.
      writeFileSync(
        join(root, paths[0]),
        JSON.stringify({ note: hostHookOuterFileName(sha8), hooks: {} }, null, 2) + "\n",
        "utf8",
      );
      stageTipRequiredCursorDeposit(root, { sha8 });
      expect(validateCursorDepositAssociation(root, { source: "index" }).ok).toBe(false);

      // Wrong directory command must not pass.
      writeFileSync(
        join(root, paths[0]),
        JSON.stringify(
          {
            version: 1,
            hooks: {
              sessionStart: [
                {
                  command: `node ../other/.cursor/hooks/${hostHookOuterFileName(sha8)}`,
                  timeout: 5,
                },
              ],
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      stageTipRequiredCursorDeposit(root, { sha8 });
      expect(validateCursorDepositAssociation(root, { source: "index" }).ok).toBe(false);

      // Exact expected command still passes.
      writeFileSync(
        join(root, paths[0]),
        JSON.stringify(
          {
            version: 1,
            hooks: {
              sessionStart: [{ command: hostHookOuterCommand("cursor", sha8), timeout: 5 }],
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      writeFileSync(join(root, paths[1]), source, "utf8");
      stageTipRequiredCursorDeposit(root, { sha8 });
      expect(validateCursorDepositAssociation(root, { source: "index" }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stageTipRequiredCursorDeposit never commits", () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-stage-only-"));
    try {
      const sha8 = seedRepo(root);
      const before = (git(root, ["rev-parse", "HEAD"]).stdout ?? "").trim();
      // Unborn HEAD is fine — ensure no commit object is created by stage helper.
      stageTipRequiredCursorDeposit(root, { sha8 });
      const log = git(root, ["log", "--oneline"]);
      expect(log.status === 0 || log.status === 128).toBe(true);
      if (before.length > 0 && !before.includes("fatal")) {
        expect((git(root, ["rev-parse", "HEAD"]).stdout ?? "").trim()).toBe(before);
      } else {
        expect(log.status).not.toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    "prompt.submit",
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
        reason: HOST_HOOK_MISSING_PIN_PROJECT_PM_GUIDANCE,
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
