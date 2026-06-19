import { resolveScriptsDir } from "../release/paths.js";
import { spawnText } from "../release/spawn.js";

/** Invoke release_rollback.main via Python until the TS rollback module lands (#1729). */
export function rollbackMain(argv: string[]): number {
  const scriptsDir = resolveScriptsDir();
  const code = [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "import release_rollback",
    `sys.exit(release_rollback.main(${JSON.stringify(argv)}))`,
  ].join("\n");
  const frameworkRoot = scriptsDir.replace(/[/\\]scripts$/, "") || process.cwd();
  const result = spawnText("uv", ["run", "python", "-c", code], {
    cwd: frameworkRoot,
    env: { ...process.env, PYTHONUTF8: "1" },
    timeoutMs: 300_000,
  });
  return result.status ?? 1;
}
