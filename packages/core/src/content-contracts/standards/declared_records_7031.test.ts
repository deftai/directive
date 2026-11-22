/**
 * Mint audit docs contract (#7031).
 *
 * Worker-facing text says: write the declaration with the record command and
 * land it before the product PR, not park for a human mint. One table in
 * `content/contracts/human-origin-authz.md` lists every operator mint. The
 * changelog says the reader ships with the writer and consumers move the pin
 * first.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTENT_CONSTRAINT_REMEDIATION } from "../../intent-constraint/types.js";
import { OBSERVABLE_SCOPE_REMEDIATION } from "../../observable-scope/types.js";

const ROOT = process.cwd();

function readRepo(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const WORKER_SURFACES = [
  "content/templates/agent-prompt-preamble.md",
  "content/skills/deft-directive-build/SKILL.md",
  "content/skills/deft-directive-setup/SKILL.md",
  "content/skills/deft-directive-swarm/references/core-phase-0.md",
  "content/docs/intent-constraint.md",
  "content/docs/observable-scope.md",
  "content/commands.md",
] as const;

describe("worker instructions: write the declaration (#7031)", () => {
  it("each worker surface says to write the declaration and never to park for a human mint", () => {
    for (const rel of WORKER_SURFACES) {
      const text = readRepo(rel);
      expect(text, rel).toMatch(/write the declaration/i);
      expect(text, rel).not.toMatch(/park pending a human mint/);
      expect(text, rel).not.toMatch(/human lands[^.]*real TTY/);
      expect(text, rel).not.toMatch(/legacy repair only/);
    }
  });

  it("the record docs and commands.md name the declared stamp and the land-before rule", () => {
    for (const rel of [
      "content/docs/intent-constraint.md",
      "content/docs/observable-scope.md",
      "content/commands.md",
    ]) {
      const text = readRepo(rel);
      expect(text, rel).toContain('kind: "declared"');
      expect(text, rel).toMatch(/before the (product|UI-change) PR/);
      expect(text, rel).toMatch(/not consent/);
    }
    const commands = readRepo("content/commands.md");
    expect(commands).toMatch(/`--kind` and `--minted-via` are refused/);
    expect(commands).not.toMatch(/typed phrase `mint`; agent and CI shells refuse/);
  });

  it("the build and setup skills render from the pack source with the new text", () => {
    const pack = readRepo("content/packs/skills/skills-pack-0.1.json");
    expect(pack).toContain("Intent-constraint fail path (#4587 / #5574 Prefer-A / #7031)");
    expect(pack).toContain("Intent-constraint plan key (#4587 / #4541 / #7031)");
    expect(pack).not.toContain("park pending a human mint");
  });

  it("both remediation strings say write the declaration and land it before the product PR", () => {
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/Write the declaration/);
    expect(INTENT_CONSTRAINT_REMEDIATION).toMatch(/before the product PR/);
    expect(OBSERVABLE_SCOPE_REMEDIATION).toMatch(/write the declaration/);
    expect(OBSERVABLE_SCOPE_REMEDIATION).toMatch(/before the UI-change PR/);
    for (const text of [INTENT_CONSTRAINT_REMEDIATION, OBSERVABLE_SCOPE_REMEDIATION]) {
      expect(text).not.toMatch(/park pending a human mint|real TTY/);
    }
  });
});

describe("operator mint inventory table (#7031)", () => {
  const doc = readRepo("content/contracts/human-origin-authz.md");
  const start = doc.indexOf("## Operator mint inventory (#7031)");
  const end = doc.indexOf("\n## ", start + 1);
  const section = doc.slice(start, end);

  it("has one inventory section with the required columns", () => {
    expect(start).toBeGreaterThan(-1);
    expect(doc.indexOf("## Operator mint inventory", start + 1)).toBe(-1);
    expect(section).toContain(
      "| Command | Store | Read at | Hook denies writes in the checkout | Self-approval it prevents | Mint | What the kept mint buys |",
    );
  });

  it("lists every operator-mint command, kept or dropped", () => {
    const kept = [
      "`authz:grant` (every template",
      "`authz:grant --template one-pr-unit`",
      "`authz:uat-start`",
      "`authz:uat-suspend`",
      "`authz:revoke`",
      "`scope:record-approved-scope`",
    ];
    for (const row of kept) {
      const line = section.split("\n").find((l) => l.startsWith(`| ${row}`));
      expect(line, row).toBeDefined();
      expect(line, row).toContain("| kept |");
    }
    for (const row of ["`scope:record-observable-scope`", "`scope:record-intent-constraint`"]) {
      const line = section.split("\n").find((l) => l.startsWith(`| ${row}`));
      expect(line, row).toBeDefined();
      expect(line, row).toContain('dropped; writes `kind: "declared"`');
      expect(line, row).toContain("merge base");
    }
  });

  it("names the known limits and what a kept mint buys", () => {
    expect(section).toContain("#6981");
    expect(section).toContain("#7036");
    expect(section).toMatch(/forge/);
    expect(section).toMatch(/marker-based/);
    expect(section).toMatch(/checked by shape only/);
    expect(section).toMatch(/does not make a\s+store unwritable/);
  });

  it("states the control per merge policy for the two dropped commands", () => {
    expect(section).toContain("### Control for the two dropped commands");
    expect(section).toContain("| `requireHumanMerge: true` |");
    expect(section).toContain("| Bot merge, or a merge under the operator's own identity | None.");
    expect(section).toMatch(/fact found mid-build still needs a record PR/);
    expect(section).toMatch(/`isHumanApprovalStamp` does not accept `declared`/);
  });
});

describe("changelog: reader ships with writer (#7031)", () => {
  it("tells consumers to move the pin before writing a declared record", () => {
    const fragment = join(ROOT, "changelog.d", "7031-declared-records.md");
    const text = existsSync(fragment) ? readFileSync(fragment, "utf8") : readRepo("CHANGELOG.md");
    expect(text).toContain("#7031");
    expect(text).toMatch(/reader ships with the writer/);
    expect(text).toMatch(/move the runtime pin to this release before writing a declared record/);
  });
});
