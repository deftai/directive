import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultWhich, spawnText } from "./spawn.js";
import type { ReleaseSeams } from "./types.js";

function runUvPython(
  _scriptsDir: string,
  code: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  seams: ReleaseSeams = {},
): ReturnType<typeof spawnText> {
  const spawn = seams.spawnText ?? spawnText;
  return spawn("uv", ["run", "python", "-c", code], {
    cwd,
    env: { ...env, PYTHONUTF8: "1" },
    timeoutMs: 300_000,
  });
}

export function runCi(
  projectRoot: string,
  scriptsDir: string,
  seams: ReleaseSeams = {},
): [boolean, string] {
  const code = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "import ci_local",
    `sys.exit(ci_local.main(['--root', ${JSON.stringify(projectRoot)}]))`,
  ].join("\n");
  const result = runUvPython(scriptsDir, code, scriptsDir, process.env, seams);
  if (result.status !== 0) {
    return [false, `ci:local failed (exit ${result.status})`];
  }
  return [true, "ran ci:local"];
}

export function refreshRoadmap(
  projectRoot: string,
  scriptsDir: string,
  seams: ReleaseSeams = {},
): [boolean, string] {
  const pending = join(projectRoot, "vbrief", "pending");
  const roadmap = join(projectRoot, "ROADMAP.md");
  const completed = join(projectRoot, "vbrief", "completed");
  const code = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "import roadmap_render",
    `ok, msg = roadmap_render.render_roadmap(${JSON.stringify(pending)}, ${JSON.stringify(roadmap)}, completed_dir=${JSON.stringify(completed)})`,
    "if ok:",
    "    sys.exit(0)",
    "print(msg, file=sys.stderr)",
    "sys.exit(1)",
  ].join("\n");
  const result = runUvPython(scriptsDir, code, projectRoot, process.env, seams);
  if (result.status !== 0) {
    const msg = result.stderr.trim() || result.stdout.trim();
    return [false, `roadmap:render failed: ${msg}`];
  }
  return [true, "ROADMAP.md re-rendered"];
}

export function checkVbriefLifecycleSync(
  projectRoot: string,
  repo: string,
  scriptsDir: string,
  seams: ReleaseSeams = {},
): [boolean, number, string] {
  const code = [
    "import json, sys",
    "from pathlib import Path",
    `scripts_dir = Path(${JSON.stringify(scriptsDir)})`,
    "sys.path.insert(0, str(scripts_dir))",
    "try:",
    "    import reconcile_issues",
    "except ImportError as exc:",
    "    print(json.dumps({'ok': False, 'mismatch_count': -1, 'reason': f'reconcile_issues import failed: {exc}'}))",
    "    sys.exit(0)",
    `project_root = Path(${JSON.stringify(projectRoot)})`,
    `repo = ${JSON.stringify(repo)}`,
    "vbrief_dir = project_root / 'vbrief'",
    "if not vbrief_dir.is_dir():",
    "    print(json.dumps({'ok': False, 'mismatch_count': -1, 'reason': f'vbrief directory not found at {vbrief_dir}'}))",
    "    sys.exit(0)",
    "issue_to_vbriefs = reconcile_issues.scan_vbrief_dir(vbrief_dir)",
    "issue_state_map = reconcile_issues.fetch_issue_states(repo, set(issue_to_vbriefs.keys()), cwd=project_root)",
    "if issue_state_map is None:",
    "    print(json.dumps({'ok': False, 'mismatch_count': -1, 'reason': 'failed to fetch issue states from gh'}))",
    "    sys.exit(0)",
    "report = reconcile_issues.reconcile(issue_to_vbriefs, issue_state_map)",
    "mismatches = [rel for entry in report.get('no_open_issue', []) for rel in entry.get('vbrief_files', []) if not reconcile_issues.is_terminal_lifecycle_path(rel)]",
    "count = len(mismatches)",
    "if count == 0:",
    "    print(json.dumps({'ok': True, 'mismatch_count': 0, 'reason': 'no mismatches'}))",
    "else:",
    "    suffix = ' ...' if count > 5 else ''",
    "    preview = ', '.join(mismatches[:5])",
    "    reason = f'{count} closed-issue vBRIEF(s) not in completed/ or cancelled/: {preview}{suffix}'",
    "    print(json.dumps({'ok': False, 'mismatch_count': count, 'reason': reason}))",
  ].join("\n");
  const result = runUvPython(scriptsDir, code, projectRoot, process.env, seams);
  try {
    const payload = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      mismatch_count: number;
      reason: string;
    };
    return [payload.ok, payload.mismatch_count, payload.reason];
  } catch {
    return [
      false,
      -1,
      `reconcile_issues bridge failed: ${result.stderr.trim() || result.stdout.trim()}`,
    ];
  }
}

export function runBuild(
  projectRoot: string,
  scriptsDir: string,
  version: string | null,
  seams: ReleaseSeams = {},
): [boolean, string] {
  const env = { ...process.env };
  if (version) {
    env.DEFT_RELEASE_VERSION = version;
  } else {
    delete env.DEFT_RELEASE_VERSION;
  }
  const code = [
    "import sys",
    "from pathlib import Path",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "from framework_commands import run_framework_command",
    `root = Path(${JSON.stringify(projectRoot)})`,
    "result = run_framework_command('build', project_root=root, framework_root=root)",
    "sys.exit(result.code)",
  ].join("\n");
  const result = runUvPython(scriptsDir, code, projectRoot, env, seams);
  if (result.status !== 0) {
    return [false, `build failed (exit ${result.status})`];
  }
  const suffix = version ? ` (DEFT_RELEASE_VERSION=${version})` : "";
  return [true, `build ran clean${suffix}`];
}

export function runUvLock(projectRoot: string, seams: ReleaseSeams = {}): [boolean, string] {
  const exists =
    seams.fileExists ??
    ((p: string) => {
      try {
        return existsSync(p) && statSync(p).isFile();
      } catch {
        return false;
      }
    });
  if (!exists(join(projectRoot, "pyproject.toml"))) {
    return [true, "no pyproject.toml; skipping uv lock"];
  }
  const whichUv = seams.whichUv ?? defaultWhich;
  const uvPath = whichUv("uv");
  if (uvPath === null) {
    process.stderr.write(
      "WARNING: uv binary not on PATH; skipping uv.lock regeneration " +
        "(see #774). Run `uv lock` manually before pushing the release tag.\n",
    );
    return [true, "uv binary not on PATH; skipping uv lock"];
  }
  const spawn = seams.spawnText ?? spawnText;
  const result = spawn(uvPath, ["lock"], { cwd: projectRoot, timeoutMs: 300_000 });
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    return [false, `uv lock failed (exit ${result.status}): ${stderr}`];
  }
  return [true, "uv.lock regenerated"];
}
