/**
 * #4429 Expected #4: commit-then-fresh-clone harness.
 *
 * Not an assertion add on greenfield-python-free-smoke.ts. After executing
 * init, a commit + clone must carry the canonical pin and not carry
 * `.deft/core/` (gitignored). Reconstitution is then possible from the pin.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT_PACKAGE_NAME } from "../deposit/resolve-content.js";
import { buildHeadlessManifest } from "./headless-manifest.js";
import { runInitDeposit } from "./init-deposit.js";
import { ensurePackageJsonPin, PIN_DEPENDENCY_NAME } from "./scaffold.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  created.push(root);
  return root;
}

function installFakeContentPackage(projectRoot: string): string {
  const pkgDir = join(projectRoot, "node_modules", "@deftai", "directive-content");
  mkdirSync(join(pkgDir, "templates"), { recursive: true });
  mkdirSync(join(pkgDir, "vbrief", "schemas"), { recursive: true });
  mkdirSync(join(pkgDir, ".githooks"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: CONTENT_PACKAGE_NAME, version: "0.53.0" }),
    "utf8",
  );
  copyFileSync(
    join(process.cwd(), "content/templates/agents-entry.md"),
    join(pkgDir, "templates/agents-entry.md"),
  );
  writeFileSync(join(pkgDir, "main.md"), "# Deft\n", "utf8");
  writeFileSync(join(pkgDir, "vbrief", "schemas", "cache-meta.schema.json"), "{}\n", "utf8");
  writeFileSync(join(pkgDir, "vbrief", "schemas", "xbrief-core-0.8.schema.json"), "{}\n", "utf8");
  writeFileSync(join(pkgDir, "vbrief", "vbrief.md"), "# vbrief\n", "utf8");
  writeFileSync(
    join(pkgDir, ".githooks", "pre-commit"),
    readFileSync(join(process.cwd(), ".githooks/pre-commit"), "utf8"),
    "utf8",
  );
  chmodSync(join(pkgDir, ".githooks", "pre-commit"), 0o755);
  writeFileSync(
    join(pkgDir, ".githooks", "pre-push"),
    readFileSync(join(process.cwd(), ".githooks/pre-push"), "utf8"),
    "utf8",
  );
  chmodSync(join(pkgDir, ".githooks", "pre-push"), 0o755);
  writeFileSync(
    join(pkgDir, ".githooks", "_deft-run.sh"),
    readFileSync(join(process.cwd(), ".githooks/_deft-run.sh"), "utf8"),
    "utf8",
  );
  writeFileSync(join(pkgDir, "Taskfile.yml"), "version: '3'\n", "utf8");
  return pkgDir;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.dev",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.dev",
    },
  });
}

describe("greenfield pin clone harness (#4429)", () => {
  it("every greenfield surface emits the same canonical pin", async () => {
    const pinDir = freshRoot("greenfield-pin-ref-");
    ensurePackageJsonPin(pinDir, "0.53.0", { printf: () => {} });
    const executing = JSON.parse(readFileSync(join(pinDir, "package.json"), "utf8")) as {
      private?: boolean;
      devDependencies?: Record<string, string>;
    };

    const contentRoot = freshRoot("greenfield-pin-headless-content-");
    writeFileSync(
      join(contentRoot, "package.json"),
      JSON.stringify({ name: CONTENT_PACKAGE_NAME, version: "0.53.0" }),
      "utf8",
    );
    mkdirSync(join(contentRoot, "templates"), { recursive: true });
    writeFileSync(
      join(contentRoot, "templates", "agents-entry.md"),
      "# Deft\n\n<!-- deft:managed-section v3 -->\n# m\n<!-- /deft:managed-section -->\n",
      "utf8",
    );
    const manifest = await buildHeadlessManifest({
      resolveContentRoot: async () => contentRoot,
      nowIso: () => "2026-09-13T00:00:00Z",
      newSession: () => "pin-invariant",
    });
    const headlessFile = manifest.files.find((f) => f.path === "package.json");
    expect(headlessFile).toBeDefined();
    const headless = JSON.parse(headlessFile?.content ?? "{}") as {
      private?: boolean;
      devDependencies?: Record<string, string>;
    };

    expect(executing.private).toBe(true);
    expect(headless.private).toBe(true);
    expect(executing.devDependencies?.[PIN_DEPENDENCY_NAME]).toBe("0.53.0");
    expect(headless.devDependencies?.[PIN_DEPENDENCY_NAME]).toBe("0.53.0");
  });

  it("after init + commit + fresh clone, the pin is present and .deft/core is reconstitutable", async () => {
    const project = freshRoot("greenfield-pin-clone-src-");
    const contentRoot = installFakeContentPackage(project);

    await runInitDeposit(
      { projectDir: project, jsonOut: false, nonInteractive: true },
      { printf: () => {} },
      {
        resolveContentRoot: async () => contentRoot,
        gitHooks: { getHooksPath: () => "", setHooksPath: () => true },
      },
    );

    git(project, ["init", "-q"]);
    git(project, ["config", "user.email", "t@t.dev"]);
    git(project, ["config", "user.name", "t"]);
    git(project, ["add", "-A"]);
    git(project, ["commit", "-q", "-m", "greenfield init"]);

    const cloneParent = freshRoot("greenfield-pin-clone-dst-");
    const cloneDir = join(cloneParent, "clone");
    git(cloneParent, ["clone", "-q", project, cloneDir]);

    const pkg = JSON.parse(readFileSync(join(cloneDir, "package.json"), "utf8")) as {
      private?: boolean;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.devDependencies?.[PIN_DEPENDENCY_NAME]).toBe("0.53.0");
    expect(readFileSync(join(cloneDir, ".gitignore"), "utf8")).toContain(".deft/core/");
    expect(existsSync(join(cloneDir, ".deft", "core"))).toBe(false);
    expect(existsSync(join(project, ".deft", "core", "main.md"))).toBe(true);
  }, 20_000);
});
