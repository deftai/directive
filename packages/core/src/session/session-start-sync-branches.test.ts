import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "./git.js";
import { defaultBranchSync, parseDeferrals } from "./session-start.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sync-br-"));
  temps.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function gitStub(
  handler: (args: string[]) => { code: number; stdout: string; stderr: string },
): GitRunner {
  return (_r, args) => handler(args);
}

describe("defaultBranchSync branch coverage", () => {
  it("reports no default branch when candidates are empty", () => {
    const root = tmpRoot();
    const sync = defaultBranchSync(
      root,
      gitStub((args) => {
        if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
    );
    expect(sync.warning).toContain("Could not resolve");
  });

  it("uses master when symbolic-ref fails but origin/master exists", () => {
    const root = tmpRoot();
    const sync = defaultBranchSync(
      root,
      gitStub((args) => {
        if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/main") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "show-ref" && args[3] === "refs/remotes/origin/master") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return { code: 0, stdout: "origin/master", stderr: "" };
        }
        if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-list") return { code: 0, stdout: "0 0", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
    );
    expect(sync.branch).toBe("master");
    expect(sync.warning).toBeNull();
  });

  it("handles symbolic-ref without remote prefix slash", () => {
    const root = tmpRoot();
    const sync = defaultBranchSync(
      root,
      gitStub((args) => {
        if (args[0] === "symbolic-ref") return { code: 0, stdout: "main", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return { code: 0, stdout: "main", stderr: "" };
        }
        if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-list") return { code: 0, stdout: "0 0", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }),
    );
    expect(sync.branch).toBe("main");
  });

  it("singular and plural commit wording for ahead/behind", () => {
    const root = tmpRoot();
    const mk = (counts: string): GitRunner =>
      gitStub((args) => {
        if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
          return { code: 0, stdout: "origin/main", stderr: "" };
        }
        if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-list") return { code: 0, stdout: counts, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      });
    expect(defaultBranchSync(root, mk("1 0")).warning).toContain("1 commit");
    expect(defaultBranchSync(root, mk("0 1")).warning).toContain("1 commit");
    expect(defaultBranchSync(root, mk("0 2")).warning).toContain("2 commits");
  });

  it("handles rev-list failure and NaN counts", () => {
    const root = tmpRoot();
    const base = gitStub((args) => {
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "origin/main", stderr: "" };
      }
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(
      defaultBranchSync(root, (r, args) =>
        args[0] === "rev-list" ? { code: 1, stdout: "", stderr: "boom" } : base(r, args),
      ).warning,
    ).toContain("compare");
    expect(
      defaultBranchSync(root, (r, args) =>
        args[0] === "rev-list" ? { code: 0, stdout: "x y", stderr: "" } : base(r, args),
      ).warning,
    ).toContain("parse");
  });
});

it("prints orientation with checkout, HEAD, and ahead/behind vs default upstream", () => {
  const root = tmpRoot();
  let revListSpec: string | undefined;
  const sync = defaultBranchSync(
    root,
    gitStub((args) => {
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[2] === "HEAD") {
        return { code: 0, stdout: "fix/stale", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "origin/main", stderr: "" };
      }
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-list") {
        revListSpec = args[3];
        return { code: 0, stdout: "0 64", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }),
  );
  expect(revListSpec).toBe("HEAD...origin/main");
  expect(sync.head).toBe("fix/stale");
  expect(sync.ahead).toBe(0);
  expect(sync.behind).toBe(64);
  expect(sync.orientation).toContain(`checkout=${root}`);
  expect(sync.orientation).toContain("HEAD=fix/stale");
  expect(sync.orientation).toContain("ahead=0");
  expect(sync.orientation).toContain("behind=64");
  expect(sync.orientation).toContain("vs origin/main");
  expect(sync.warning).toContain("0 ahead");
  expect(sync.warning).toContain("64");
  expect(sync.warning).toContain("behind");
});

it("warns on fetch-fail with null counts and does not refuse", () => {
  const root = tmpRoot();
  const sync = defaultBranchSync(
    root,
    gitStub((args) => {
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[2] === "HEAD") {
        return { code: 0, stdout: "feature", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "origin/main", stderr: "" };
      }
      if (args[0] === "fetch") return { code: 1, stdout: "", stderr: "offline" };
      return { code: 0, stdout: "", stderr: "" };
    }),
  );
  expect(sync.ahead).toBeNull();
  expect(sync.behind).toBeNull();
  expect(sync.warning).toContain("refresh");
  expect(sync.orientation).toContain("ahead=unknown");
  expect(sync.orientation).toContain("behind=unknown");
  expect(sync.orientation).toContain("HEAD=feature");
});

it("warns when HEAD has diverged from the default upstream", () => {
  const root = tmpRoot();
  const sync = defaultBranchSync(
    root,
    gitStub((args) => {
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "rev-parse" && args[2] === "HEAD") {
        return { code: 0, stdout: "topic", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "origin/main", stderr: "" };
      }
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: "2 3", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }),
  );
  expect(sync.warning).toContain("diverged");
  expect(sync.orientation).toContain("ahead=2");
  expect(sync.orientation).toContain("behind=3");
});

describe("parseDeferrals branch coverage", () => {
  it("normalises step aliases and rejects bad input", () => {
    expect(parseDeferrals(["branch=ok"]).deferrals.branch_policy).toBe("ok");
    expect(parseDeferrals(["cache=ok"]).deferrals.cache_fresh).toBe("ok");
    expect(parseDeferrals(["triage=ok"]).deferrals.triage_welcome).toBe("ok");
    expect(parseDeferrals(["nope"]).errors[0]).toContain("step=reason");
    expect(parseDeferrals(["alignment="]).errors[0]).toContain("non-empty");
    expect(parseDeferrals(["bogus=x"]).errors[0]).toContain("unknown ritual step");
  });
});
