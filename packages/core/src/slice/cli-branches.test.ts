import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCli, runCli } from "./cli.js";
import { runList } from "./existing.js";
import { pythonJsonStringify } from "./json.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-slice-cli-br-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  mkdirSync(join(root, ".git"));
  return root;
}

describe("cli branch coverage", () => {
  it("parseCli handles empty argv and equals-form list flags", () => {
    expect(parseCli([]).command).toBe("record-existing");
    expect(parseCli(["list", "--project-root=/tmp/x"]).listProjectRoot).toBe("/tmp/x");
  });

  it("runCli returns help with exit 0", () => {
    expect(runCli(["--help"]).exitCode).toBe(0);
    expect(runCli(["list", "--help"]).exitCode).toBe(0);
  });

  it("runCli lists records with non-array children and json output", () => {
    const root = makeRoot();
    const path = join(root, "vbrief", ".eval", "slices.jsonl");
    writeFileSync(
      path,
      `${pythonJsonStringify({
        slice_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        umbrella: 5,
        umbrella_url: "u",
        sliced_at: "2026-05-14T17:00:00Z",
        actor: "a",
        children: "bad",
        expected_close_signal: "all-children-merged",
      })}\n`,
      "utf8",
    );
    const listed = runList({ projectRoot: root, asJson: false });
    expect(listed.stdout).toContain("children=0");
    const json = runCli(["list", "--json", `--project-root=${root}`]);
    expect(json.exitCode).toBe(0);
    expect(json.stdout).toContain('"umbrella": 5');
  });

  it("parseCli handles dry-run, force, and skip-validation flags", () => {
    const parsed = parseCli([
      "record-existing",
      "--umbrella=9",
      "--children=10",
      "--repo=o/r",
      "--dry-run",
      "--force",
      "--skip-validation",
    ]);
    expect(parsed.recordArgs?.dryRun).toBe(true);
    expect(parsed.recordArgs?.force).toBe(true);
    expect(parsed.recordArgs?.skipValidation).toBe(true);
  });

  it("parseRecordExisting accepts all space-form optional flags", () => {
    const parsed = parseCli([
      "record-existing",
      "--umbrella",
      "1",
      "--children",
      "2",
      "--actor",
      "manual:carol",
      "--expected-close-signal",
      "manual",
      "--sliced-at",
      "2026-05-14T17:00:00Z",
      "--notes",
      "why",
      "--repo",
      "o/r",
      "--project-root",
      "/tmp/p",
    ]);
    expect(parsed.recordArgs).toMatchObject({
      umbrella: 1,
      actor: "manual:carol",
      expectedCloseSignal: "manual",
      notes: "why",
      repo: "o/r",
      projectRoot: "/tmp/p",
    });
  });
});
