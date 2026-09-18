import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@deftai/directive-core/check", () => ({
  dispatchTaskCheck: vi.fn(() => 0),
}));

import { dispatchTaskCheck } from "@deftai/directive-core/check";
import { parseArgs, resolveCheckFrameworkRoot, run } from "./check.js";

describe("check CLI", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    vi.mocked(dispatchTaskCheck).mockClear();
  });

  function freshProject(): string {
    const root = mkdtempSync(join(tmpdir(), "check-cli-"));
    created.push(root);
    return root;
  }

  function writeSourceCheckout(project: string): void {
    writeFileSync(join(project, "main.md"), "# Deft\n", "utf8");
    mkdirSync(join(project, "content", "templates"), { recursive: true });
    mkdirSync(join(project, "content", "skills", "deft-directive-build"), { recursive: true });
    writeFileSync(join(project, "content", "templates", "agents-entry.md"), "# agents\n", "utf8");
    writeFileSync(
      join(project, "content", "skills", "deft-directive-build", "SKILL.md"),
      "# build\n",
      "utf8",
    );
  }

  it("parses --no-cache", () => {
    expect(parseArgs(["--framework-root", "/fw", "--project-root", "/proj", "--no-cache"])).toEqual({
      frameworkRoot: resolve("/fw"),
      projectRoot: "/proj",
      noCache: true,
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--wat"]).error).toMatch(/unrecognized argument/);
    const chunks: string[] = [];
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(run(["--wat"])).toBe(2);
    } finally {
      process.stderr.write = prevErr;
    }
    expect(chunks.join("")).toMatch(/unrecognized argument/);
  });

  it("rejects --project-root and --framework-root without a value", () => {
    expect(parseArgs(["--project-root"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--framework-root"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--project-root", "--no-cache"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--framework-root", "--no-cache"]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--project-root="]).error).toMatch(/expected one argument/);
    expect(parseArgs(["--framework-root="]).error).toMatch(/expected one argument/);
  });

  it("parses --project-root= and --framework-root= attached forms", () => {
    vi.stubEnv("DEFT_ROOT", "");
    const project = freshProject();
    const deposit = join(project, ".deft", "core");
    mkdirSync(deposit, { recursive: true });
    const args = parseArgs([`--project-root=${project}`, `--framework-root=${deposit}`]);
    expect(args.error).toBeUndefined();
    expect(args.projectRoot).toBe(project);
    expect(args.frameworkRoot).toBe(deposit);
  });

  it("defaults omitted --project-root to cwd (#4722)", () => {
    vi.stubEnv("DEFT_ROOT", "");
    const args = parseArgs(["--framework-root", "/fw"]);
    expect(args.projectRoot).toBe(process.cwd());
    expect(args.frameworkRoot).toBe(resolve("/fw"));
    expect(args.error).toBeUndefined();
  });

  it("resolves omitted --framework-root from --project-root deposit, not process cwd (#4722)", () => {
    const project = freshProject();
    const deposit = join(project, ".deft", "core");
    mkdirSync(deposit, { recursive: true });
    vi.stubEnv("DEFT_ROOT", "");
    const args = parseArgs(["--project-root", project]);
    expect(args.error).toBeUndefined();
    expect(args.projectRoot).toBe(project);
    expect(args.frameworkRoot).toBe(deposit);
  });

  it("detects legacy deft/ when --framework-root is omitted", () => {
    const project = freshProject();
    const deposit = join(project, "deft");
    mkdirSync(deposit, { recursive: true });
    vi.stubEnv("DEFT_ROOT", "");
    expect(parseArgs(["--project-root", project]).frameworkRoot).toBe(deposit);
  });

  it("prefers a maintainer source checkout over a co-located .deft/core deposit", () => {
    const project = freshProject();
    writeSourceCheckout(project);
    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    vi.stubEnv("DEFT_ROOT", "");
    expect(parseArgs(["--project-root", project]).frameworkRoot).toBe(project);
  });

  it("uses DEFT_ROOT when no explicit --framework-root is supplied", () => {
    const project = freshProject();
    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    vi.stubEnv("DEFT_ROOT", "/tmp/from-env");
    expect(parseArgs(["--project-root", project]).frameworkRoot).toBe(resolve("/tmp/from-env"));
  });

  it("prefers explicit --framework-root over DEFT_ROOT", () => {
    const project = freshProject();
    vi.stubEnv("DEFT_ROOT", "/tmp/from-env");
    expect(
      parseArgs(["--project-root", project, "--framework-root", "/tmp/explicit"]).frameworkRoot,
    ).toBe(resolve("/tmp/explicit"));
  });

  it("fail-closes when no project-root candidate exists (refuses npm-engine last-resort)", () => {
    const project = freshProject();
    vi.stubEnv("DEFT_ROOT", "");
    const args = parseArgs(["--project-root", project]);
    expect(args.error).toBeUndefined();
    expect(args.frameworkRoot).toBeUndefined();
    expect(resolveCheckFrameworkRoot(project)).toBeNull();

    const chunks: string[] = [];
    const prevErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array) => {
      chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(run(["--project-root", project])).toBe(2);
    } finally {
      process.stderr.write = prevErr;
    }
    const err = chunks.join("");
    expect(err).toMatch(/directive init/);
    expect(err).not.toMatch(/are required/);
    expect(vi.mocked(dispatchTaskCheck)).not.toHaveBeenCalled();
  });

  it("dispatches when a consumer deposit exists without --framework-root", () => {
    const project = freshProject();
    const deposit = join(project, ".deft", "core");
    mkdirSync(deposit, { recursive: true });
    vi.stubEnv("DEFT_ROOT", "");
    expect(run(["--project-root", project])).toBe(0);
    expect(vi.mocked(dispatchTaskCheck)).toHaveBeenCalledWith(deposit, project, {
      noCache: undefined,
    });
  });
});
