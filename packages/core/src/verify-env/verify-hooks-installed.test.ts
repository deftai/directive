import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "./verify-hooks-installed.js";

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps) {
    rmSync(temp, { recursive: true, force: true });
  }
  temps.length = 0;
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-hooks-"));
  temps.push(root);
  return root;
}

function makeHooks(root: string, rel = ".githooks"): string {
  const hooks = join(root, rel);
  mkdirSync(hooks, { recursive: true });
  for (const name of ["pre-commit", "pre-push"]) {
    const hook = join(hooks, name);
    writeFileSync(hook, "#!/usr/bin/env sh\n", "utf8");
    chmodSync(hook, 0o755);
  }
  return hooks;
}

function makeScripts(root: string, rel = "scripts"): void {
  const scripts = join(root, rel);
  mkdirSync(scripts, { recursive: true });
  for (const name of ["preflight_branch.py", "verify_encoding.py", "preflight_gh.py"]) {
    writeFileSync(join(scripts, name), "# gate\n", "utf8");
  }
}

describe("evaluate", () => {
  it("passes for functional own-repo layout", () => {
    const root = makeRepo();
    makeHooks(root);
    makeScripts(root);
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: ".githooks", error: null }),
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain("installed and functional");
  });

  it("returns config error for missing project root", () => {
    const root = makeRepo();
    const result = evaluate(join(root, "missing"), {
      gitConfigReader: () => ({ hooksPath: null, error: null }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("does not exist");
  });

  it("returns not installed when hooks path unset", () => {
    const root = makeRepo();
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: null, error: null }),
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain("not installed");
  });

  it("returns config error when git unavailable", () => {
    const root = makeRepo();
    const result = evaluate(root, {
      gitConfigReader: () => ({ hooksPath: null, error: "git executable not found on PATH" }),
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("cannot read core.hooksPath");
  });
});
