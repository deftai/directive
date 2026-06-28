import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPythonArtifacts } from "../deposit/python-free.js";

/**
 * Packaging contract for @deftai/directive-content (#1967, #2022 Phase 3).
 *
 * The prepack copies the repo-root content/ tree into the package, but the
 * branch-policy git hooks (.githooks/), the framework Taskfile.yml, and the
 * Taskfile's transitive task fragments (tasks/) live OUTSIDE content/. Before
 * #1967 they never reached the published tree; #1984 briefly bundled scripts/
 * for hook helpers. Phase 3 (#2022) drops Python entirely — scripts/ must not
 * publish and .py files are filtered at copy time.
 */

const REQUIRED_ENGINE_ENTRIES = [".githooks", "Taskfile.yml", "tasks"] as const;
const FORBIDDEN_ENGINE_ENTRIES = ["scripts"] as const;

function readPrepackScript(): string {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), "packages/content/package.json"), "utf8"),
  ) as { scripts?: { prepack?: string } } | null;
  const prepack = manifest?.scripts?.prepack;
  if (typeof prepack !== "string" || prepack.length === 0) {
    throw new Error("packages/content/package.json has no prepack script");
  }
  const first = prepack.indexOf('"');
  const last = prepack.lastIndexOf('"');
  if (first === -1 || last <= first) {
    throw new Error(`could not parse prepack script body from: ${prepack}`);
  }
  return prepack.slice(first + 1, last);
}

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

describe("@deftai/directive-content prepack (#1967 / #2022 Phase 3)", () => {
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
    for (const entry of FORBIDDEN_ENGINE_ENTRIES) {
      expect(script).not.toContain(`'${entry}'`);
    }
  });

  it("copies the content/ tree into the package", () => {
    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    runPrepack(pkgDir);
    expect(existsSync(join(pkgDir, "main.md"))).toBe(true);
    expect(existsSync(join(pkgDir, "skills", "SKILL.md"))).toBe(true);
  });

  it("bundles .githooks/, Taskfile.yml, and tasks/ from the repo root", () => {
    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    runPrepack(pkgDir);
    expect(existsSync(join(pkgDir, ".githooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(pkgDir, ".githooks", "pre-push"))).toBe(true);
    expect(existsSync(join(pkgDir, "Taskfile.yml"))).toBe(true);
    expect(existsSync(join(pkgDir, "tasks", "swarm.yml"))).toBe(true);
  });

  it("does not bundle scripts/ or .py files even when present upstream (#2022 Phase 3)", () => {
    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    runPrepack(pkgDir);
    expect(existsSync(join(pkgDir, "scripts"))).toBe(false);
    expect(collectPythonArtifacts(pkgDir)).toEqual([]);
  });

  it("skips an engine entry that is absent from the repo root", () => {
    const { root, pkgDir } = buildFakeRepo({ withScripts: false });
    created.push(root);
    runPrepack(pkgDir);
    expect(existsSync(join(pkgDir, "scripts"))).toBe(false);
    expect(existsSync(join(pkgDir, ".githooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(pkgDir, "Taskfile.yml"))).toBe(true);
  });
});
