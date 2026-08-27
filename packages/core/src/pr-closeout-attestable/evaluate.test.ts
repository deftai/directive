import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import { evaluate, type FetchClosingIssuesFn } from "./evaluate.js";

const REPO = "deftai/directive";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-closeout-attestable-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  return root;
}

function writeBrief(root: string, name: string, plan: Record<string, unknown>): string {
  const path = join(root, "xbrief", "active", name);
  writeFileSync(
    path,
    `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

function issueRef(number: number): Record<string, unknown> {
  return {
    uri: `https://github.com/${REPO}/issues/${number}`,
    type: "x-xbrief/github-issue",
    title: `Issue #${number}`,
  };
}

/** Five bare `title` + `status: proposed` items — the exact #3609 brief shape. */
function bareItems(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `Acceptance criterion ${i + 1}`,
    status: "proposed",
  }));
}

function attestedItem(title: string): Record<string, unknown> {
  return {
    title,
    status: "proposed",
    "x-directive/evidence": {
      kind: "merge",
      pointer: `https://github.com/${REPO}/pull/3786`,
      recorded_at: "2026-08-27T02:23:58Z",
      recorded_by: "swarm:finalize-cohort",
    },
  };
}

function closing(...issues: number[]): FetchClosingIssuesFn {
  return () => [...issues];
}

const NEVER_CALLED: RunGhFn = () => {
  throw new Error("runGh must not be called");
};

function opts(fetchClosingIssues: FetchClosingIssuesFn, proxied = false) {
  return { repo: REPO, runner: { runGh: NEVER_CALLED, proxied }, fetchClosingIssues };
}

describe("pr-closeout-attestable evaluate", () => {
  it("fails closed when the PR closes an issue whose running brief is unattested", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    const result = evaluate(root, 3786, opts(closing(3609)));

    expect(result.code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.issue).toBe(3609);
    expect(result.findings[0]?.unattested).toHaveLength(5);
  });

  it("passes when every non-terminal criterion carries evidence", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: [attestedItem("only criterion")],
    });

    const result = evaluate(root, 3786, opts(closing(3609)));

    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.message).toContain("#3609");
  });

  it("leaves an unattested brief alone when the PR does not close its issue", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    const result = evaluate(root, 3786, opts(closing(3610)));

    expect(result.code).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("passes when the PR closes nothing", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    const result = evaluate(root, 3786, opts(closing()));

    expect(result.code).toBe(0);
    expect(result.message).toContain("closes no issue");
  });

  it("ignores briefs whose status is not running", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "paused",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    expect(evaluate(root, 3786, opts(closing(3609))).code).toBe(0);
  });

  it("refuses to certify a merge when the closing-reference lookup fails", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(5),
    });

    const result = evaluate(
      root,
      3786,
      opts(() => null),
    );

    expect(result.code).toBe(2);
    expect(result.message).toContain("could not read closing-issue references");
  });

  it("reports config error for a missing project root", () => {
    const result = evaluate(join(tmpdir(), "deft-closeout-absent-root"), 1, opts(closing(1)));
    expect(result.code).toBe(2);
  });

  it("passes cleanly when the project has no xbrief/ lifecycle root", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-closeout-nolayout-"));
    temps.push(root);
    const result = evaluate(root, 1, opts(closing(1)));
    expect(result.code).toBe(0);
    expect(result.message).toContain("nothing to check");
  });

  it("walks nested subItems and items", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: [
        {
          ...attestedItem("parent"),
          subItems: [{ title: "nested", status: "proposed" }],
        },
      ],
    });

    const result = evaluate(root, 3786, opts(closing(3609)));

    expect(result.code).toBe(1);
    expect(result.findings[0]?.unattested.map((c) => c.path)).toEqual(["items[0].subItems[0]"]);
  });
});

