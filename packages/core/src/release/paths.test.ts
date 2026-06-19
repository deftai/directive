import { describe, expect, it } from "vitest";
import { resolveProjectRoot, resolveRepo } from "./paths.js";

describe("paths", () => {
  it("resolveProjectRoot honours explicit path", () => {
    expect(resolveProjectRoot("/tmp/x")).toBe("/tmp/x");
  });

  it("resolveProjectRoot honours DEFT_PROJECT_ROOT", () => {
    const prev = process.env.DEFT_PROJECT_ROOT;
    process.env.DEFT_PROJECT_ROOT = "/env/root";
    try {
      expect(resolveProjectRoot(null)).toBe("/env/root");
    } finally {
      if (prev === undefined) delete process.env.DEFT_PROJECT_ROOT;
      else process.env.DEFT_PROJECT_ROOT = prev;
    }
  });

  it("resolveRepo uses flag override", () => {
    expect(resolveRepo("acme/r", "/tmp")).toBe("acme/r");
  });

  it("resolveRepo parses https remote", () => {
    const [ok, repo] = ((): [boolean, string] => {
      const r = resolveRepo(null, "/tmp", {
        spawnText: () => ({
          status: 0,
          stdout: "https://github.com/deftai/directive.git\n",
          stderr: "",
        }),
      });
      return [true, r];
    })();
    expect(ok).toBe(true);
    expect(repo).toBe("deftai/directive");
  });

  it("resolveRepo parses ssh remote", () => {
    const repo = resolveRepo(null, "/tmp", {
      spawnText: () => ({
        status: 0,
        stdout: "git@github.com:org/proj.git\n",
        stderr: "",
      }),
    });
    expect(repo).toBe("org/proj");
  });

  it("resolveRepo falls back on git failure", () => {
    const repo = resolveRepo(null, "/tmp", {
      spawnText: () => ({ status: 1, stdout: "", stderr: "err" }),
    });
    expect(repo).toBe("deftai/directive");
  });

  it("resolveRepo falls back on unparseable url", () => {
    const repo = resolveRepo(null, "/tmp", {
      spawnText: () => ({ status: 0, stdout: "not-a-url\n", stderr: "" }),
    });
    expect(repo).toBe("deftai/directive");
  });

  it("resolveProjectRoot uses framework root by default", () => {
    const prev = process.env.DEFT_PROJECT_ROOT;
    delete process.env.DEFT_PROJECT_ROOT;
    try {
      const root = resolveProjectRoot(null);
      expect(root.length).toBeGreaterThan(0);
    } finally {
      if (prev !== undefined) process.env.DEFT_PROJECT_ROOT = prev;
    }
  });
});
