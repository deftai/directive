import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFrameworkRootForProject } from "./paths.js";

describe("resolveFrameworkRootForProject (#2146)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  function freshProject(): string {
    const root = mkdtempSync(join(tmpdir(), "framework-root-"));
    created.push(root);
    return root;
  }

  it("prefers an explicit root over the consumer deposit", () => {
    const project = freshProject();
    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    expect(resolveFrameworkRootForProject(project, "/tmp/explicit")).toBe(resolve("/tmp/explicit"));
  });

  it("uses DEFT_ROOT when no explicit root is supplied", () => {
    const project = freshProject();
    vi.stubEnv("DEFT_ROOT", "/tmp/from-env");
    expect(resolveFrameworkRootForProject(project)).toBe(resolve("/tmp/from-env"));
  });

  it("detects a consumer .deft/core deposit before the npm-engine fallback", () => {
    const project = freshProject();
    const deposit = join(project, ".deft", "core");
    mkdirSync(join(deposit, "xbrief", "schemas"), { recursive: true });
    writeFileSync(join(deposit, "QUICK-START.md"), "# qs\n", "utf8");
    expect(resolveFrameworkRootForProject(project)).toBe(deposit);
  });

  it("detects legacy deft/ install root", () => {
    const project = freshProject();
    const deposit = join(project, "deft");
    mkdirSync(deposit, { recursive: true });
    expect(resolveFrameworkRootForProject(project)).toBe(deposit);
  });

  it("prefers a maintainer source checkout over a co-located .deft/core deposit", () => {
    const project = freshProject();
    writeFileSync(join(project, "main.md"), "# Deft\n", "utf8");
    mkdirSync(join(project, "content", "templates"), { recursive: true });
    mkdirSync(join(project, "content", "skills", "deft-directive-build"), { recursive: true });
    writeFileSync(join(project, "content", "templates", "agents-entry.md"), "# agents\n", "utf8");
    writeFileSync(
      join(project, "content", "skills", "deft-directive-build", "SKILL.md"),
      "# build\n",
      "utf8",
    );
    mkdirSync(join(project, ".deft", "core"), { recursive: true });
    expect(resolveFrameworkRootForProject(project)).toBe(project);
  });
});