describe("pr-closeout-attestable failure message", () => {
  function refusalFor(items: Record<string, unknown>[]): string {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items,
    });
    const result = evaluate(root, 3786, opts(closing(3609)));
    expect(result.code).toBe(1);
    return result.message;
  }

  it("names every unattested criterion and the shape it needs", () => {
    const message = refusalFor(bareItems(5));

    for (let i = 1; i <= 5; i += 1) {
      expect(message).toContain(`Acceptance criterion ${i}`);
    }
    expect(message).toContain(
      "x-directive/evidence {kind: test|review|merge|deploy|smoke|uat|observed_behavior, pointer, recorded_at, recorded_by}",
    );
    expect(message).toContain(
      "x-directive/disposition {disposition: waived|deferred|not_applicable, reason, " +
        "provenance {kind: operator-cli|operator-session|human-event, actor: <non-agent>}, recorded_at}",
    );
  });

  it("narrows the kind taxonomy for a criterion that requires one strict axis", () => {
    const message = refusalFor([{ title: "Smoke the new worker", status: "proposed" }]);

    expect(message).toContain(
      "x-directive/evidence {kind: smoke, pointer, recorded_at, recorded_by}",
    );
    expect(message).toContain("merge and review evidence cannot satisfy it");
    // The generic taxonomy must not be offered for a strict-axis criterion.
    expect(message).not.toContain("{kind: test|review|merge|");
  });

  it("says no single kind works when a criterion infers two strict axes", () => {
    const message = refusalFor([{ title: "Smoke the deployed worker", status: "proposed" }]);

    expect(message).toContain("requires smoke + deploy");
    expect(message).toContain("no single evidence.kind covers");
    expect(message).toContain('pin one axis with "requires": "smoke"');
    expect(message).toContain("split the criterion one axis per item");
  });

  it("states the trigger and a remediation the PR author can perform", () => {
    const message = refusalFor(bareItems(1));

    expect(message).toContain("closing references, not the branch diff");
    expect(message).toContain("task verify:pr-closeout-attestable -- --pr 3786");
    expect(message).toContain("recorded_by accepts any non-empty string");
    expect(message).not.toContain("cached");
  });

  it("discloses the ghx cache caveat when the read could not be pinned to gh", () => {
    const root = makeRepo();
    writeBrief(root, "2026-08-26-3609-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3609)],
      items: bareItems(1),
    });

    const refused = evaluate(root, 3786, opts(closing(3609), true));
    expect(refused.code).toBe(1);
    expect(refused.proxied).toBe(true);
    expect(refused.message).toContain("cached");

    const passed = evaluate(root, 3786, opts(closing(3610), true));
    expect(passed.code).toBe(0);
    expect(passed.message).toContain("cached");
  });
});

/**
 * #3598 regression: the brief landed on master seventeen hours before the PR that
 * closed its issue, so the closing PR's diff never touches it. A diff-keyed gate
 * misses the culprit entirely; the closing reference still fires.
 */
describe("pr-closeout-attestable #3598 shape (brief predates the closing branch)", () => {
  function git(root: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  it("fires on the closing reference even though the brief is absent from the branch diff", () => {
    const root = makeRepo();
    git(root, ["init", "-q", "-b", "master"]);
    git(root, ["config", "user.email", "ci@example.com"]);
    git(root, ["config", "user.name", "ci"]);

    // The brief lands on master first — the normal promote/activate lifecycle.
    writeBrief(root, "2026-08-25-3598-story.xbrief.json", {
      title: "story",
      status: "running",
      references: [issueRef(3598)],
      items: bareItems(3),
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "chore(xbrief): activate the #3598 brief"]);

    // The closing PR branches later and touches only unrelated source.
    git(root, ["switch", "-q", "-c", "fix/3598-implementation"]);
    writeFileSync(join(root, "src.ts"), "export const fixed = true;\n", "utf8");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "fix: implement #3598"]);

    const changed = git(root, ["diff", "--name-only", "master...HEAD"])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(changed).toEqual(["src.ts"]);

    const result = evaluate(root, 3775, opts(closing(3598)));

    expect(result.code).toBe(1);
    expect(result.findings[0]?.briefPath).toBe("xbrief/active/2026-08-25-3598-story.xbrief.json");
    expect(result.findings[0]?.unattested).toHaveLength(3);
  });
});
