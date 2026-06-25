import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Packaging contract for @deftai/directive-content (#1967).
 *
 * The prepack copies the repo-root content/ tree into the package, but the
 * branch-policy git hooks (.githooks/), the framework Taskfile.yml, and the
 * Taskfile's transitive task fragments (tasks/) + helper scripts (scripts/)
 * live OUTSIDE content/. Before #1967 they never reached the published tree, so
 * a pure-npm `directive init` deposited a .deft/core without .deft/core/.githooks
 * or a resolvable .deft/core/Taskfile.yml. These tests run the REAL prepack from
 * packages/content/package.json against a sandbox repo so a regression that
 * drops an engine dir from the copy set fails here rather than silently in a
 * consumer install.
 */

const REQUIRED_ENGINE_ENTRIES = [".githooks", "Taskfile.yml", "tasks", "scripts"] as const;

function readPrepackScript(): string {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), "packages/content/package.json"), "utf8"),
  ) as { scripts?: { prepack?: string } } | null;
  // JSON.parse can yield a non-throwing top-level null; optional-chain through
  // manifest so a malformed package.json surfaces the explicit error below
  // rather than a bare TypeError.
  const prepack = manifest?.scripts?.prepack;
  if (typeof prepack !== "string" || prepack.length === 0) {
    throw new Error("packages/content/package.json has no prepack script");
  }
  // The command is `node --input-type=module -e "<script>"`; extract the script
  // body so we can run it directly with our own cwd (the prepack resolves the
  // package dir from import.meta.url, which equals cwd under `node -e`).
  const first = prepack.indexOf('"');
  const last = prepack.lastIndexOf('"');
  if (first === -1 || last <= first) {
    throw new Error(`could not parse prepack script body from: ${prepack}`);
  }
  return prepack.slice(first + 1, last);
}

/**
 * Build a fake repo whose layout mirrors the directive root: a content/ tree
 * plus the engine entries the prepack also bundles. `packages/content` is the
 * package dir the prepack runs from (it resolves the repo root via two `..`).
 */
function buildFakeRepo(options: { withScripts?: boolean } = {}): { root: string; pkgDir: string } {
  const root = mkdtempSync(join(tmpdir(), "content-prepack-"));
  const pkgDir = join(root, "packages", "content");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@deftai/directive-content", version: "0.0.0" }),
    "utf8",
  );

  mkdirSync(join(root, "content"), { recursive: true });
  writeFileSync(join(root, "content", "main.md"), "# Deft\n", "utf8");
  mkdirSync(join(root, "content", "skills"), { recursive: true });
  writeFileSync(join(root, "content", "skills", "SKILL.md"), "# skill\n", "utf8");

  mkdirSync(join(root, ".githooks"), { recursive: true });
  writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
  writeFileSync(join(root, ".githooks", "pre-push"), "#!/bin/sh\nexit 0\n", "utf8");
  writeFileSync(join(root, "Taskfile.yml"), "version: '3'\n", "utf8");
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(join(root, "tasks", "swarm.yml"), "version: '3'\n", "utf8");
  if (options.withScripts !== false) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "preflight_branch.py"), "# branch gate\n", "utf8");
    // Compiled bytecode that must NOT ship: a __pycache__ dir (the common case)
    // plus a stray top-level .pyc (exercises the endsWith('.pyc') branch).
    mkdirSync(join(root, "scripts", "__pycache__"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "__pycache__", "preflight_branch.cpython-314.pyc"),
      "\x00bytecode\n",
      "utf8",
    );
    writeFileSync(join(root, "scripts", "legacy.pyc"), "\x00bytecode\n", "utf8");
  }

  return { root, pkgDir };
}

function runPrepack(pkgDir: string): void {
  const result = spawnSync("node", ["--input-type=module", "-e", readPrepackScript()], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  expect(result.status, result.stderr || result.stdout || "").toBe(0);
}

describe("@deftai/directive-content prepack (#1967)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names each engine entry it must bundle alongside content/", () => {
    const script = readPrepackScript();
    for (const entry of REQUIRED_ENGINE_ENTRIES) {
      expect(script).toContain(entry);
    }
  });

  it("copies the content/ tree into the package", () => {
    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    runPrepack(pkgDir);
    expect(existsSync(join(pkgDir, "main.md"))).toBe(true);
    expect(existsSync(join(pkgDir, "skills", "SKILL.md"))).toBe(true);
  });

  it("bundles .githooks/, Taskfile.yml, tasks/, and scripts/ from the repo root", () => {
    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    runPrepack(pkgDir);
    // The deposited .deft/core must carry the branch-policy hooks...
    expect(existsSync(join(pkgDir, ".githooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(pkgDir, ".githooks", "pre-push"))).toBe(true);
    // ...a resolvable Taskfile plus its non-optional task fragments...
    expect(existsSync(join(pkgDir, "Taskfile.yml"))).toBe(true);
    expect(existsSync(join(pkgDir, "tasks", "swarm.yml"))).toBe(true);
    // ...and the helper scripts the hooks invoke at .deft/core/scripts/.
    expect(existsSync(join(pkgDir, "scripts", "preflight_branch.py"))).toBe(true);
  });

  it("excludes __pycache__ directories and .pyc bytecode from the bundle (#1985)", () => {
    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    runPrepack(pkgDir);
    // The .py source is still needed (engine invokes it via the bundled
    // Taskfile until the Python purge #1860)...
    expect(existsSync(join(pkgDir, "scripts", "preflight_branch.py"))).toBe(true);
    // ...but compiled bytecode is pure bloat and must never publish.
    expect(existsSync(join(pkgDir, "scripts", "__pycache__"))).toBe(false);
    expect(existsSync(join(pkgDir, "scripts", "legacy.pyc"))).toBe(false);
  });

  it("skips an engine entry that is absent from the repo root", () => {
    const { root, pkgDir } = buildFakeRepo({ withScripts: false });
    created.push(root);
    runPrepack(pkgDir);
    // scripts/ absent upstream -> tolerated, the rest still land.
    expect(existsSync(join(pkgDir, "scripts"))).toBe(false);
    expect(existsSync(join(pkgDir, ".githooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(pkgDir, "Taskfile.yml"))).toBe(true);
  });
});
