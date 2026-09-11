import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPythonArtifacts, isRepoRootPythonRunShim } from "../deposit/python-free.js";
import { defaultWhich, spawnText } from "../release/spawn.js";
import { NPM_PUBLISH_PACKAGES } from "./constants.js";
import { alignNpmPackageVersions, resolvePnpm } from "./npm-ops.js";
import type { E2ESeams } from "./types.js";

const SMOKE_VERSION = "9.9.9-smoke";

function pythonFreePathEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pathKey = base.PATH !== undefined ? "PATH" : base.Path !== undefined ? "Path" : "PATH";
  const current = base[pathKey] ?? "";
  const filtered = current
    .split(":")
    .filter((entry) => !/(^|\/)python[0-9]*(?:\.\d+)?$/.test(entry))
    .filter((entry) => !entry.includes("/pyenv/"))
    .join(":");
  return {
    ...base,
    [pathKey]: filtered,
    DEFT_PYTHON: "",
    PYTHON: "",
  };
}

const VALID_DOCS_IMPACT_BODY =
  "## Documentation impact\n\n" +
  "change_class: none\n" +
  "surfaces: none\n" +
  'rationale: "Packed-consumer smoke fixture; no closed user-doc surface added or removed."\n';

function looksLikeModuleNotFound(text: string): boolean {
  return text.includes("MODULE_NOT_FOUND") || text.includes("Cannot find module");
}

function runGitStep(
  spawn: typeof spawnText,
  gitBin: string,
  args: readonly string[],
  projectDir: string,
  env: NodeJS.ProcessEnv,
): [boolean, string] {
  const result = spawn(gitBin, args, { cwd: projectDir, env, timeoutMs: 30_000 });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return [false, `git ${args.join(" ")} failed (exit ${result.status}): ${detail.slice(-400)}`];
  }
  return [true, "ok"];
}

/**
 * Packed-consumer docs-impact invoke (#4356): after init, run
 * `task deft:verify:docs-impact -- --body-file` against a fixture.
 * Git fixture is init plus origin/master (or equivalent remote-tracking ref).
 */
export function runConsumerDocsImpactSmoke(
  spawn: typeof spawnText,
  options: {
    taskBin: string;
    gitBin: string | null;
    projectDir: string;
    env: NodeJS.ProcessEnv;
    onProgress?: (message: string) => void;
  },
): [boolean, string] {
  const { taskBin, gitBin, projectDir, env, onProgress } = options;
  const invalidBody = join(projectDir, "docs-impact-invalid.md");
  const validBody = join(projectDir, "docs-impact-valid.md");
  writeFileSync(invalidBody, "## Summary\nempty declaration\n", "utf8");

  onProgress?.("greenfield smoke: task deft:verify:docs-impact (invalid body)");
  const invalid = spawn(taskBin, ["deft:verify:docs-impact", "--", "--body-file", invalidBody], {
    cwd: projectDir,
    env,
    timeoutMs: 60_000,
  });
  const invalidText = `${invalid.stderr}\n${invalid.stdout}`;
  if (looksLikeModuleNotFound(invalidText)) {
    return [
      false,
      `task deft:verify:docs-impact still hits MODULE_NOT_FOUND (source-tree node path): ${invalidText.trim().slice(-800)}`,
    ];
  }
  if (invalid.status === 0) {
    return [
      false,
      "task deft:verify:docs-impact passed an invalid body (expected semantic failure)",
    ];
  }

  if (!gitBin) {
    return [
      false,
      "greenfield smoke: git not on PATH; cannot create origin/master fixture for docs-impact",
    ];
  }

  onProgress?.("greenfield smoke: seeding origin/master git fixture for docs-impact");
  // Always init inside projectDir so an ancestor worktree (TMPDIR under a
  // checkout) is never the git root for checkout/commit/update-ref (#4356).
  const gitEnv = {
    ...env,
    GIT_DIR: join(projectDir, ".git"),
    GIT_WORK_TREE: projectDir,
  };
  const [initOk, initReason] = runGitStep(
    spawn,
    gitBin,
    ["init", "-b", "master"],
    projectDir,
    gitEnv,
  );
  if (!initOk) return [false, `docs-impact git fixture: ${initReason}`];
  for (const [args, label] of [
    [["checkout", "-B", "master"], "checkout master"],
    [["config", "user.email", "smoke@example.com"], "user.email"],
    [["config", "user.name", "greenfield-smoke"], "user.name"],
    [["add", "-A"], "add"],
    [["commit", "--allow-empty", "-m", "docs-impact fixture"], "commit"],
    [["update-ref", "refs/remotes/origin/master", "HEAD"], "origin/master"],
    // Leave HEAD off master/main so later task deft:check verify:branch passes.
    [["checkout", "-B", "feat/docs-impact-smoke"], "feature branch"],
  ] as const) {
    const [ok, reason] = runGitStep(spawn, gitBin, args, projectDir, gitEnv);
    if (!ok) return [false, `docs-impact git fixture (${label}): ${reason}`];
  }

  writeFileSync(validBody, VALID_DOCS_IMPACT_BODY, "utf8");
  onProgress?.(
    "greenfield smoke: task deft:verify:docs-impact (valid body, origin/master fixture)",
  );
  const valid = spawn(taskBin, ["deft:verify:docs-impact", "--", "--body-file", validBody], {
    cwd: projectDir,
    env,
    timeoutMs: 60_000,
  });
  const validText = `${valid.stderr}\n${valid.stdout}`;
  if (looksLikeModuleNotFound(validText)) {
    return [
      false,
      `task deft:verify:docs-impact valid body hits MODULE_NOT_FOUND: ${validText.trim().slice(-800)}`,
    ];
  }
  if (valid.status !== 0) {
    return [
      false,
      `task deft:verify:docs-impact valid body failed (exit ${valid.status}): ${validText.trim().slice(-800)}`,
    ];
  }
  return [
    true,
    "task deft:verify:docs-impact --body-file passed after init with origin/master fixture",
  ];
}

