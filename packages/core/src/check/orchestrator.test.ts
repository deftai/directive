import { describe, expect, it, vi } from "vitest";
import { dispatchTaskCheck, isFrameworkSourceContext, resolveCheckTarget } from "./orchestrator.js";

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
});

describe("resolveCheckTarget", () => {
  it("returns check:framework-source when roots are equal", () => {
    expect(resolveCheckTarget("/same/path", "/same/path")).toBe("check:framework-source");
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
    const code = dispatchTaskCheck(root, root, { spawnFn });
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
    const code = dispatchTaskCheck(framework, project, { spawnFn });
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
    dispatchTaskCheck(root, root, { spawnFn });
    expect(calls[0]?.cwd).toBe(root);
  });

  it("uses projectRoot as cwd for consumer context", () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spawnFn = (cmd: string, args: string[], opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const framework = "/home/user/deft";
    const project = "/home/user/consumer";
    dispatchTaskCheck(framework, project, { spawnFn });
    expect(calls[0]?.cwd).toBe(project);
  });

  it("uses a custom task binary when provided via seams", () => {
    const calls: Array<{ cmd: string }> = [];
    const spawnFn = (cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      calls.push({ cmd });
      return { status: 0 };
    };

    dispatchTaskCheck("/root", "/root", { taskBin: "my-task", spawnFn });
    expect(calls[0]?.cmd).toBe("my-task");
  });

  it("returns 2 when the spawn throws an error", () => {
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const spawnFn = (_cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      return { status: null, error: new Error("task not found") };
    };

    const code = dispatchTaskCheck("/root", "/root", { spawnFn });
    expect(code).toBe(2);
    errWrite.mockRestore();
  });

  it("returns 1 when task exits with null status and no error", () => {
    const spawnFn = (_cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      return { status: null };
    };

    const code = dispatchTaskCheck("/root", "/root", { spawnFn });
    expect(code).toBe(1);
  });

  it("passes the framework-root Taskfile.yml path in --taskfile arg", () => {
    const calls: Array<{ args: string[] }> = [];
    const spawnFn = (_cmd: string, args: string[], _opts: { cwd: string; stdio: string }) => {
      calls.push({ args });
      return { status: 0 };
    };

    dispatchTaskCheck("/my/framework", "/my/consumer", { spawnFn });
    const taskfileIdx = calls[0]?.args.indexOf("--taskfile") ?? -1;
    expect(taskfileIdx).toBeGreaterThan(-1);
    const taskfilePath = calls[0]?.args[taskfileIdx + 1];
    expect(taskfilePath).toBe("/my/framework/Taskfile.yml");
  });

  it("forwards non-zero exit code from task subprocess", () => {
    const spawnFn = (_cmd: string, _args: string[], _opts: { cwd: string; stdio: string }) => {
      return { status: 42 };
    };

    const code = dispatchTaskCheck("/root", "/root", { spawnFn });
    expect(code).toBe(42);
  });

  it("uses the real defaultSpawn path when no spawnFn is provided (taskBin not found = error path)", () => {
    // When no spawnFn seam is given, dispatchTaskCheck calls the internal
    // defaultSpawn which wraps spawnSync. Using a non-existent binary causes
    // spawnSync to populate result.error (ENOENT), which maps to exit 2.
    const errWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = dispatchTaskCheck("/tmp/fake-fw", "/tmp/fake-fw", {
      taskBin: "/absolutely-nonexistent-binary-that-cannot-exist",
    });
    expect(code).toBe(2);
    errWrite.mockRestore();
  });
});
