import { describe, expect, it } from "vitest";
import { releaseRunFinalLines } from "../../release/run.js";
import { readText } from "./_helpers.js";

/** One `## ` section of a Markdown file, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`section not found: ${heading}`);
  const next = text.indexOf("\n## ", start + heading.length + 2);
  return text.slice(start, next < 0 ? undefined : next);
}

const V = "1.2.0";

describe("release run runbook (#6878 clause 4)", () => {
  const skill = readText("content/skills/deft-directive-release/SKILL.md");
  const releasing = readText("docs/RELEASING.md");
  const runbook = section(skill, "## Stable cut runbook");
  const run = section(releasing, "## Release run (#6845)");

  it("the skill's Stable cut runbook is the command, its approval step and the post-run pin steps", () => {
    for (const text of [
      "deft release:run <version> --expires <ISO>",
      "Type `mint` at the TTY",
      "deft release:run <version> --resume",
      "pnpm update -w @deftai/directive-runtime@<version>",
      "pnpm install --frozen-lockfile",
      "task release:local-update -- <version> --checkout <primary>",
      "npm i -g @deftai/directive@<version>",
      "never dispatches the manual republish workflow",
      "#6966",
    ]) {
      expect(runbook).toContain(text);
    }
  });

  it("docs/RELEASING.md describes the same command, approval, resume and pin steps", () => {
    for (const text of [
      "deft release:run X.Y.Z --expires <ISO>",
      "Type `mint` at the TTY",
      "deft release:run X.Y.Z --resume",
      "### Release run recovery",
      "pnpm update -w @deftai/directive-runtime@X.Y.Z",
      "pnpm install --frozen-lockfile",
      "never dispatches the manual republish workflow",
    ]) {
      expect(run).toContain(text);
    }
    expect(section(releasing, "## Stable cut order")).toContain("deft release:run");
  });

  it("the merge-freeze rule and the routine-cut skip path leave the runbook", () => {
    expect(runbook).not.toMatch(/Merge freeze/i);
    expect(runbook).not.toMatch(/Skip path/i);
    expect(runbook).not.toContain("--skip-ci");
    expect(releasing).not.toContain("the merge freeze and the pin steps");
    expect(section(releasing, "## Routine vs hard cut for Step 5 (#2953)")).toContain(
      "There is no routine-cut skip path",
    );
  });

  it("the skill's Routine vs hard cut follows the Step 5 CI reuse rule (#6791 carry-over)", () => {
    expect(skill).not.toContain("green tip CI is a precondition, not a replacement for Step 5");
    expect(skill).toContain("Let Step 5 decide on CI reuse (#6791)");
  });

  it("the skill and docs/RELEASING.md say where coverage and the Windows suite run (#6849 clauses 8, 22)", () => {
    const nightly = section(releasing, "## Nightly coverage and Windows lanes (#6849)");
    for (const text of [skill, nightly]) {
      expect(text).toContain(".github/workflows/nightly.yml");
      expect(text).toContain("Nightly coverage (Linux)");
      expect(text).toContain("Nightly full suite (Windows)");
      expect(text).toMatch(
        /newest nightly run whose head (commit )?tree equals the clean Step 5 input tree/,
      );
      expect(text).toContain("gh workflow run nightly.yml --repo deftai/directive --ref master");
      expect(text).toContain("the Windows suite did not run for this release");
      expect(text).toContain("NIGHTLY_OWNER");
    }
    expect(nightly).toMatch(/never on pull requests or `merge_group`/);
    expect(section(releasing, "## Step 5 CI reuse (#6791)")).toContain(
      "Both nightly lanes are reusable on that tree",
    );
  });

  it("the run prints the pin lockfile steps (#6878 comment 7052455705)", () => {
    const lines = releaseRunFinalLines(V, "master", "/p").join("\n");
    expect(lines).toContain(`pnpm update -w @deftai/directive-runtime@${V}`);
    expect(lines).toContain("pnpm install --frozen-lockfile");
    // The lockfile is regenerated before the frozen install is checked.
    expect(lines.indexOf("pnpm update -w")).toBeLessThan(
      lines.indexOf("pnpm install --frozen-lockfile"),
    );
  });
});
