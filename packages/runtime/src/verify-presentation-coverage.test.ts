import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseCoverageReport } from "../../core/src/presentation-coverage/report.js";
import { parseArgs, run } from "./verify-presentation-coverage.js";

describe("verify-presentation-coverage CLI (#5079)", () => {
  it("parses project-root, origin-ref, staged, quiet", () => {
    const a = parseArgs([
      "--project-root",
      ".",
      "--origin-ref",
      "origin/master",
      "--quiet",
      "--staged",
    ]);
    expect(a.error).toBeUndefined();
    expect(a.projectRoot).toBe(".");
    expect(a.originRef).toBe("origin/master");
    expect(a.quiet).toBe(true);
    expect(a.staged).toBe(true);
  });

  it("parses selectors and rejects missing option values", () => {
    expect(
      parseArgs([
        "--json",
        "--plan-id",
        "story",
        "--project-root=/tmp/project",
        "--origin-ref=main",
      ]),
    ).toMatchObject({
      json: true,
      planId: "story",
      projectRoot: "/tmp/project",
      originRef: "main",
    });
    for (const option of ["--project-root", "--origin-ref", "--plan-id"]) {
      expect(parseArgs([option])).toHaveProperty("error");
      expect(parseArgs([option, "--quiet"])).toHaveProperty("error");
    }
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(run(["--unknown"])).toBe(2);
    expect(run(["--project-root", "/nonexistent/coverage-project"])).toBe(2);
    expect(errors.mock.calls.flat().join("")).toContain("failed");
    errors.mockRestore();
  });
  it("rejects --base-ref", () => {
    const a = parseArgs(["--base-ref", "origin/master"]);
    expect(a.error).toMatch(/unrecognized argument: --base-ref/);
  });

  it("rejects unknown args", () => {
    const a = parseArgs(["--nope"]);
    expect(a.error).toMatch(/unrecognized/);
  });

  it("emits real off-ceiling and malformed staged-authority JSON outcomes", () => {
    const root = mkdtempSync(join(tmpdir(), "coverage-cli-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      git("init", "--quiet");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.invalid");
      git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Base");
      const base = git("rev-parse", "HEAD").trim();
      expect(run(["--project-root", root, "--origin-ref", base, "--quiet"])).toBe(0);
      expect(run(["--project-root", root, "--origin-ref", base])).toBe(0);
      expect(run(["--project-root", root, "--origin-ref", base, "--json"])).toBe(0);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
        code: 0,
        armed: false,
        coverage: [],
      });
      mkdirSync(join(root, ".deft"));
      writeFileSync(join(root, ".deft", "presentation-ceiling.json"), "{");
      git("add", ".");
      expect(run(["--project-root", root, "--origin-ref", base, "--staged", "--json"])).toBe(2);
      expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ code: 2 });
    } finally {
      output.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it("parses a real cold Task build followed by the source CLI report", { timeout: 20000 }, ({
  skip,
}) => {
  // The TS-only lane does not install Task; the mandatory merge gate does.
  // Only an absent executable skips this integration. A broken install fails.
  const probe = spawnSync("task", ["--version"], { encoding: "utf8", timeout: 3000 });
  if (probe.error && "code" in probe.error && probe.error.code === "ENOENT") {
    skip();
    return;
  }
  const probeDiagnostic = JSON.stringify({
    error: probe.error?.message,
    status: probe.status,
    signal: probe.signal,
    stderr: probe.stderr,
  });
  expect(probe.error, probeDiagnostic).toBeUndefined();
  expect(probe.status, probeDiagnostic).toBe(0);
  const root = mkdtempSync(join(tmpdir(), "coverage-cold-task-"));
  const repo = resolve(import.meta.dirname, "../../..");
  const put = (path: string, text: string) => writeFileSync(join(root, path), text);
  try {
    mkdirSync(join(root, "tasks"));
    mkdirSync(join(root, "packages/cli"), { recursive: true });
    for (const file of [
      "engine.yml",
      "verify.yml",
      "engine-invoke.cjs",
      "engine-pm-run.cjs",
      "ts-build-fresh.cjs",
    ])
      copyFileSync(join(repo, "tasks", file), join(root, "tasks", file));
    put(
      "Taskfile.yml",
      "version: '3'\nincludes:\n  engine: ./tasks/engine.yml\n  verify: ./tasks/verify.yml\n",
    );
    put(
      "package.json",
      JSON.stringify({
        name: "cold-coverage-fixture",
        private: true,
        scripts: { build: "node build.cjs" },
      }),
    );
    put("packages/cli/package.json", "{}");
    put(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: repo,
          paths: {
            "@deftai/directive-core": [join(repo, "packages/core/src/index.ts")],
            "@deftai/directive-core/*": [join(repo, "packages/core/src/*")],
            "@deftai/directive-types": [join(repo, "packages/types/src/index.ts")],
          },
        },
      }),
    );
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    const cli = join(repo, "packages/cli/src/verify-presentation-coverage.ts");
    const shim = `const {spawnSync}=require('node:child_process'); const r=spawnSync(process.execPath, ${JSON.stringify(["--import", loader, cli])}.concat(process.argv.slice(3)), {stdio:'inherit'}); process.exit(r.status ?? 2);`;
    put(
      "build.cjs",
      `const fs=require('node:fs'); console.log('cold build diagnostic'); fs.mkdirSync('packages/cli/dist',{recursive:true}); fs.writeFileSync('packages/cli/dist/bin.js',${JSON.stringify(shim)});`,
    );
    execFileSync("git", ["init", "--quiet", "--template=", root]);
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      ],
      { stdio: "ignore" },
    );
    expect(existsSync(join(root, "packages/cli/dist/bin.js"))).toBe(false);
    const env = {
      ...process.env,
      DEFT_PACKAGE_MANAGER: "npm",
      TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
    };
    delete env.DEFT_SKIP_TS_BUILD;
    const child = spawnSync(
      "task",
      ["--silent", "verify:presentation-coverage", "--", "--origin-ref", "HEAD", "--json"],
      { cwd: root, env, encoding: "utf8", timeout: 15000 },
    );
    const diagnostic = JSON.stringify({
      error: child.error?.message,
      status: child.status,
      signal: child.signal,
      stderr: child.stderr,
    });
    expect(child.error, diagnostic).toBeUndefined();
    expect(child.status, diagnostic).toBe(0);
    expect(child.stdout).toContain("cold build diagnostic");
    expect(existsSync(join(root, "packages/cli/dist/bin.js"))).toBe(true);
    expect(readFileSync(join(root, "packages/cli/dist/bin.js"), "utf8")).toBe(shim);
    expect(parseCoverageReport(child.stdout, child.status ?? 0)).toEqual({
      armed: false,
      coverage: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
