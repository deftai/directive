import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchTaskCheck,
  isFrameworkRepoRoot,
  isFrameworkSourceContext,
  resolveCheckTarget,
} from "./orchestrator.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("isFrameworkSourceContext", () => {
  it("returns true when framework and project roots are the same path", () => {
    expect(isFrameworkSourceContext("/a/b/c", "/a/b/c")).toBe(true);
  });

  it("returns true when paths are equivalent after resolve", () => {
    // resolve('/a/b/../b/c') === '/a/b/c'
    expect(isFrameworkSourceContext("/a/b/c", "/a/b/../b/c")).toBe(true);
  });

  it("returns false when paths differ", () => {
    expect(isFrameworkSourceContext("/framework/root", "/consumer/project")).toBe(false);
  });

  it("returns false for subpath relationship", () => {
    expect(isFrameworkSourceContext("/project/.deft/core", "/project")).toBe(false);
  });

  it("returns true for a subdirectory of the framework source repo (#2220)", () => {
    expect(isFrameworkSourceContext(repoRoot, join(repoRoot, "packages", "core"))).toBe(true);
  });

  it("returns false when projectRoot is outside the framework repo", () => {
    expect(isFrameworkSourceContext(repoRoot, "/tmp/other-project")).toBe(false);
  });
});

describe("isFrameworkRepoRoot", () => {
  it("recognizes the real framework checkout", () => {
    expect(isFrameworkRepoRoot(repoRoot)).toBe(true);
  });

  it("rejects a bare consumer-style path", () => {
    expect(isFrameworkRepoRoot("/tmp/consumer/.deft/core")).toBe(false);
  });
});

describe("resolveCheckTarget", () => {
  it("returns check:framework-source when roots are equal", () => {
    expect(resolveCheckTarget("/same/path", "/same/path")).toBe("check:framework-source");
  });

  it("returns check:framework-source for a framework-repo subdirectory (#2220)", () => {
    expect(resolveCheckTarget(repoRoot, join(repoRoot, "packages", "core"))).toBe(
      "check:framework-source",
    );
  });

  it("returns check:consumer when roots differ", () => {
    expect(resolveCheckTarget("/framework", "/consumer")).toBe("check:consumer");
  });
});