function seedMinimalProjectDefinition(projectDir: string): void {
  const vbriefDir = join(projectDir, "vbrief");
  mkdirSync(vbriefDir, { recursive: true });
  writeFileSync(
    join(vbriefDir, "PROJECT-DEFINITION.vbrief.json"),
    `${JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6", description: "greenfield smoke fixture (#2022 Phase 3)" },
        plan: {
          title: "PROJECT-DEFINITION",
          status: "running",
          items: [],
          policy: {},
          narratives: {
            Overview: "Greenfield smoke fixture (#2022 Phase 3).",
            "tech stack": "Node.js",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function packTarballPath(packDir: string, pkgDir: string): string | null {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    return null;
  }
  const scoped = manifest.name.replaceAll("@", "").replaceAll("/", "-");
  return join(packDir, `${scoped}-${manifest.version}.tgz`);
}

function runStep(
  spawn: typeof spawnText,
  label: string,
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  onProgress?: (message: string) => void,
): [boolean, string] {
  onProgress?.(`greenfield smoke: ${label} — starting`);
  const startedMs = Date.now();
  const result = spawn(cmd, args, options);
  const elapsedMs = Date.now() - startedMs;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    const timeoutHint =
      options.timeoutMs !== undefined && result.status === 128
        ? `; subprocess killed after ${elapsedMs}ms (spawn budget ${options.timeoutMs}ms — likely hang or timeout)`
        : "";
    onProgress?.(
      `greenfield smoke: ${label} — failed (exit ${result.status}) after ${elapsedMs}ms`,
    );
    return [
      false,
      `${label} failed (exit ${result.status})${timeoutHint}: ${detail.slice(-800) || "(no captured output)"}`,
    ];
  }
  onProgress?.(`greenfield smoke: ${label} — OK (${elapsedMs}ms)`);
  return [true, `${label} OK`];
}

export interface GreenfieldSmokeSeams extends E2ESeams {}

export interface GreenfieldSmokeOptions {
  skipWorkspacePrep?: boolean;
  /** Emits step progress immediately (stderr in CLI) so CI logs are never empty on hang (#2554). */
  onProgress?: (message: string) => void;
}

/**
 * Greenfield npm smoke (#2022 Phase 3): pack/install directive, run init +
 * task check in a Python-free PATH, and assert the deposit carries no Python.
 */
export function rehearseGreenfieldPythonFreeSmoke(
  repoRoot: string,
  seams: GreenfieldSmokeSeams = {},
  options: GreenfieldSmokeOptions = {},
): [boolean, string] {
  const which = seams.which ?? seams.whichGh ?? defaultWhich;
  const npm = which("npm");
  if (!npm) {
    return [true, "SKIP greenfield-python-free-smoke: npm not on PATH"];
  }
  const task = which("task");
  if (!task) {
    return [true, "SKIP greenfield-python-free-smoke: task (go-task) not on PATH"];
  }
  const pnpmPrefix = resolvePnpm(seams);
  if (!pnpmPrefix || pnpmPrefix.length === 0) {
    return [false, "greenfield-python-free-smoke FAIL: neither pnpm nor corepack on PATH"];
  }
  const [pnpmCmd, ...pnpmArgs] = pnpmPrefix;
  if (pnpmCmd === undefined) {
    return [false, "greenfield-python-free-smoke FAIL: pnpm command prefix is empty"];
  }

  const spawn = seams.spawnText ?? spawnText;
  const onProgress = options.onProgress;
  onProgress?.("greenfield smoke: workspace prep starting");

  const work = mkdtempSync(join(tmpdir(), "deft-greenfield-smoke-"));
  const packDir = join(work, "packs");
  mkdirSync(packDir, { recursive: true });
  const projectDir = join(work, "project");
  const npmPrefix = join(work, "npm-prefix");
  const envBase = { ...process.env, npm_config_prefix: npmPrefix };
  const manifestBackup = new Map<string, string>();
  for (const pkg of NPM_PUBLISH_PACKAGES) {
    const manifestPath = join(repoRoot, "packages", pkg, "package.json");
    if (existsSync(manifestPath)) {
      manifestBackup.set(manifestPath, readFileSync(manifestPath, "utf8"));
    }
  }

  try {
    let ok: boolean;
    let reason: string;

    if (!options.skipWorkspacePrep) {
      [ok, reason] = runStep(
        spawn,
        "pnpm install",
        pnpmCmd,
        [...pnpmArgs, "install", "--frozen-lockfile"],
        {
          cwd: repoRoot,
          env: envBase,
          timeoutMs: 120_000,
        },
        onProgress,
      );
      if (!ok) return [false, `greenfield smoke: ${reason}`];

      [ok, reason] = runStep(
        spawn,
        "pnpm build",
        pnpmCmd,
        [...pnpmArgs, "run", "build"],
        {
          cwd: repoRoot,
          env: envBase,
          timeoutMs: 120_000,
        },
        onProgress,
      );
      if (!ok) return [false, `greenfield smoke: ${reason}`];
    } else {
      onProgress?.("greenfield smoke: skipping workspace prep (DEFT_GREENFIELD_SKIP_PREP=1)");
    }

    onProgress?.("greenfield smoke: aligning npm package versions");
    [ok, reason] = alignNpmPackageVersions(repoRoot, SMOKE_VERSION);
    if (!ok) return [false, `greenfield smoke: ${reason}`];

    const packed: string[] = [];
    for (const pkg of NPM_PUBLISH_PACKAGES) {
      const pkgDir = join(repoRoot, "packages", pkg);
      [ok, reason] = runStep(
        spawn,
        `npm pack packages/${pkg}`,
        npm,
        ["pack", "--pack-destination", packDir],
        { cwd: pkgDir, env: envBase, timeoutMs: 120_000 },
        onProgress,
      );
      if (!ok) return [false, `greenfield smoke: ${reason}`];
      const tgz = packTarballPath(packDir, pkgDir);
      if (!tgz || !existsSync(tgz)) {
        return [false, `greenfield smoke: missing pack tarball for ${pkg}`];
      }
      packed.push(tgz);
    }

    [ok, reason] = runStep(
      spawn,
      "npm install -g",
      npm,
      ["install", "-g", ...packed],
      {
        env: envBase,
        timeoutMs: 120_000,
      },
      onProgress,
    );
    if (!ok) return [false, `greenfield smoke: ${reason}`];

    const deft = join(npmPrefix, "bin", "deft");
    if (!existsSync(deft)) {
      return [false, `greenfield smoke: expected global deft at ${deft}`];
    }

    const pyFree = pythonFreePathEnv(envBase);
    const installedBin = join(npmPrefix, "bin");
    const installedEnv = {
      ...pyFree,
      PATH: `${installedBin}:${pyFree.PATH ?? ""}`,
    };
    [ok, reason] = runStep(
      spawn,
      "directive init",
      deft,
      ["init", "--yes", "--repo-root", projectDir],
      {
        cwd: work,
        env: installedEnv,
        timeoutMs: 120_000,
      },
      onProgress,
    );
    if (!ok) return [false, `greenfield smoke: ${reason}`];

    onProgress?.("greenfield smoke: seeding fixture PROJECT-DEFINITION");
    seedMinimalProjectDefinition(projectDir);

    const depositDir = join(projectDir, ".deft", "core");
    const artifacts = collectPythonArtifacts(depositDir);
    if (artifacts.length > 0) {
      return [
        false,
        `greenfield smoke: deposit still contains Python artifacts: ${artifacts.map((a) => a.path).join(", ")}`,
      ];
    }
    if (isRepoRootPythonRunShim(projectDir)) {
      return [false, "greenfield smoke: repo-root Python run shim present after init"];
    }

    const checkEnv = {
      ...installedEnv,
      DEFT_SESSION_RITUAL_SKIP: "1",
    };

    [ok, reason] = runConsumerDocsImpactSmoke(spawn, {
      taskBin: task,
      gitBin: which("git"),
      projectDir,
      env: checkEnv,
      onProgress,
    });
    if (!ok) return [false, `greenfield smoke: ${reason}`];

    onProgress?.("greenfield smoke: running consumer task deft:check (engine-invoke path)");
    [ok, reason] = runStep(
      spawn,
      "task deft:check",
      task,
      ["deft:check"],
      {
        cwd: projectDir,
        env: checkEnv,
        timeoutMs: 180_000,
      },
      onProgress,
    );
    if (!ok) return [false, `greenfield smoke: ${reason}`];

    onProgress?.("greenfield smoke: all steps passed");
    return [
      true,
      "greenfield-python-free-smoke: directive init + verify:docs-impact --body-file + task deft:check passed with Python absent from PATH",
    ];
  } finally {
    for (const [manifestPath, contents] of manifestBackup) {
      writeFileSync(manifestPath, contents, "utf8");
    }
    if (process.env.DEFT_GREENFIELD_KEEP_WORK !== "1") {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
