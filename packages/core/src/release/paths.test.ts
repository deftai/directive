import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_E2E_HELP } from "../release-e2e/constants.js";
import { ROLLBACK_HELP } from "../release-rollback/constants.js";
import { RELEASE_HELP } from "./constants.js";
import { resolveProjectRoot, resolveRepo } from "./paths.js";

/** Repository checkout that holds this module (the old fallback's answer under Vitest). */
const moduleCheckout = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("paths", () => {
  it("resolveProjectRoot honours explicit path", () => {
    expect(resolveProjectRoot("/tmp/x")).toBe(resolve("/tmp/x"));
  });

  it("resolveProjectRoot honours DEFT_PROJECT_ROOT", () => {
    const prev = process.env.DEFT_PROJECT_ROOT;
    process.env.DEFT_PROJECT_ROOT = "/env/root";
    try {
      expect(resolveProjectRoot(null)).toBe(resolve("/env/root"));
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

  describe("default root is the working directory (#6864)", () => {
    const dirs: string[] = [];

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function tempCwd(): string {
      const dir = mkdtempSync(join(tmpdir(), "release-root-cwd-"));
      dirs.push(dir);
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      return dir;
    }

    it("returns a working directory that is not the module checkout", () => {
      vi.stubEnv("DEFT_PROJECT_ROOT", "");
      // The old fallback honoured DEFT_ROOT; point it at the module checkout.
      vi.stubEnv("DEFT_ROOT", moduleCheckout);
      const dir = tempCwd();
      expect(resolve(dir)).not.toBe(resolve(moduleCheckout));
      expect(resolveProjectRoot(null)).toBe(resolve(dir));
    });

    it("keeps --project-root and DEFT_PROJECT_ROOT ahead of the working directory", () => {
      tempCwd();
      vi.stubEnv("DEFT_PROJECT_ROOT", "/env/root");
      expect(resolveProjectRoot(null)).toBe(resolve("/env/root"));
      expect(resolveProjectRoot("/flag/root")).toBe(resolve("/flag/root"));
    });

    // release-publish help is pinned in release-publish/flags.test.ts (class-4 path, part 1).
    it("release, release-rollback and release-e2e --project-root help names the working directory", () => {
      for (const help of [RELEASE_HELP, ROLLBACK_HELP, RELEASE_E2E_HELP]) {
        const line = help.slice(help.indexOf("--project-root PATH "));
        expect(line).toMatch(
          /^--project-root PATH\s+Repository root \(default: \$DEFT_PROJECT_ROOT, else the\s+current working directory\)\./,
        );
      }
    });
  });
});
