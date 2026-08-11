import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  FORBIDDEN_BLANKET_EVAL_LINES,
  GITIGNORE_EVAL_ENTRIES,
  GITIGNORE_LINE,
  generateTriageCacheReadmeBody,
  gitattributesTriageCacheGlob,
  gitignoreTriageCacheEntries,
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
    expect(stripGitignoreInlineComment("xbrief/.triage-cache/  # legacy")).toBe(
      "xbrief/.triage-cache/",
    );
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
  it("writes selective #1144 entries including per-clone session state (#3146)", () => {
    const root = makeRoot();
    stepEnsureGitignoreEntry(root);
    const outcome = stepEnsureGitignoreEvalEntries(root);
    expect(outcome.ok).toBe(true);
    const text = readFileSync(join(root, ".gitignore"), "utf8");
    for (const entry of GITIGNORE_EVAL_ENTRIES) {
      expect(text).toContain(entry);
    }
    expect(text).toContain("xbrief/.triage-cache/staleness-tickler-state.json");
    expect(text).toContain("xbrief/.triage-cache/release-availability-state.json");
    expect(text).toContain("xbrief/.triage-cache/scm-label-mirror-discovery-state.json");
    expect(text).toContain(GITIGNORE_LINE);
    // Hybrid policy: no blanket ignore of the triage-cache directory.
    for (const forbidden of FORBIDDEN_BLANKET_EVAL_LINES) {
      expect(text.split("\n").map((l) => l.trim())).not.toContain(forbidden);
    }
    expect(outcome.details.gitignore_appended_lines).toBe(GITIGNORE_EVAL_ENTRIES.length);
  });

  it("lists generated session-state filenames in static + layout-aware sets (#3146)", () => {
    expect(GITIGNORE_EVAL_ENTRIES).toContain("xbrief/.triage-cache/staleness-tickler-state.json");
    expect(GITIGNORE_EVAL_ENTRIES).toContain(
      "xbrief/.triage-cache/release-availability-state.json",
    );
    expect(GITIGNORE_EVAL_ENTRIES).toContain(
      "xbrief/.triage-cache/scm-label-mirror-discovery-state.json",
    );
    const root = makeRoot();
    const layoutAware = gitignoreTriageCacheEntries(root);
    expect(layoutAware).toContain("xbrief/.triage-cache/staleness-tickler-state.json");
    expect(layoutAware).toContain("xbrief/.triage-cache/release-availability-state.json");
    expect(layoutAware).toContain("xbrief/.triage-cache/scm-label-mirror-discovery-state.json");
    // Selective only — hybrid policy keeps shared artifacts unhidden.
    expect(layoutAware).not.toContain("xbrief/.triage-cache/");
    expect(layoutAware).not.toContain("xbrief/.triage-cache");
  });

  it("gitattributes glob uses active layout and defaults to xbrief (#3146)", () => {
    const bare = makeRoot();
    expect(gitattributesTriageCacheGlob(bare)).toBe("xbrief/.triage-cache/*.jsonl");
    const migrated = makeRoot();
    mkdirSync(join(migrated, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(migrated, "xbrief", "active", "s.xbrief.json"),
      JSON.stringify({ plan: { id: "s", status: "running", items: [] } }),
      "utf8",
    );
    expect(gitattributesTriageCacheGlob(migrated)).toBe("xbrief/.triage-cache/*.jsonl");
    const entries = gitignoreTriageCacheEntries(migrated);
    expect(entries).toContain("xbrief/.triage-cache/staleness-tickler-state.json");
    expect(entries.some((e) => e.endsWith("decompositions/"))).toBe(true);
  });

  it("warns when a forbidden blanket triage-cache line is already present", () => {
    const root = makeRoot();
    stepEnsureGitignoreEntry(root);
    writeFileSync(
      join(root, ".gitignore"),
      `${readFileSync(join(root, ".gitignore"), "utf8")}\nvbrief/.triage-cache/\n`,
      "utf8",
    );
    const outcome = stepEnsureGitignoreEvalEntries(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.blanket_present).toBe(true);
    expect(outcome.message).toContain("blanket");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(
      "xbrief/.triage-cache/staleness-tickler-state.json",
    );
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
    writeFileSync(gi, `${readFileSync(gi, "utf8")}${GITIGNORE_EVAL_ENTRIES.join("\n")}\n`, "utf8");
    writeFileSync(
      join(root, ".gitattributes"),
      "xbrief/.triage-cache/*.jsonl  merge=union\n",
      "utf8",
    );
    mkdirSync(join(root, "xbrief", ".triage-cache"), { recursive: true });
    writeFileSync(join(root, "xbrief", ".triage-cache", "README.md"), "pre-existing", "utf8");
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
      "xbrief/.triage-cache/summary-history.jsonl\n",
      "",
    );
    writeFileSync(gi, withoutSummary, "utf8");
    const outcome = stepEnsureGitignoreEvalEntries(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.rationale_already_present).toBe(true);
    expect(readFileSync(gi, "utf8")).toContain("xbrief/.triage-cache/summary-history.jsonl");
  });
});

