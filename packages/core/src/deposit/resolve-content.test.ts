import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTENT_PACKAGE_NAME,
  ContentPackageNotFoundError,
  contentPackageRootFromResolvedEntry,
  resolveInstalledContentRoot,
} from "./resolve-content.js";

describe("resolveInstalledContentRoot", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "resolve-content-"));
    created.push(root);
    return root;
  }

  function installContentPackage(projectRoot: string): string {
    const pkgDir = join(projectRoot, "node_modules", "@deftai", "directive-content");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME, version: "0.0.0" }),
      "utf-8",
    );
    writeFileSync(join(pkgDir, "main.md"), "# content", "utf-8");
    return pkgDir;
  }

  it("returns the package root when resolution succeeds", async () => {
    const project = freshRoot();
    const pkgDir = installContentPackage(project);

    const root = await resolveInstalledContentRoot(async () => join(pkgDir, "package.json"));
    expect(root).toBe(pkgDir);
  });

  it("resolves via the package.json subpath when the package ships no entry point (#2023)", async () => {
    const project = freshRoot();
    const pkgDir = installContentPackage(project);

    // The content package ships no main, exports, or index.js, so a bare-specifier
    // resolve throws (the #2023 abort). The package.json subpath always resolves.
    const resolveSpecifier = async (specifier: string): Promise<string> => {
      if (specifier === CONTENT_PACKAGE_NAME) {
        throw new Error(
          `Cannot find module '${CONTENT_PACKAGE_NAME}'. ` +
            "The package has no main, exports, or index.js entry point.",
        );
      }
      if (specifier === `${CONTENT_PACKAGE_NAME}/package.json`) {
        return join(pkgDir, "package.json");
      }
      throw new Error(`unexpected specifier: ${specifier}`);
    };

    const root = await resolveInstalledContentRoot(resolveSpecifier);
    expect(root).toBe(pkgDir);
  });

  it("finds the package root when resolution lands on an nested entry file", async () => {
    const project = freshRoot();
    const pkgDir = installContentPackage(project);
    const nested = join(pkgDir, "skills", "example");
    mkdirSync(nested, { recursive: true });
    const skillFile = join(nested, "SKILL.md");
    writeFileSync(skillFile, "# skill", "utf-8");

    const root = await resolveInstalledContentRoot(async () => skillFile);
    expect(root).toBe(pkgDir);
  });

  it("rejects an uninstalled package with an actionable error", async () => {
    await expect(
      resolveInstalledContentRoot(async () => {
        throw new Error("Cannot find package '@deftai/directive-content'");
      }),
    ).rejects.toMatchObject({
      name: "ContentPackageNotFoundError",
      message: expect.stringContaining("@deftai/directive-runtime"),
    });
  });

  it("rejects when resolution succeeds but the package name does not match", async () => {
    const project = freshRoot();
    const bogus = join(project, "node_modules", "other", "package");
    mkdirSync(bogus, { recursive: true });
    writeFileSync(join(bogus, "package.json"), JSON.stringify({ name: "other-pkg" }), "utf-8");

    await expect(
      resolveInstalledContentRoot(async () => join(bogus, "package.json")),
    ).rejects.toBeInstanceOf(ContentPackageNotFoundError);
  });

  it("falls back to @deftai/directive-runtime when content package is absent (hoisted)", async () => {
    const project = freshRoot();
    const runtimeDir = join(project, "node_modules", "@deftai", "directive-runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "package.json"),
      JSON.stringify({ name: "@deftai/directive-runtime", version: "0.0.0" }),
      "utf-8",
    );
    mkdirSync(join(runtimeDir, "templates"), { recursive: true });
    writeFileSync(join(runtimeDir, "templates", "agents-entry.md"), "# agents", "utf-8");

    const resolveSpecifier = async (specifier: string): Promise<string> => {
      if (specifier.startsWith("@deftai/directive-content")) {
        throw new Error("Cannot find package '@deftai/directive-content'");
      }
      if (specifier === "@deftai/directive-runtime/package.json") {
        return join(runtimeDir, "package.json");
      }
      throw new Error(`unexpected specifier: ${specifier}`);
    };

    const root = await resolveInstalledContentRoot(resolveSpecifier);
    expect(root).toBe(runtimeDir);
  });
});

describe("contentPackageRootFromResolvedEntry", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips package.json files whose JSON root is null", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-entry-null-"));
    created.push(root);
    const pkgDir = join(root, "node_modules", "@deftai", "directive-content");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(root, "package.json"), "null", "utf-8");
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME }),
      "utf-8",
    );

    expect(contentPackageRootFromResolvedEntry(join(pkgDir, "package.json"))).toBe(pkgDir);
  });

  it("returns the directory when resolved entry is package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "resolve-entry-"));
    created.push(root);
    const pkgDir = join(root, "node_modules", "@deftai", "directive-content");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME }),
      "utf-8",
    );

    expect(contentPackageRootFromResolvedEntry(join(pkgDir, "package.json"))).toBe(pkgDir);
  });
});
