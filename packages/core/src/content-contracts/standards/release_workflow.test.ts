import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const ACTION_RE = /uses:\s*softprops\/action-gh-release@(?:v\S+|[0-9a-f]{40})\b/i;

function softpropsBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (ACTION_RE.test(lines[i] ?? "")) {
      const block = [lines[i] ?? ""];
      const usesIndent = (lines[i] ?? "").length - (lines[i] ?? "").trimStart().length;
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j] ?? "";
        if (!nxt.trim()) {
          block.push(nxt);
          j += 1;
          continue;
        }
        const nxtIndent = nxt.length - nxt.trimStart().length;
        if (nxtIndent <= usesIndent && nxt.trimStart().startsWith("- ")) break;
        if (nxtIndent < usesIndent) break;
        block.push(nxt);
        j += 1;
      }
      blocks.push(block.join("\n"));
      i = j;
      continue;
    }
    i += 1;
  }
  return blocks;
}

function stripYamlComments(workflowText: string): string {
  const codeLines: string[] = [];
  for (const line of workflowText.split("\n")) {
    let trimmed = line;
    let idx = 0;
    let inQuote = false;
    while (idx < line.length) {
      const ch = line[idx];
      if (ch === "'" || ch === '"') inQuote = !inQuote;
      else if (ch === "#" && !inQuote && (idx === 0 || " \t".includes(line[idx - 1] ?? ""))) {
        trimmed = line.slice(0, idx);
        break;
      }
      idx += 1;
    }
    codeLines.push(trimmed);
  }
  return codeLines.join("\n");
}

const workflowText = readText(".github/workflows/release.yml");
const releaseSkillText = readText("skills/deft-directive-release/SKILL.md");
const releasingDocText = readText("docs/RELEASING.md");

describe("test_release_workflow.py", () => {
  it("test_release_yml_exists", () => {
    expect(isFile(".github/workflows/release.yml")).toBe(true);
    expect(workflowText.trim().length).toBeGreaterThan(0);
  });
  it("test_softprops_action_present_at_least_once", () => {
    expect(ACTION_RE.test(workflowText)).toBe(true);
  });
  it("test_no_softprops_usage_with_draft_false", () => {
    const offenders = softpropsBlocks(workflowText).filter((block) =>
      /^\s*draft:\s*false\b/m.test(block),
    );
    expect(offenders).toEqual([]);
  });
  it("test_every_softprops_usage_sets_draft_true", () => {
    const blocks = softpropsBlocks(workflowText);
    expect(blocks.length).toBeGreaterThan(0);
    const missing = blocks.filter((block) => !/^\s*draft:\s*true\b/m.test(block));
    expect(missing).toEqual([]);
  });
  it("test_no_gh_release_edit_draft_false", () => {
    const codeOnly = stripYamlComments(workflowText);
    expect(/gh\s+release\s+edit.*--draft(?:=|\s+)false/m.test(codeOnly)).toBe(false);
  });
  it("test_no_isdraft_false_flip_anywhere", () => {
    const codeOnly = stripYamlComments(workflowText);
    expect(/isDraft:\s*false/m.test(codeOnly)).toBe(false);
  });
  it("test_release_skill_prefers_typed_policy_opt_out", () => {
    expect(releaseSkillText).toContain("plan.policy.allowDirectCommitsToMaster");
  });
  it("test_release_skill_warns_env_bypass_is_process_wide", () => {
    expect(releaseSkillText).toContain("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT");
  });
  it("test_releasing_doc_prefers_typed_policy_opt_out", () => {
    expect(releasingDocText).toContain("plan.policy.allowDirectCommitsToMaster");
  });
  it("test_releasing_doc_warns_against_broad_env_bypass", () => {
    expect(releasingDocText).toContain("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT");
  });
});

describe("#1987 freeze-gate graceful skip", () => {
  it("freeze-gate job declares the frozen_skip output from the gate step", () => {
    expect(workflowText).toContain("frozen_skip: ${{ steps.gate.outputs.frozen_skip }}");
  });
  it("the above-the-line branch sets frozen_skip=true and exits 0 (no hard-fail)", () => {
    expect(workflowText).toContain('echo "frozen_skip=true" >> "$GITHUB_OUTPUT"');
    // The old hard-fail wording for a tag above the frozen line must be gone.
    expect(workflowText).not.toContain("No Go-installer release past the frozen line is allowed");
  });
  it("the build job is gated on frozen_skip so it skips cleanly when frozen", () => {
    expect(workflowText).toContain("needs.freeze-gate.outputs.frozen_skip != 'true'");
  });
  it("the unparseable-SoT case still fails loud (fail-closed, never fail-open)", () => {
    const codeOnly = stripYamlComments(workflowText);
    // The "Refusing to fail open" branch must still exit 1 on an unparseable SoT.
    expect(codeOnly).toContain("Refusing to fail open");
    expect(/Refusing to fail open[\s\S]*?exit 1/m.test(codeOnly)).toBe(true);
  });
});
