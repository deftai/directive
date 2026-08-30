import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPythonArtifacts } from "../deposit/python-free.js";
import { stageContentPack } from "../deposit/stage-content-pack.js";

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
  ) as { scripts?: { prepack?: string; postpack?: string } } | null;
  const prepack = manifest?.scripts?.prepack;
  if (typeof prepack !== "string" || prepack.length === 0) {
    throw new Error("packages/content/package.json has no prepack script");
  }
  return prepack;
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
  mkdirSync(join(root, "content", "skills", "deft-directive-setup"), { recursive: true });
  writeFileSync(
    join(root, "content", "skills", "deft-directive-setup", "SKILL.md"),
    "# skill\n",
    "utf8",
  );
  writeFileSync(join(root, "main.md"), "# Deft guidelines\n", "utf8");
  writeFileSync(join(root, "SKILL.md"), "# Deft skill entry\n", "utf8");

  mkdirSync(join(root, ".githooks"), { recursive: true });
  writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\nexit 0\n", "utf8");
  writeFileSync(join(root, ".githooks", "pre-push"), "#!/bin/sh\nexit 0\n", "utf8");
  writeFileSync(join(root, ".githooks", "_deft-run.sh"), 'run_deft() { deft "$@"; }\n', "utf8");
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

function runPrepack(pkgDir: string, root: string): void {
  stageContentPack({ repoRoot: root, destDir: pkgDir });
}

describe("@deftai/directive-content prepack (#1967 / #2022 Phase 3)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names each engine entry it must bundle alongside content/", () => {
    expect(readPrepackScript()).toBe("node ./stage-pack.mjs");
    expect(existsSync(join(process.cwd(), "packages/content/stage-pack.mjs"))).toBe(true);
    const stager = readFileSync(
      join(process.cwd(), "packages/core/src/deposit/stage-content-pack.ts"),
      "utf8",
    );
    for (const entry of REQUIRED_ENGINE_ENTRIES) {
      expect(stager).toContain(entry);
    }
    for (const entry of FORBIDDEN_ENGINE_ENTRIES) {
      expect(stager).not.toContain(`"${entry}"`);
    }
    expect(stager).toContain("main.md");
    expect(stager).toContain("SKILL.md");
  });

  it("copies the content/ tree and root harness entries into the package", () => {
    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    runPrepack(pkgDir, root);
    expect(existsSync(join(pkgDir, "main.md"))).toBe(true);
    expect(readFileSync(join(pkgDir, "main.md"), "utf8")).toContain("# Deft guidelines");
    expect(existsSync(join(pkgDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(pkgDir, "skills", "deft-directive-setup", "SKILL.md"))).toBe(true);
  });

  it("bundles .githooks/, Taskfile.yml, and tasks/ from the repo root", () => {
    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    runPrepack(pkgDir, root);
    expect(existsSync(join(pkgDir, ".githooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(pkgDir, ".githooks", "pre-push"))).toBe(true);
    expect(existsSync(join(pkgDir, ".githooks", "_deft-run.sh"))).toBe(true);
    expect(existsSync(join(pkgDir, "Taskfile.yml"))).toBe(true);
    expect(existsSync(join(pkgDir, "tasks", "swarm.yml"))).toBe(true);
  });

  it("packages a Taskfile with no trailing whitespace (#2595)", () => {
    const sourceTaskfile = readFileSync(join(process.cwd(), "Taskfile.yml"), "utf8");
    expect(sourceTaskfile.match(/[ \t]+$/gm)).toBeNull();

    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    writeFileSync(join(root, "Taskfile.yml"), sourceTaskfile, "utf8");
    runPrepack(pkgDir, root);
    expect(readFileSync(join(pkgDir, "Taskfile.yml"), "utf8").match(/[ \t]+$/gm)).toBeNull();
  });

  it("does not bundle scripts/ or .py files even when present upstream (#2022 Phase 3)", () => {
    const { root, pkgDir } = buildFakeRepo();
    created.push(root);
    runPrepack(pkgDir, root);
    expect(existsSync(join(pkgDir, "scripts"))).toBe(false);
    expect(collectPythonArtifacts(pkgDir)).toEqual([]);
  });

  it("skips an engine entry that is absent from the repo root", () => {
    const { root, pkgDir } = buildFakeRepo({ withScripts: false });
    created.push(root);
    runPrepack(pkgDir, root);
    expect(existsSync(join(pkgDir, "scripts"))).toBe(false);
    expect(existsSync(join(pkgDir, ".githooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(pkgDir, ".githooks", "_deft-run.sh"))).toBe(true);
    expect(existsSync(join(pkgDir, "Taskfile.yml"))).toBe(true);
  });
});