describe("dispatchTaskCheck", () => {
  it("invokes task check:framework-source for framework-source context", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const root = "/home/user/deft";
    const code = dispatchTaskCheck(root, root, { spawnFn, useTaskCache: false });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("check:framework-source");
    expect(calls[0]?.args).toContain("--taskfile");
  });

  it("invokes task check:consumer for consumer context", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const framework = "/home/user/deft";
    const project = "/home/user/consumer-project";
    const code = dispatchTaskCheck(framework, project, { spawnFn, useTaskCache: false });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("check:consumer");
  });

  it("uses the correct cwd for framework-source context", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const root = "/home/user/deft";
    dispatchTaskCheck(root, root, { spawnFn, useTaskCache: false });
    expect(calls[0]?.cwd).toBe(resolve(root));
  });

  it("uses projectRoot as cwd for consumer context", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const framework = "/home/user/deft";
    const project = "/home/user/consumer";
    dispatchTaskCheck(framework, project, { spawnFn, useTaskCache: false });
    expect(calls[0]?.cwd).toBe(resolve(project));
  });

  it("fails with deposit-repair guidance when consumer deposit lacks verify.yml (#3070)", () => {
    const framework = mkdtempSync(join(tmpdir(), "deft-3070-fw-"));
    tempDirs.push(framework);
    mkdirSync(join(framework, "tasks"), { recursive: true });
    writeFileSync(
      join(framework, "Taskfile.yml"),
      `version: '3'
includes:
  verify:
    taskfile: ./tasks/verify.yml
    optional: true
  toolchain:
    taskfile: ./tasks/toolchain.yml
  vbrief:
    taskfile: ./tasks/vbrief.yml
tasks:
  doctor:
    cmds: [echo doctor]
  verify-strategy-output:
    cmds: [echo strategy]
`,
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "toolchain.yml"),
      "version: '3'\ntasks:\n  check-consumer:\n    cmds: [echo ok]\n",
      "utf8",
    );
    writeFileSync(
      join(framework, "tasks", "vbrief.yml"),
      "version: '3'\ntasks:\n  validate:\n    cmds: [echo ok]\n",
      "utf8",
    );

    const calls: unknown[] = [];
    const spawnFn = () => {
      calls.push("spawned");
      return { status: 0 };
    };
    const project = join(tmpdir(), "consumer-project");
    const code = dispatchTaskCheck(framework, project, { spawnFn, useTaskCache: false });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("uses a custom task binary when provided via seams", () => {
    const calls: Array<{ cmd: string }> = [];
    const spawnFn = (cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd });
      return { status: 0 };
    };

    dispatchTaskCheck("/root", "/root", { taskBin: "my-task", spawnFn, useTaskCache: false });
    expect(calls[0]?.cmd).toBe("my-task");
  });

  it("returns 2 when the spawn throws an error", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawnFn = (_cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      return { status: null, error: new Error("task not found") };
    };

    const code = dispatchTaskCheck("/root", "/root", { spawnFn, useTaskCache: false });
    expect(code).toBe(2);
    errWrite.mockRestore();
  });

  it("returns 1 when task exits with null status and no error", () => {
    const spawnFn = (_cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      return { status: null };
    };

    const code = dispatchTaskCheck("/root", "/root", { spawnFn, useTaskCache: false });
    expect(code).toBe(1);
  });

  it("passes the framework-root Taskfile.yml path in --taskfile arg", () => {
    const calls: Array<{ args: string[] }> = [];
    const spawnFn = (_cmd: string, args: string[], _opts: { cwd: string; stdio: string }) => {
      calls.push({ args });
      return { status: 0 };
    };

    dispatchTaskCheck("/my/framework", "/my/consumer", { spawnFn, useTaskCache: false });
    const taskfileIdx = calls[0]?.args.indexOf("--taskfile") ?? -1;
    expect(taskfileIdx).toBeGreaterThan(-1);
    const taskfilePath = calls[0]?.args[taskfileIdx + 1];
    expect(taskfilePath).toBe(join(resolve("/my/framework"), "Taskfile.yml"));
  });

  it("forwards non-zero exit code from task subprocess", () => {
    const spawnFn = (_cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      return { status: 42 };
    };

    const code = dispatchTaskCheck("/root", "/root", { spawnFn, useTaskCache: false });
    expect(code).toBe(42);
  });

  it("forwards release self-auth env to the task child (#2386)", () => {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const spawnFn = (
      _cmd: string,
      _args: string[],
      opts: { cwd: string; stdio: string; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ env: opts.env });
      return { status: 0 };
    };

    const env = {
      FOO: "bar",
      DEFT_ALLOW_DEFAULT_BRANCH_COMMIT: "1",
      DEFT_RELEASE_PREFLIGHT: "1",
    };
    dispatchTaskCheck("/root", "/root", { spawnFn, useTaskCache: false, env });
    expect(calls[0]?.env?.FOO).toBe("bar");
    expect(calls[0]?.env?.DEFT_ALLOW_DEFAULT_BRANCH_COMMIT).toBe("1");
    expect(calls[0]?.env?.DEFT_RELEASE_PREFLIGHT).toBe("1");
  });

  it("returns 124 when the spawn hits the configured timeout (#2652)", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawnFn = (
      _cmd: string,
      _args: string[],
      _opts: { cwd: string; stdio: string; timeoutMs?: number },
    ) => ({ status: null, signal: "SIGTERM" as const });

    const code = dispatchTaskCheck("/root", "/root", {
      spawnFn,
      useTaskCache: false,
      timeoutMs: 60_000,
    });
    expect(code).toBe(124);
    errWrite.mockRestore();
  });

  it("uses the real defaultSpawn path when no spawnFn is provided (taskBin not found = error path)", () => {
    // When no spawnFn seam is given, dispatchTaskCheck calls the internal
    // defaultSpawn which wraps spawnSync. Using a non-existent binary causes
    // spawnSync to populate result.error (ENOENT), which maps to exit 2.
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = dispatchTaskCheck("/tmp/fake-fw", "/tmp/fake-fw", {
      taskBin: "/absolutely-nonexistent-binary-that-cannot-exist",
      useTaskCache: false,
    });
    expect(code).toBe(2);
    errWrite.mockRestore();
  });
});
