import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./_helpers.js";

const taskAvailable = (() => {
  try {
    execSync("task --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const CANONICAL = ["release", "release:e2e", "release:publish", "release:rollback"] as const;
const DOUBLED = [
  "release:release",
  "release:release:e2e",
  "release:release:publish",
  "release:release:rollback",
] as const;

function listAllTaskNames(): string[] {
  const out = execFileSync("task", ["-t", join(repoRoot(), "Taskfile.yml"), "--list-all"], {
    cwd: repoRoot(),
    encoding: "utf8",
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  const names: string[] = [];
  for (const line of out.split("\n")) {
    const stripped = line.trim();
    if (!stripped.startsWith("* ")) continue;
    const rest = stripped.slice(2);
    const idx = rest.indexOf(":  ");
    names.push(idx === -1 ? rest.replace(/:$/, "") : rest.slice(0, idx));
  }
  return names;
}

describe("test_taskfile_release_names.py", () => {
  it.skipIf(!taskAvailable)("test_canonical_release_task_names_installed", () => {
    const names = listAllTaskNames();
    const missing = CANONICAL.filter((n) => !names.includes(n));
    expect(missing).toEqual([]);
  });

  it.skipIf(!taskAvailable)("test_doubled_release_prefix_names_not_installed", () => {
    const names = new Set(listAllTaskNames());
    const offenders = DOUBLED.filter((n) => names.has(n));
    expect(offenders).toEqual([]);
  });

  it.skipIf(!taskAvailable)("test_task_release_help_dispatches_end_to_end", () => {
    const out = execFileSync(
      "task",
      ["-t", join(repoRoot(), "Taskfile.yml"), "release", "--", "--help"],
      {
        cwd: repoRoot(),
        encoding: "utf8",
        env: { ...process.env, PYTHONUTF8: "1" },
      },
    );
    expect(out.toLowerCase()).toContain("usage");
  });
});
