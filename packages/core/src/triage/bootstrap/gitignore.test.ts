import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  GITIGNORE_EVAL_ENTRIES,
  GITIGNORE_LINE,
  stepEnsureGitignoreEntry,
  stepEnsureGitignoreEvalEntries,
  stepSeedCandidatesLog,
  stripGitignoreInlineComment,
} from "./gitignore.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-bootstrap-gi-"));
  temps.push(root);
  return root;
}

describe("stripGitignoreInlineComment", () => {
  it("strips inline comments for forbidden-blanket detection", () => {
    expect(stripGitignoreInlineComment("vbrief/.eval/  # legacy")).toBe("vbrief/.eval/");
  });
});

describe("stepEnsureGitignoreEntry", () => {
  it("creates .gitignore when missing", () => {
    const root = makeRoot();
    const outcome = stepEnsureGitignoreEntry(root);
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(GITIGNORE_LINE);
  });

  it("is idempotent on re-run", () => {
    const root = makeRoot();
    stepEnsureGitignoreEntry(root);
    const first = readFileSync(join(root, ".gitignore"), "utf8");
    stepEnsureGitignoreEntry(root);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(first);
  });

  it("respects commented opt-in form", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".gitignore"), "# .deft-cache/\n", "utf8");
    const outcome = stepEnsureGitignoreEntry(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.opt_in_commit).toBe(true);
    const active = readFileSync(join(root, ".gitignore"), "utf8")
      .split("\n")
      .filter((line) => line.trim() === ".deft-cache/");
    expect(active).toEqual([]);
  });

  it("appends to an existing gitignore", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8");
    const outcome = stepEnsureGitignoreEntry(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.appended).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("node_modules/");
  });
});

describe("stepEnsureGitignoreEvalEntries", () => {
  it("writes selective #1144 entries", () => {
    const root = makeRoot();
    stepEnsureGitignoreEntry(root);
    const outcome = stepEnsureGitignoreEvalEntries(root);
    expect(outcome.ok).toBe(true);
    const text = readFileSync(join(root, ".gitignore"), "utf8");
    for (const entry of GITIGNORE_EVAL_ENTRIES) {
      expect(text).toContain(entry);
    }
    expect(text).toContain(GITIGNORE_LINE);
    expect(outcome.details.gitignore_appended_lines).toBe(GITIGNORE_EVAL_ENTRIES.length);
  });

  it("fails without existing .gitignore", () => {
    const root = makeRoot();
    const outcome = stepEnsureGitignoreEvalEntries(root);
    expect(outcome.ok).toBe(false);
    expect(outcome.details.skipped).toBe("no-gitignore");
  });

  it("is idempotent when selective entries already present", () => {
    const root = makeRoot();
    stepEnsureGitignoreEntry(root);
    const gi = join(root, ".gitignore");
    writeFileSync(
      gi,
      `${readFileSync(gi, "utf8")}\nvbrief/.eval/candidates.jsonl\nvbrief/.eval/summary-history.jsonl\nvbrief/.eval/scope-lifecycle.jsonl\nvbrief/.eval/decompositions/\nvbrief/.eval/doctor-state.json\n`,
      "utf8",
    );
    writeFileSync(join(root, ".gitattributes"), "vbrief/.eval/*.jsonl  merge=union\n", "utf8");
    mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
    writeFileSync(join(root, "vbrief", ".eval", "README.md"), "pre-existing", "utf8");
    const before = readFileSync(gi, "utf8");
    const outcome = stepEnsureGitignoreEvalEntries(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.gitignore_appended_lines).toBe(0);
    expect(readFileSync(gi, "utf8")).toBe(before);
  });

  it("appends merge=union to an existing gitattributes file", () => {
    const root = makeRoot();
    stepEnsureGitignoreEntry(root);
    writeFileSync(join(root, ".gitattributes"), "*.go diff=golang\n", "utf8");
    const outcome = stepEnsureGitignoreEvalEntries(root);
    expect(outcome.ok).toBe(true);
    const ga = readFileSync(join(root, ".gitattributes"), "utf8");
    expect(ga).toContain("*.go diff=golang");
    expect(ga).toContain("merge=union");
  });

  it("re-adds a missing selective entry without duplicating rationale", () => {
    const root = makeRoot();
    stepEnsureGitignoreEntry(root);
    stepEnsureGitignoreEvalEntries(root);
    const gi = join(root, ".gitignore");
    const withoutSummary = readFileSync(gi, "utf8").replace(
      "vbrief/.eval/summary-history.jsonl\n",
      "",
    );
    writeFileSync(gi, withoutSummary, "utf8");
    const outcome = stepEnsureGitignoreEvalEntries(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.rationale_already_present).toBe(true);
    expect(readFileSync(gi, "utf8")).toContain("vbrief/.eval/summary-history.jsonl");
  });
});

describe("stepSeedCandidatesLog", () => {
  it("creates empty candidates.jsonl", () => {
    const root = makeRoot();
    const outcome = stepSeedCandidatesLog(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.created).toBe(true);
    const audit = join(root, "vbrief", ".eval", "candidates.jsonl");
    expect(readFileSync(audit, "utf8")).toBe("");
  });

  it("is idempotent when present", () => {
    const root = makeRoot();
    const auditDir = join(root, "vbrief", ".eval");
    mkdirSync(auditDir, { recursive: true });
    const audit = join(auditDir, "candidates.jsonl");
    writeFileSync(audit, '{"decision":"accept"}\n', "utf8");
    const before = readFileSync(audit, "utf8");
    const outcome = stepSeedCandidatesLog(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.already_present).toBe(true);
    expect(readFileSync(audit, "utf8")).toBe(before);
  });
});
