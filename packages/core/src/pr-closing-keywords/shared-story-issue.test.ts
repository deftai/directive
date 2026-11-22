/**
 * #6934: open story briefs that share one completion issue (the first GitHub
 * issue reference of each brief) are found from files and named in a warning.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  findSharedStoryIssues,
  formatSharedStoryIssueWarning,
  sharedStoryIssueWarnings,
} from "./story-issue.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-shared-story-issue-"));
  temps.push(root);
  return root;
}

interface BriefOpts {
  readonly repo?: string;
  readonly kind?: string;
  readonly childPlan?: boolean;
  readonly base?: string;
}

function writeBrief(
  root: string,
  folder: string,
  name: string,
  issue: number,
  opts: BriefOpts = {},
): string {
  const base = opts.base ?? "xbrief";
  const references: Record<string, unknown>[] = [
    {
      uri: `https://github.com/${opts.repo ?? "deftai/directive"}/issues/${String(issue)}`,
      type: "x-xbrief/github-issue",
    },
  ];
  if (opts.childPlan === true) {
    references.push({ uri: "./child.xbrief.json", type: "x-xbrief/plan" });
  }
  const rel = `${base}/${folder}/${name}`;
  mkdirSync(join(root, base, folder), { recursive: true });
  writeFileSync(
    join(root, rel),
    JSON.stringify({
      plan: {
        title: name,
        status: folder === "active" ? "running" : folder,
        references,
        metadata: opts.kind !== undefined ? { kind: opts.kind } : {},
      },
    }),
    "utf8",
  );
  return rel;
}

describe("findSharedStoryIssues (#6934)", () => {
  it("names the other active and pending story briefs with the same issue", () => {
    const root = makeRoot();
    const a = writeBrief(root, "active", "a.xbrief.json", 1840, { kind: "story" });
    const b = writeBrief(root, "active", "b.xbrief.json", 1840);
    const c = writeBrief(root, "pending", "c.xbrief.json", 1840);
    writeBrief(root, "active", "d.xbrief.json", 1841);
    const shared = findSharedStoryIssues(root, [a]);
    expect(shared).toEqual([
      { repository: "deftai/directive", issue: 1840, rel: a, others: [b, c] },
    ]);
    const warning = formatSharedStoryIssueWarning(shared[0] as (typeof shared)[number]);
    expect(warning).toContain(`${a} shares completion issue deftai/directive#1840`);
    expect(warning).toContain(`with ${b}, ${c}.`);
    expect(warning).toContain("compete for `deft-story: 1840`");
    expect(warning).toContain("`metadata.productPullRequest`");
    expect(warning).toContain("an operator attestation does not get past another product part");
    expect(warning).toContain("Give each story its own issue");
    expect(warning).not.toMatch(/can never|only one story/i);
  });

  it("reports one warning per shared issue across several subjects", () => {
    const root = makeRoot();
    const a = writeBrief(root, "active", "a.xbrief.json", 7);
    const b = writeBrief(root, "active", "b.xbrief.json", 7);
    const warnings = sharedStoryIssueWarnings(root, [a, b]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${a} shares completion issue deftai/directive#7`);
    expect(warnings[0]).toContain(`with ${b}.`);
  });

  it("skips epic and phase briefs, as subject and as sharer", () => {
    const root = makeRoot();
    const epic = writeBrief(root, "active", "epic.xbrief.json", 9, { kind: "epic" });
    const story = writeBrief(root, "active", "story.xbrief.json", 9, { kind: "story" });
    writeBrief(root, "pending", "phase.xbrief.json", 9, { kind: "phase" });
    writeBrief(root, "pending", "parent.xbrief.json", 9, { childPlan: true });
    expect(findSharedStoryIssues(root, [story])).toEqual([]);
    expect(findSharedStoryIssues(root, [epic])).toEqual([]);
  });

  it("ignores the same number in another repository and completed briefs", () => {
    const root = makeRoot();
    const a = writeBrief(root, "active", "a.xbrief.json", 12);
    writeBrief(root, "active", "b.xbrief.json", 12, { repo: "acme/other" });
    writeBrief(root, "completed", "c.xbrief.json", 12);
    writeBrief(root, "cancelled", "d.xbrief.json", 12);
    expect(findSharedStoryIssues(root, [a])).toEqual([]);
  });

  it("reads legacy vbrief/ folders and matches the repository case-insensitively", () => {
    const root = makeRoot();
    const a = writeBrief(root, "active", "a.xbrief.json", 21);
    const legacy = writeBrief(root, "pending", "l.vbrief.json", 21, {
      base: "vbrief",
      repo: "DeftAI/Directive",
    });
    expect(findSharedStoryIssues(root, [a])[0]?.others).toEqual([legacy]);
  });

  it("returns nothing for unreadable, unanchored or missing subjects", () => {
    const root = makeRoot();
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(join(root, "xbrief", "active", "bad.xbrief.json"), "{not json", "utf8");
    writeFileSync(
      join(root, "xbrief", "active", "none.xbrief.json"),
      JSON.stringify({ plan: { status: "running", references: [] } }),
      "utf8",
    );
    writeBrief(root, "active", "a.xbrief.json", 30);
    expect(
      findSharedStoryIssues(root, [
        "xbrief/active/bad.xbrief.json",
        "xbrief/active/none.xbrief.json",
        "xbrief/active/missing.xbrief.json",
      ]),
    ).toEqual([]);
  });
});
