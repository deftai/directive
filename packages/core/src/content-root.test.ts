import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTENT_DIRNAME,
  CONTENT_PACKAGE_NAME,
  contentRoot,
  resolveContentPackageRoot,
} from "./content-root.js";

describe("contentRoot (#1875 C1 flatten dual-context resolver)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "content-root-"));
    created.push(root);
    return root;
  }

  it("returns the content/ subdir when present (source checkout)", () => {
    const root = freshRoot();
    mkdirSync(join(root, CONTENT_DIRNAME));
    expect(contentRoot(root)).toBe(join(root, CONTENT_DIRNAME));
  });

  it("returns the framework root when content/ is absent (consumer deposit)", () => {
    const root = freshRoot();
    expect(contentRoot(root)).toBe(root);
  });

  it("does not mistake a content file for the content dir", () => {
    const root = freshRoot();
    writeFileSync(join(root, CONTENT_DIRNAME), "not a dir", "utf-8");
    expect(contentRoot(root)).toBe(root);
  });
});

describe("contentRoot three operating modes (#11 S2 / @deftai/directive-content)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshProject(): string {
    const root = mkdtempSync(join(tmpdir(), "content-mode-"));
    created.push(root);
    return root;
  }

  function installContentPackage(projectRoot: string): string {
    writeFileSync(join(projectRoot, "package.json"), '{"name":"fixture-project"}', "utf-8");
    const pkgDir = join(projectRoot, "node_modules", "@deftai", "directive-content");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME, version: "0.0.0" }),
      "utf-8",
    );
    return pkgDir;
  }

  it("in-repo-vendored: prefers the npm content package when installed", () => {
    const project = freshProject();
    const frameworkRoot = join(project, "directive-source");
    mkdirSync(join(frameworkRoot, CONTENT_DIRNAME), { recursive: true });
    const pkgDir = installContentPackage(project);

    expect(contentRoot(frameworkRoot)).toBe(pkgDir);
    expect(resolveContentPackageRoot(frameworkRoot)).toBe(pkgDir);
  });

  it("in-repo-vendored: falls back to content/ when the npm package is absent", () => {
    const project = freshProject();
    const frameworkRoot = join(project, "directive-source");
    mkdirSync(join(frameworkRoot, CONTENT_DIRNAME), { recursive: true });

    expect(contentRoot(frameworkRoot)).toBe(join(frameworkRoot, CONTENT_DIRNAME));
    expect(resolveContentPackageRoot(frameworkRoot)).toBeNull();
  });

  it("hybrid npm-engine: resolves the npm package over a flattened vendored deposit", () => {
    const project = freshProject();
    const frameworkRoot = join(project, ".deft", "core");
    mkdirSync(frameworkRoot, { recursive: true });
    mkdirSync(join(frameworkRoot, "skills"), { recursive: true });
    writeFileSync(join(frameworkRoot, "skills", ".keep"), "", "utf-8");
    const pkgDir = installContentPackage(project);

    expect(contentRoot(frameworkRoot)).toBe(pkgDir);
  });

  it("hybrid npm-engine: falls back to the vendored .deft/core deposit when npm is absent", () => {
    const project = freshProject();
    const frameworkRoot = join(project, ".deft", "core");
    mkdirSync(frameworkRoot, { recursive: true });
    mkdirSync(join(frameworkRoot, "templates"), { recursive: true });
    writeFileSync(join(frameworkRoot, "templates", "agents-entry.md"), "# template", "utf-8");

    expect(contentRoot(frameworkRoot)).toBe(frameworkRoot);
  });

  it("external-workspace: resolves npm content from the project node_modules ancestor", () => {
    const project = freshProject();
    const frameworkRoot = join(project, ".deft", "core");
    mkdirSync(frameworkRoot, { recursive: true });
    const pkgDir = installContentPackage(project);

    expect(contentRoot(frameworkRoot)).toBe(pkgDir);
    expect(resolveContentPackageRoot(join(frameworkRoot, "scripts"))).toBe(pkgDir);
  });

  // Regression: the ancestor walk MUST terminate at the filesystem root on every
  // platform. A non-terminating walk (the Windows drive-root infinite loop the
  // `resolve("/")` comparison caused) would never return, so this test would
  // exceed its timeout and fail CI rather than hang it. The deep starting path
  // also exercises the walk over many ancestor levels.
  it("terminates and returns null from a deep path with no package anywhere", () => {
    const project = freshProject();
    const deep = join(project, ...Array.from({ length: 40 }, (_, i) => `level-${i}`));
    mkdirSync(deep, { recursive: true });

    expect(resolveContentPackageRoot(deep)).toBeNull();
  }, 2000);

  it("terminates when started from the filesystem root itself", () => {
    // From the root, `dirname(root) === root`, so the idempotent-dirname stop
    // condition must break on the first iteration rather than spin.
    expect(resolveContentPackageRoot(parse(tmpdir()).root)).toBeNull();
  }, 2000);
});
