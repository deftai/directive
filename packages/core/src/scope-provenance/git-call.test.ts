/**
 * Per-call git time limit for verify:scope-provenance (#6378 items 8-10).
 */
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createScopeProvenanceGit,
  DEFAULT_GIT_TIMEOUT_SECONDS,
  defaultGitTimeoutRemedy,
  formatGitCallTimeoutLine,
  formatGitCommand,
  GIT_TIMEOUT_ENV,
  GitCallTimeoutError,
  type GitSpawn,
  isGitCallTimeout,
  largerGitTimeoutSeconds,
  parseGitTimeoutSeconds,
  resolveGitTimeoutSeconds,
  SCOPE_PROVENANCE_GIT_CALL_TIMEOUT,
} from "./git-call.js";

function ok(stdout = "out"): SpawnSyncReturns<string | Buffer> {
  return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
}

function timedOut(): SpawnSyncReturns<string | Buffer> {
  const error = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: "SIGKILL",
    error,
  };
}

/** Records each spawn's options; answers from `answers` in order (last one repeats). */
function scripted(answers: Array<SpawnSyncReturns<string | Buffer>>): {
  spawn: GitSpawn;
  calls: Array<{ args: readonly string[]; options: SpawnSyncOptions }>;
} {
  const calls: Array<{ args: readonly string[]; options: SpawnSyncOptions }> = [];
  const spawn: GitSpawn = (_cmd, args, options) => {
    calls.push({ args, options });
    return answers[Math.min(calls.length - 1, answers.length - 1)] as SpawnSyncReturns<
      string | Buffer
    >;
  };
  return { spawn, calls };
}

describe("declared refusal row (#6378 item 10)", () => {
  it("ships in warn mode with an id, a reason and a remedy", () => {
    expect(SCOPE_PROVENANCE_GIT_CALL_TIMEOUT.id).toBe("scope-provenance-git-call-timeout");
    expect(SCOPE_PROVENANCE_GIT_CALL_TIMEOUT.mode).toBe("warn");
    expect(SCOPE_PROVENANCE_GIT_CALL_TIMEOUT.reason.length).toBeGreaterThan(0);
    expect(SCOPE_PROVENANCE_GIT_CALL_TIMEOUT.remedy).toMatch(/--git-timeout-seconds/);
  });
});

describe("limit resolution (#6378 item 8)", () => {
  it("defaults to 120 seconds with no flag and no variable", () => {
    expect(DEFAULT_GIT_TIMEOUT_SECONDS).toBe(120);
    expect(resolveGitTimeoutSeconds(undefined, {})).toBe(120);
    expect(resolveGitTimeoutSeconds(null, {})).toBe(120);
  });

  it("lets the variable override the default and the flag win over the variable", () => {
    expect(resolveGitTimeoutSeconds(undefined, { [GIT_TIMEOUT_ENV]: "60" })).toBe(60);
    expect(resolveGitTimeoutSeconds(300, { [GIT_TIMEOUT_ENV]: "60" })).toBe(300);
    expect(resolveGitTimeoutSeconds(0, { [GIT_TIMEOUT_ENV]: "60" })).toBe(0);
  });

  it("ignores a variable that is not a whole number of seconds", () => {
    expect(resolveGitTimeoutSeconds(undefined, { [GIT_TIMEOUT_ENV]: "abc" })).toBe(120);
    expect(resolveGitTimeoutSeconds(undefined, { [GIT_TIMEOUT_ENV]: "-5" })).toBe(120);
    expect(parseGitTimeoutSeconds(" 45 ")).toBe(45);
    expect(parseGitTimeoutSeconds("1.5")).toBeNull();
    expect(parseGitTimeoutSeconds("9999999")).toBeNull();
    expect(parseGitTimeoutSeconds("")).toBeNull();
  });

  it("offers a larger limit in the remedy", () => {
    expect(largerGitTimeoutSeconds(120)).toBe(240);
    expect(largerGitTimeoutSeconds(1)).toBe(61);
    expect(defaultGitTimeoutRemedy(240)).toBe(
      "deft verify:scope-provenance --git-timeout-seconds 240",
    );
  });
});

