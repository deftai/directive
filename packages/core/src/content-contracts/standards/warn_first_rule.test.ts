/**
 * Warn-first refusal rule text (#6281 items 7, 8 and 9).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, `heading ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("warn-first refusal rule (#6281)", () => {
  it("main.md Thin Fail-Closed Design states warn-first, named exception and prefer-narrowing", () => {
    const thin = section(read("main.md"), "## Thin Fail-Closed Design (#3265)");
    expect(thin).toContain("narrow or remove a gate before adding one");
    expect(thin).toMatch(/ships in `warn` mode for at least one release/);
    expect(thin).toMatch(
      /exception` reason in its table row, and its CHANGELOG entry states that reason/,
    );
  });

  it("docs/RELEASING.md states warn-first, named exception and prefer-narrowing", () => {
    const rule = section(read("docs/RELEASING.md"), "## Warn-first refusals (#6281)");
    expect(rule).toContain("Narrow or remove a gate before adding one");
    expect(rule).toMatch(/ships in `warn` mode for at least one release/);
    expect(rule).toMatch(/named exception/);
    expect(rule).toMatch(/CHANGELOG entry states the reason/);
  });

  it("docs/RELEASING.md states the skipped-release limit with gate id and remedy named", () => {
    const rule = section(read("docs/RELEASING.md"), "## Warn-first refusals (#6281)");
    expect(rule).toMatch(/counted per release, not per consumer/);
    expect(rule).toMatch(/upgrades past the warn-only release meets the refusal first/);
    expect(rule).toMatch(/gate id and the remedy/);
  });

  it("content/docs/gate-walkthrough.md gives the push, completion and plan-update sequences", () => {
    const page = read("content/docs/gate-walkthrough.md");
    expect(page).toContain("## One push");
    expect(page).toContain("## One completion");
    expect(page).toContain("## One plan update");
    expect(section(page, "## One push")).toContain("git push");
    expect(section(page, "## One completion")).toContain("deft verify:completed-tracked --issue");
    expect(section(page, "## One plan update")).toContain("deft plan-sequence:insert");
    for (const id of ["pre-pr-push-gate", "setup-hook-files", "hooks-installed"]) {
      expect(page).toContain(`\`${id}\``);
    }
    expect(page).toContain("directive install --repair --yes");
  });
});
