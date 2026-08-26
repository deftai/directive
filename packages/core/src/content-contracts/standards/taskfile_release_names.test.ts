import { execFileSync, execSync, spawnSync } from "node:child_process";
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
  const out = execFileSync(
    "task",
    ["-t", join(repoRoot(), "Taskfile.yml"), "--list-all", "--json"],
    {
      cwd: repoRoot(),
      encoding: "utf8",
      env: { ...process.env, PYTHONUTF8: "1" },
    },
  );
  const parsed = JSON.parse(out) as { tasks?: Array<{ name?: string; task?: string }> };
  return (parsed.tasks ?? []).map((entry) => entry.task ?? entry.name ?? "").filter(Boolean);
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

  // Windows-native go-task currently doubles absolute DEFT_ROOT when chdir'ing
  // into engine:pm-run (`C:\repo\C:\repo`); tracked under #2467 hardening follow-up.
  it.skipIf(!taskAvailable || process.platform === "win32")(
    "test_task_release_help_dispatches_end_to_end",
    () => {
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
    },
  );

  it.skipIf(!taskAvailable)("test_release_task_desc_documents_allow_vbrief_drift (#3752)", () => {
    const out = execFileSync(
      "task",
      ["-t", join(repoRoot(), "Taskfile.yml"), "--list-all", "--json"],
      {
        cwd: repoRoot(),
        encoding: "utf8",
        env: { ...process.env, PYTHONUTF8: "1" },
      },
    );
    const parsed = JSON.parse(out) as { tasks?: Array<{ task?: string; desc?: string }> };
    const release = (parsed.tasks ?? []).find((entry) => entry.task === "release");
    expect(release?.desc ?? "").toContain("--allow-vbrief-drift");
  });

  it.skipIf(!taskAvailable)(
    "test_task_release_summary_with_apostrophe_does_not_shell_parse_fail (#2547)",
    () => {
      const result = spawnSync(
        "task",
        [
          "-t",
          join(repoRoot(), "Taskfile.yml"),
          "release",
          "--",
          "0.0.0",
          "--dry-run",
          "--skip-tag",
          "--skip-release",
          "--summary",
          "test what's next",
        ],
        {
          cwd: repoRoot(),
          encoding: "utf8",
          env: { ...process.env, PYTHONUTF8: "1" },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      expect(result.status).toBe(0);
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase();
      expect(combined).toMatch(/dry-run|changelog|release/);
    },
  );
});