describe("git runner spawn options (#6378 items 8-9)", () => {
  it("starts every call with the limit, SIGKILL and GIT_OPTIONAL_LOCKS=0", () => {
    const s = scripted([ok()]);
    const git = createScopeProvenanceGit({ env: {}, spawn: s.spawn });
    expect(git.timeoutSeconds).toBe(120);
    git.runText(["rev-parse", "HEAD"], "/repo");
    git.runBytes(["cat-file", "--batch"], "/repo", "HEAD:a\n");
    expect(s.calls).toHaveLength(2);
    for (const c of s.calls) {
      expect(c.options.timeout).toBe(120_000);
      expect(c.options.killSignal).toBe("SIGKILL");
      expect((c.options.env as NodeJS.ProcessEnv).GIT_OPTIONAL_LOCKS).toBe("0");
      expect(c.options.cwd).toBe("/repo");
    }
    expect(s.calls[0]?.options.encoding).toBe("utf8");
    expect(s.calls[1]?.options.encoding).toBe("buffer");
    expect(Buffer.isBuffer(s.calls[1]?.options.input)).toBe(true);
  });

  it("uses the environment limit and no limit for 0", () => {
    const fromEnv = scripted([ok()]);
    createScopeProvenanceGit({ env: { [GIT_TIMEOUT_ENV]: "60" }, spawn: fromEnv.spawn }).runText(
      ["status"],
      ".",
    );
    expect(fromEnv.calls[0]?.options.timeout).toBe(60_000);

    const none = scripted([ok()]);
    createScopeProvenanceGit({ timeoutSeconds: 0, env: {}, spawn: none.spawn }).runText(
      ["status"],
      ".",
    );
    expect(none.calls[0]?.options.timeout).toBeUndefined();
    expect(none.calls[0]?.options.killSignal).toBeUndefined();
    expect((none.calls[0]?.options.env as NodeJS.ProcessEnv).GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("passes a non-timeout result through unchanged", () => {
    const failed: SpawnSyncReturns<string | Buffer> = { ...ok(""), status: 128 };
    const s = scripted([failed]);
    const report: string[] = [];
    const r = createScopeProvenanceGit({
      timeoutSeconds: 5,
      spawn: s.spawn,
      report: (l) => report.push(l),
    }).runText(["show", "x"], ".");
    expect(r.status).toBe(128);
    expect(report).toEqual([]);
    expect(isGitCallTimeout(r)).toBe(false);
  });
});

describe("a call that reaches the limit (#6378 item 10)", () => {
  it("warn mode: one line, then the same command once more with no limit", () => {
    const s = scripted([timedOut(), ok("second")]);
    const lines: string[] = [];
    const git = createScopeProvenanceGit({
      timeoutSeconds: 120,
      env: {},
      spawn: s.spawn,
      report: (l) => lines.push(l),
    });
    git.setPhase("census");
    const r = git.runText(["cat-file", "--batch-check"], ".", "HEAD:a\n");
    expect(r.stdout).toBe("second");
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.args).toEqual(s.calls[0]?.args);
    expect(s.calls[1]?.options.timeout).toBeUndefined();
    expect(lines).toHaveLength(1);
    const line = lines[0] as string;
    expect(line).toContain("scope-provenance-git-call-timeout");
    expect(line).toContain('phase "census"');
    expect(line).toContain("`git cat-file --batch-check`");
    expect(line).toMatch(/after \d+\.\d s/);
    expect(line).toContain("Remedy: deft verify:scope-provenance --git-timeout-seconds 240");
    expect(line).toMatch(/later release/);
    expect(git.timedOut()).toBeNull();
  });

  it("enforce mode: throws the refusal line and keeps it", () => {
    const s = scripted([timedOut()]);
    const git = createScopeProvenanceGit({
      timeoutSeconds: 120,
      mode: "enforce",
      env: {},
      spawn: s.spawn,
      remedy: (n) =>
        `deft verify:scope-provenance --base-ref origin/master --git-timeout-seconds ${String(n)}`,
    });
    git.setPhase("change-set read");
    let caught: unknown;
    try {
      git.runText(["diff", "--name-only", "HEAD"], ".");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCallTimeoutError);
    const err = caught as GitCallTimeoutError;
    expect(err.id).toBe("scope-provenance-git-call-timeout");
    expect(err.phase).toBe("change-set read");
    expect(err.command).toBe("git diff --name-only HEAD");
    expect(err.limitSeconds).toBe(120);
    expect(err.message).toContain("(enforce)");
    expect(err.message).toContain("Refused (exit 2)");
    expect(err.message).toContain("--git-timeout-seconds 240");
    expect(s.calls).toHaveLength(1);
    expect(git.timedOut()).toBe(err);
  });

  it("gets control back from a git process that handles SIGTERM and does not exit", () => {
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const stubborn: GitSpawn = (_cmd, _args, options) =>
      spawnSync(process.execPath, ["-e", script], options) as SpawnSyncReturns<string | Buffer>;
    const git = createScopeProvenanceGit({
      timeoutSeconds: 1,
      mode: "enforce",
      env: process.env,
      spawn: stubborn,
    });
    const started = Date.now();
    expect(() => git.runText(["show", "HEAD:x"], process.cwd())).toThrow(GitCallTimeoutError);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("formats the line with the phase, command, elapsed seconds and remedy", () => {
    const warn = formatGitCallTimeoutLine({
      mode: "warn",
      phase: "per-story evaluation",
      command: formatGitCommand(["show", "origin/master:xbrief/active/a b.json"]),
      elapsedSeconds: 120.04,
      limitSeconds: 120,
      remedy: "R",
    });
    expect(warn).toBe(
      'verify_scope_provenance: scope-provenance-git-call-timeout (warn): `git show "origin/master:xbrief/active/a b.json"` ' +
        'reached the 120 s per-call limit in phase "per-story evaluation" after 120.0 s and was ended. ' +
        "It runs once more with no limit; this check can refuse (exit 2) from a later release. Remedy: R",
    );
  });
});
