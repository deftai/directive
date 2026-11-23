import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

/** `on:` block of a workflow (up to the next top-level key). */
function onBlock(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.indexOf("on:");
  if (start < 0) throw new Error("workflow on: block not found");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z]/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("merge queue workflows (#6295 items 2, 3)", () => {
  const greptile = readText(".github/workflows/greptile-review-merge-group.yml");
  const ci = readText(".github/workflows/ci.yml");

  it("the Greptile Review reporter runs on merge_group only", () => {
    const on = onBlock(greptile);
    expect(on).toMatch(/^\s{2}merge_group:/m);
    expect(on).not.toMatch(/pull_request|push|workflow_dispatch|schedule/);
  });

  it("publishes exactly one job named Greptile Review with no permissions", () => {
    expect(greptile.match(/name:\s*Greptile Review\s*$/gm) ?? []).toHaveLength(1);
    expect(greptile).toMatch(/^permissions: \{\}$/m);
    // It starts no review and lists no members: no gh / API calls.
    expect(greptile).not.toMatch(/\bgh\s|api\.github\.com|GH_TOKEN/);
  });

  it("ci.yml runs on pull_request, push to master and merge_group", () => {
    const on = onBlock(ci);
    expect(on).toMatch(/^\s{2}pull_request:/m);
    expect(on).toMatch(/^\s{2}push:/m);
    expect(on).toMatch(/^\s{2}merge_group:/m);
  });

  it("ci.yml routes merge_group to the full stack and keeps both required check names", () => {
    expect(ci).toMatch(
      /elif \[ "\$EVENT_NAME" = "merge_group" \]; then[\s\S]*?artifact_only=false/,
    );
    expect(ci.match(/name:\s*TypeScript \(build \+ lint\)/g) ?? []).toHaveLength(1);
    expect(ci.match(/name:\s*Merge gate \(task check\)/g) ?? []).toHaveLength(1);
    // The Greptile Review job lives in its own workflow, not behind an if in ci.yml.
    expect(ci).not.toMatch(/name:\s*Greptile Review/);
  });
});

describe("merge_group PR-context skips (#6295 item 2)", () => {
  it.each([
    [
      "packages/runtime/src/verify-source-cli/verify-closing-keywords.ts",
      "verify:closing-keywords",
    ],
    ["packages/runtime/src/verify-scope-provenance.ts", "verify:scope-provenance"],
    ["packages/runtime/src/verify-intent-constraint.ts", "verify:intent-constraint"],
    // #6296 item 6: the merge-base changelog check joins the PR-context checks.
    ["packages/runtime/src/changelog-check.ts", "verify:changelog-unreleased"],
    // #7147: class checks judge a change set, so they skip the group commit too.
    ["packages/runtime/src/verify-class-checks.ts", "verify:class-checks"],
  ])("%s skips itself on merge_group", (path, check) => {
    const src = readText(path);
    expect(src).toContain(`mergeGroupSkip("${check}", env)`);
  });

  it("scm/github.md names all five skipped checks, the change-set reason and the give-up (#7147)", () => {
    const doc = readText("scm/github.md");
    const bullet = doc.split("\n").find((line) => line.startsWith("- ! On `merge_group`, "));
    expect(bullet).toBeDefined();
    for (const check of [
      "verify:closing-keywords",
      "verify:scope-provenance",
      "verify:intent-constraint",
      "verify:changelog-unreleased",
      "verify:class-checks",
    ]) {
      expect(bullet).toContain(`\`${check}\``);
    }
    expect(bullet).toContain("on a group commit the change set holds every PR queued ahead");
    expect(bullet).toContain("What the queue no longer re-checks");
    expect(bullet).toContain("All other checks run on the group commit.");
    expect(bullet).not.toMatch(/already ran/);
  });
});

describe("merge queue docs (#6295 items 1, 5, 8)", () => {
  it("RELEASING.md lands release and policy commits through the queue as PRs", () => {
    const doc = readText("docs/RELEASING.md");
    expect(doc).toContain("## Merge queue on master (#6295)");
    expect(doc).toMatch(/Release and policy commits land through the queue as PRs/);
    expect(doc).toMatch(/Direct pushes to `master` are not part of the normal path/);
  });

  it("scm/github.md states queue mode, the six results, resume and consumer steps", () => {
    const doc = readText("scm/github.md");
    expect(doc).toContain("### Merge queue mode (#6295)");
    for (const result of [
      "head-changed",
      "merged",
      "queued",
      "awaiting-admission",
      "removed",
      "inactive",
    ]) {
      expect(doc).toContain(`\`${result}\``);
    }
    expect(doc).toContain("--resume --expect-head <sha> --since <time>");
    expect(doc).toMatch(/never falls back to `--admin`/);
    expect(doc).toMatch(/add `merge_group` to the workflows behind the required checks/);
  });
});
