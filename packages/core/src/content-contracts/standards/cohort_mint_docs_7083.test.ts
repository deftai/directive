/** Content contract for the batched cohort flow docs (#7083). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readText, repoRoot } from "./_helpers.js";

describe("batched cohort flow docs (#7083)", () => {
  it("commands.md names the cohort mint, the batched flow and its counts", () => {
    const text = readText("commands.md");
    for (const token of [
      "`task scope:record-approved-scope -- --manifest <file> --actor <human> --confirm`",
      "asks for the typed `mint` once",
      "refuses the whole set before the prompt",
      "A failed run removes only the files it created",
      "`--add-path` stays single-brief",
      "**Batched cohort flow (#7083).**",
      "one `deft-story-part: N` line per brief",
      "launch admits each story at its own branch tip",
      "For 10 stories that is at most 11 PRs and one mint, or at most 12 PRs.",
      "Each further sweep adds one lifecycle PR.",
    ]) {
      expect(text, `commands.md missing ${token}`).toContain(token);
    }
  });

  it("scope-provenance.md describes the cohort mint and per-story launch", () => {
    const text = readText("docs/scope-provenance.md");
    for (const token of [
      "**Cohort mint and per-story launch (#7083).**",
      "takes the typed `mint` once",
      "`cohortDigest` is metadata, not authority",
      "A product PR never carries a peer's brief or pair",
      "`deft-story-part: N` covering each changed nonterminal",
    ]) {
      expect(text, `scope-provenance.md missing ${token}`).toContain(token);
    }
  });

  it("directive-lifecycle.md has the consumer section with the counts", () => {
    const text = readText("docs/directive-lifecycle.md");
    for (const token of [
      "## Batched cohort flow (#7083)",
      "ten stories cost at most 11 PRs\nand one mint at `mint`, or at most 12 PRs at `off`",
      "Each further sweep adds\none lifecycle PR.",
      "`swarm:finalize-cohort`",
    ]) {
      expect(text, `directive-lifecycle.md missing ${token}`).toContain(token);
    }
  });

  // A release cut folds changelog.d fragments into CHANGELOG.md and deletes them,
  // so read the fragment while it exists and the folded entry after that. The
  // `section:` header does not survive the fold, so only the fragment checks it.
  it("a CHANGELOG fragment or the folded CHANGELOG entry names the change", () => {
    if (existsSync(join(repoRoot(), "changelog.d", "7083-cohort-mint.md"))) {
      const text = readText("../changelog.d/7083-cohort-mint.md");
      expect(text).toContain("section: Added");
      expect(text).toContain("(#7083)");
    } else {
      expect(readText("CHANGELOG.md")).toContain("(#7083)");
    }
  });
});