describe("stepSeedCandidatesLog", () => {
  it("creates empty candidates.jsonl", () => {
    const root = makeRoot();
    const outcome = stepSeedCandidatesLog(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.created).toBe(true);
    const audit = join(root, "xbrief", ".triage-cache", "candidates.jsonl");
    expect(readFileSync(audit, "utf8")).toBe("");
  });

  it("is idempotent when present", () => {
    const root = makeRoot();
    const auditDir = join(root, "xbrief", ".triage-cache");
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

/** Directive-internal markers that must not ship in consumer README deposits (#2374). */
const FORBIDDEN_CONSUMER_README_MARKERS = [
  "candidates_log.py",
  "scripts/",
  "#1144",
  "#1132",
  "#845",
  "#1121",
  "#1180",
  "#1308",
  "#1464",
  "#1119",
  "#1183",
  "D13",
  "D1 /",
  "Current Shape",
  "decision_id",
] as const;

describe("generateTriageCacheReadmeBody", () => {
  it("substitutes xbrief/.triage-cache for the active migrated layout", () => {
    const root = makeRoot();
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "s.xbrief.json"),
      JSON.stringify({ plan: { id: "s", status: "running", items: [] } }),
      "utf8",
    );
    const body = generateTriageCacheReadmeBody(root);
    expect(body).toContain("xbrief/.triage-cache/");
    expect(body).not.toContain("vbrief/.triage-cache/");
  });

  it("is consumer-safe: no directive-internal IDs or dead script pointers (#2374)", () => {
    const root = makeRoot();
    const body = generateTriageCacheReadmeBody(root);
    for (const marker of FORBIDDEN_CONSUMER_README_MARKERS) {
      expect(body).not.toContain(marker);
    }
    expect(body).toContain("slices.jsonl");
    expect(body).toContain("deft triage:bootstrap");
    expect(body).toContain("merge=union");
  });
});

describe("stepEnsureGitignoreEvalEntries README deposit", () => {
  it("writes a consumer-safe README on bootstrap (#2374)", () => {
    const root = makeRoot();
    stepEnsureGitignoreEntry(root);
    const outcome = stepEnsureGitignoreEvalEntries(root);
    expect(outcome.ok).toBe(true);
    expect(outcome.details.readme_created).toBe(true);
    const readme = readFileSync(join(root, "xbrief", ".triage-cache", "README.md"), "utf8");
    for (const marker of FORBIDDEN_CONSUMER_README_MARKERS) {
      expect(readme).not.toContain(marker);
    }
    expect(readme).toContain("slices.jsonl");
    expect(readme).toContain("candidates.jsonl");
    expect(readme).toContain("staleness-tickler-state.json");
    expect(readme).toContain("release-availability-state.json");
    expect(readme).toContain("scm-label-mirror-discovery-state.json");
  });
});
