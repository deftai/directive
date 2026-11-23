import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./verify-class-checks.js";

describe("verify-class-checks CLI (#4980)", () => {
  it("parses project-root and base-ref flags", () => {
    const a = parseArgs(["--project-root", ".", "--base-ref", "origin/master", "--quiet"]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe(".");
    expect(a.baseRef).toBe("origin/master");
    expect(a.quiet).toBe(true);
  });

  it("rejects unknown args", () => {
    const a = parseArgs(["--nope"]);
    expect(a.error).toMatch(/unrecognized/);
  });

  it("runs against framework root without config error", () => {
    const code = run(["--project-root", ".", "--quiet"], {});
    expect([0, 1, 2]).toContain(code);
  }, 30_000);
});

describe("verify-class-checks CLI on merge_group (#7147)", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function git(root: string, ...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  }

  function put(root: string, rel: string, text: string): void {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }

  /**
   * base -> story-product commit -> pure protected-landing commit
   * (`.deft/approved-scope/**` only), as a queue group commit stacks them.
   */
  function seed(): { root: string; base: string; product: string } {
    const root = mkdtempSync(join(tmpdir(), "verify-class-checks-7147-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "master");
    put(
      root,
      ".deft/test-boundary.policy.json",
      `${JSON.stringify({ sourceRoots: ["src/**"], testRoots: ["tests/**"] })}\n`,
    );
    put(root, "src/app.ts", "export const x = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    put(root, "src/app.ts", "export const x = 2;\n");
    git(root, "commit", "-q", "-am", "story product");
    const product = git(root, "rev-parse", "HEAD");
    put(root, ".deft/approved-scope/mint.json", "{}\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "protected landing");
    return { root, base, product };
  }

  function capture(argv: string[], env: Record<string, string | undefined>) {
    let out = "";
    let err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    });
    const code = run(argv, env);
    vi.restoreAllMocks();
    return { code, out, err };
  }

  it("skips with the change-set notice and no class finding on merge_group", () => {
    const { root, base } = seed();
    const r = capture(["--project-root", root, "--base-ref", base], {
      GITHUB_EVENT_NAME: "merge_group",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("verify:class-checks: skipped on merge_group");
    expect(r.out).toContain("change-set check");
    expect(r.out).not.toMatch(/already ran/);
    expect(r.out + r.err).not.toContain("class 4");
  }, 30_000);

  it.each([
    ["unset", {}],
    ["pull_request", { GITHUB_EVENT_NAME: "pull_request" }],
  ])(
    "keeps class 4 on the stacked diff with the event %s",
    (_label, env) => {
      const { root, base } = seed();
      const r = capture(["--project-root", root, "--base-ref", base], env);
      expect(r.code).toBe(1);
      expect(r.err).toContain(".deft/approved-scope/mint.json");
      expect(r.err).toContain("class 4");
    },
    30_000,
  );

  it("passes the protected landing alone when the base is the product commit", () => {
    const { root, product } = seed();
    const r = capture(["--project-root", root, "--base-ref", product], {});
    expect(r.code).toBe(0);
  }, 30_000);

  it("exits 2 on an unrecognized argument even on merge_group", () => {
    const r = capture(["--nope"], { GITHUB_EVENT_NAME: "merge_group" });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unrecognized argument/);
  });
});
