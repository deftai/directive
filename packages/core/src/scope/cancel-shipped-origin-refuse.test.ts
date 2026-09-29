import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateCompletedTracked } from "../lifecycle/completed-tracked-on-delivery.js";
import { runTransition } from "./transition.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-cancel-refuse-"));
  temps.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["checkout", "-q", "-b", "master"]);
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function writeBrief(
  root: string,
  folder: string,
  name: string,
  plan: Record<string, unknown>,
): string {
  const dir = join(root, "xbrief", folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan,
    }),
    "utf8",
  );
  return path;
}

function writeCachedIssue(
  root: string,
  repo: string,
  number: number,
  state: "open" | "closed",
  stateReason?: string | null,
): void {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) {
    throw new Error(`invalid repo slug: ${repo}`);
  }
  const dir = join(root, ".deft-cache", "github-issue", owner, name, String(number));
  mkdirSync(dir, { recursive: true });
  const payload: Record<string, unknown> = { number, state };
  if (stateReason !== undefined) {
    payload.state_reason = stateReason;
  }
  writeFileSync(join(dir, "raw.json"), JSON.stringify(payload), "utf8");
}

const originPlan = (number: number, status: string): Record<string, unknown> => ({
  status,
  title: `story ${number}`,
  items: [],
  references: [
    {
      uri: `https://github.com/deftai/directive/issues/${number}`,
      type: "x-xbrief/github-issue",
    },
  ],
});

