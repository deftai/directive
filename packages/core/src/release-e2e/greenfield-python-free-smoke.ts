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
    [ok, reason] = runStep(
      spawn,
      "directive init",
      deft,
      ["init", "--yes", "--repo-root", projectDir],
      {
        cwd: work,
        env: pyFree,
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
      ...pyFree,
      PATH: `${join(npmPrefix, "bin")}:${pyFree.PATH ?? ""}`,
      DEFT_SESSION_RITUAL_SKIP: "1",
    };

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
      "greenfield-python-free-smoke: directive init + task deft:check passed with Python absent from PATH",
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
