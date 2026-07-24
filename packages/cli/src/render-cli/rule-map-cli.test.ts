import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRuleMapCli } from "./rule-map-cli.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-rule-map-cli-"));
  temps.push(root);
  const coding = join(root, "content", "coding");
  mkdirSync(coding, { recursive: true });
  writeFileSync(join(coding, "coding.md"), "# Coding\n\nRules.\n\n- ! MUST test\n", "utf8");
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(
    join(root, "tasks", "scm.yml"),
    "version: '3'\ntasks:\n  commit:\n    desc: \"c\"\n",
    "utf8",
  );
  writeFileSync(
    join(root, "Taskfile.yml"),
    "version: '3'\n\nincludes:\n  scm:\n    taskfile: ./tasks/scm.yml\n",
    "utf8",
  );
  return root;
}

describe("runRuleMapCli", () => {
  it("delegates to the core generator and writes both artifacts", () => {
    const root = makeRepo();
    expect(runRuleMapCli(["--project-root", root])).toBe(0);
    expect(existsSync(join(root, "docs", "RULE-MAP.md"))).toBe(true);
    expect(existsSync(join(root, "docs", "rule-map", "index.html"))).toBe(true);
  });

  it("passes --help through and returns 0", () => {
    expect(runRuleMapCli(["--help"])).toBe(0);
  });

  it("passes --check through (fresh render is up to date)", () => {
    const root = makeRepo();
    runRuleMapCli(["--project-root", root]);
    expect(runRuleMapCli(["--project-root", root, "--check"])).toBe(0);
  });
});