describe("scope:cancel shipped-origin refuse (#5126)", () => {
  it("refuses cancel when origin is shipped-closed without completed tip twin", () => {
    const root = makeRepo();
    const active = writeBrief(root, "active", "shipped.xbrief.json", originPlan(51261, "running"));
    writeCachedIssue(root, "deftai/directive", 51261, "closed", "completed");
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
      repo: "deftai/directive",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("scope:cancel: refused");
    expect(result.message).toContain("leftover-complete");
    expect(result.message).toContain("task scope:complete -- xbrief/active/shipped.xbrief.json");
    expect(result.message).toContain("swarm:finalize-cohort -- --pr <n> / --stories 51261");
    expect(result.message).not.toContain("--merge-commit .");
    expect(result.message).toContain("51261");
    expect(readFileSync(active, "utf8")).toContain('"status":"running"');
  });

  it("allows cancel when origin is open (true abandon)", () => {
    const root = makeRepo();
    const active = writeBrief(
      root,
      "active",
      "open-abandon.xbrief.json",
      originPlan(51262, "running"),
    );
    writeCachedIssue(root, "deftai/directive", 51262, "open", null);
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
      repo: "deftai/directive",
    });
    expect(result.ok).toBe(true);
    expect(
      readFileSync(join(root, "xbrief", "cancelled", "open-abandon.xbrief.json"), "utf8"),
    ).toContain('"status": "cancelled"');
  });

  it("allows cancel when origin is abandoned-closed (not_planned)", () => {
    const root = makeRepo();
    const active = writeBrief(
      root,
      "active",
      "not-planned.xbrief.json",
      originPlan(51263, "running"),
    );
    writeCachedIssue(root, "deftai/directive", 51263, "closed", "not_planned");
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
      repo: "deftai/directive",
    });
    expect(result.ok).toBe(true);
  });

  it("allows cancel when shipped-closed and completed tip twin exists", () => {
    const root = makeRepo();
    const active = writeBrief(root, "active", "twinned.xbrief.json", originPlan(51264, "running"));
    writeBrief(root, "completed", "landed.xbrief.json", originPlan(51264, "completed"));
    writeCachedIssue(root, "deftai/directive", 51264, "closed", "completed");
    git(root, ["add", "xbrief/completed/landed.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "land completed twin"]);
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
      repo: "deftai/directive",
    });
    expect(result.ok).toBe(true);
  });

  it("does not green cancel refuse on cancelled-only tip twin", () => {
    const root = makeRepo();
    const active = writeBrief(
      root,
      "active",
      "cancelled-only.xbrief.json",
      originPlan(51265, "running"),
    );
    writeBrief(root, "cancelled", "landed-cancel.xbrief.json", {
      ...originPlan(51265, "cancelled"),
    });
    writeCachedIssue(root, "deftai/directive", 51265, "closed", "completed");
    git(root, ["add", "xbrief/cancelled/landed-cancel.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "land cancelled only"]);
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
      repo: "deftai/directive",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("leftover-complete");
  });

  it("prefers live completed over stale cached not_planned (#5126 Greptile P1)", () => {
    const root = makeRepo();
    const active = writeBrief(
      root,
      "active",
      "stale-abandon.xbrief.json",
      originPlan(51267, "running"),
    );
    writeCachedIssue(root, "deftai/directive", 51267, "closed", "not_planned");
    const result = runTransition("cancel", active, new Date(), {
      tip: "HEAD",
      repo: "deftai/directive",
      runGh: () => ({
        returncode: 0,
        stdout: JSON.stringify({
          number: 51267,
          state: "closed",
          state_reason: "completed",
        }),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("scope:cancel: refused");
    expect(result.message).toContain("leftover-complete");
    expect(result.message).toContain(
      "task scope:complete -- xbrief/active/stale-abandon.xbrief.json",
    );
  });

  it("skipGh still honors cached not_planned as abandon", () => {
    const root = makeRepo();
    const active = writeBrief(
      root,
      "active",
      "skipgh-abandon.xbrief.json",
      originPlan(51268, "running"),
    );
    writeCachedIssue(root, "deftai/directive", 51268, "closed", "not_planned");
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
      repo: "deftai/directive",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses cancel on live lookup failure with stale cached open (#5126 Greptile P1)", () => {
    const root = makeRepo();
    const active = writeBrief(
      root,
      "active",
      "stale-open-live-fail.xbrief.json",
      originPlan(51269, "running"),
    );
    writeCachedIssue(root, "deftai/directive", 51269, "open", null);
    const result = runTransition("cancel", active, new Date(), {
      tip: "HEAD",
      repo: "deftai/directive",
      runGh: () => ({
        returncode: 1,
        stdout: "",
        stderr: "API rate limit exceeded",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("scope:cancel: refused");
    expect(result.message).toContain("could not resolve closed state");
    expect(readFileSync(active, "utf8")).toContain('"status":"running"');
  });

  it("refuses cancel on live lookup failure with stale cached abandon (#5126)", () => {
    const root = makeRepo();
    const active = writeBrief(
      root,
      "active",
      "stale-abandon-live-fail.xbrief.json",
      originPlan(51270, "running"),
    );
    writeCachedIssue(root, "deftai/directive", 51270, "closed", "not_planned");
    const result = runTransition("cancel", active, new Date(), {
      tip: "HEAD",
      repo: "deftai/directive",
      runGh: () => ({
        returncode: 1,
        stdout: "",
        stderr: "API rate limit exceeded",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("scope:cancel: refused");
    expect(result.message).toContain("could not resolve closed state");
  });

  it("verify:completed-tracked exits 1 until completed twin exists (#5126 fixture)", () => {
    const root = makeRepo();
    writeBrief(root, "active", "tracking.xbrief.json", originPlan(51266, "running"));
    writeCachedIssue(root, "deftai/directive", 51266, "closed", "completed");
    const before = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 51266,
    });
    expect(before.code).toBe(1);

    writeBrief(root, "completed", "tracking.xbrief.json", originPlan(51266, "completed"));
    git(root, ["add", "xbrief/completed/tracking.xbrief.json"]);
    git(root, ["commit", "-q", "-m", "leftover-complete"]);
    const after = evaluateCompletedTracked(root, {
      repo: "deftai/directive",
      skipGh: true,
      tip: "HEAD",
      issue: 51266,
    });
    expect(after.code).toBe(0);
  });
  it("allows cancel when open origin + closed decomposition parent without twin (#5126 P1)", () => {
    const root = makeRepo();
    const plan = {
      ...originPlan(51271, "running"),
      metadata: {
        "x-tracking": {
          parent_issue: 51271,
          decomposition_origin: 59999,
        },
      },
    };
    const active = writeBrief(root, "active", "decomp-parent.xbrief.json", plan);
    writeCachedIssue(root, "deftai/directive", 51271, "open", null);
    writeCachedIssue(root, "deftai/directive", 59999, "closed", "completed");
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
      repo: "deftai/directive",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses cancel when bare x-tracking origin has no resolvable repo (#5126 P1)", () => {
    const root = makeRepo();
    const plan = {
      status: "running",
      title: "bare tracking",
      items: [],
      references: [],
      metadata: { "x-tracking": { parent_issue: 51272 } },
    };
    const active = writeBrief(root, "active", "bare-repo.xbrief.json", plan);
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no resolvable GitHub repo");
  });

  it("prefers live reopen over stale cached completed (#5126 P1)", () => {
    const root = makeRepo();
    const active = writeBrief(
      root,
      "active",
      "stale-completed-reopen.xbrief.json",
      originPlan(51273, "running"),
    );
    writeCachedIssue(root, "deftai/directive", 51273, "closed", "completed");
    const result = runTransition("cancel", active, new Date(), {
      tip: "HEAD",
      repo: "deftai/directive",
      runGh: () => ({
        returncode: 0,
        stdout: JSON.stringify({
          number: 51273,
          state: "open",
          state_reason: null,
        }),
      }),
    });
    expect(result.ok).toBe(true);
  });
  it("refuses when bare origin unresolved even if a full-URL origin is open (#5126 P1)", () => {
    const root = makeRepo();
    const plan = {
      status: "running",
      title: "mixed",
      items: [],
      references: [
        {
          uri: "https://github.com/deftai/directive/issues/51274",
          type: "x-xbrief/github-issue",
        },
        {
          uri: "51275",
          type: "x-xbrief/github-issue",
        },
      ],
    };
    const active = writeBrief(root, "active", "mixed-bare.xbrief.json", plan);
    writeCachedIssue(root, "deftai/directive", 51274, "open", null);
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
      // no repo — bare 51275 cannot resolve
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no resolvable GitHub repo");
  });

  it("accepts x-tracking.parent_issue GitHub URL as origin (#5126 P1)", () => {
    const root = makeRepo();
    const plan = {
      status: "running",
      title: "parent-url-origin",
      items: [],
      references: [],
      metadata: {
        "x-tracking": {
          parent_issue: "https://github.com/deftai/directive/issues/51276",
        },
      },
    };
    const active = writeBrief(root, "active", "parent-url-origin.xbrief.json", plan);
    writeCachedIssue(root, "deftai/directive", 51276, "closed", "completed");
    const result = runTransition("cancel", active, new Date(), {
      skipGh: true,
      tip: "HEAD",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("leftover-complete");
  });
});
