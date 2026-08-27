import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import {
  AGGREGATE_LATENCY_BUDGET_MS,
  formatAge,
  ISSUE_CACHE_MAX_AGE_MS,
  makeGateRunner,
  OpenIssueInventory,
  type ResolveContext,
  readCachedIssue,
  resolveIssueStateAggregate,
  resolveIssueStateScoped,
  SCOPED_LATENCY_BUDGET_MS,
} from "./issue-state.js";
import type { IssueRef } from "./refs.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

const NOW = Date.parse("2026-08-26T18:00:00Z");
const REF: IssueRef = { repo: "deftai/directive", number: 3611 };

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-issue-state-"));
  temps.push(root);
  return root;
}

function writeCache(
  root: string,
  ref: IssueRef,
  state: "open" | "closed",
  fetchedAtMs: number = NOW,
): void {
  const [owner, name] = ref.repo.split("/", 2) as [string, string];
  const dir = join(root, ".deft-cache", "github-issue", owner, name, String(ref.number));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "raw.json"), JSON.stringify({ number: ref.number, state }), "utf8");
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ fetched_at: new Date(fetchedAtMs).toISOString() }),
    "utf8",
  );
}

function inventoryPayload(numbers: readonly number[]): string {
  return JSON.stringify([numbers.map((number) => ({ number }))]);
}

function context(root: string, runGh: RunGhFn, skipGh = false): ResolveContext {
  return {
    projectRoot: root,
    runGh,
    skipGh,
    nowMs: NOW,
    inventory: new OpenIssueInventory(runGh),
  };
}

const NEVER_CALLED: RunGhFn = () => {
  throw new Error("runGh must not be called");
};

const ALWAYS_FAILS: RunGhFn = () => ({ returncode: 1, stdout: "", stderr: "api failed" });

describe("formatAge", () => {
  it("renders seconds, minutes, hours, and days", () => {
    expect(formatAge(4_000)).toBe("4s");
    expect(formatAge(9 * 60_000)).toBe("9m");
    expect(formatAge(12 * 3_600_000)).toBe("12h");
    expect(formatAge(5 * 24 * 3_600_000)).toBe("5d");
  });
});

describe("readCachedIssue", () => {
  it("prefers meta.json fetched_at for the entry age", () => {
    const root = makeRoot();
    writeCache(root, REF, "open", NOW - 3 * 3_600_000);
    expect(readCachedIssue(root, REF, NOW)).toEqual({ state: "open", ageMs: 3 * 3_600_000 });
  });

  it("falls back to raw.json mtime when meta.json is absent", () => {
    const root = makeRoot();
    const dir = join(root, ".deft-cache", "github-issue", "deftai", "directive", "3611");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "raw.json"), JSON.stringify({ state: "closed" }), "utf8");
    const cached = readCachedIssue(root, REF, Date.now());
    expect(cached.state).toBe("closed");
    expect(cached.ageMs).not.toBeNull();
    expect(cached.ageMs ?? Number.POSITIVE_INFINITY).toBeLessThan(60_000);
  });

  it("reports a miss for absent, unparseable, and unknown-state entries", () => {
    const root = makeRoot();
    expect(readCachedIssue(root, REF, NOW)).toEqual({ state: null, ageMs: null });

    const dir = join(root, ".deft-cache", "github-issue", "deftai", "directive", "3611");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "raw.json"), "not-json", "utf8");
    expect(readCachedIssue(root, REF, NOW).state).toBeNull();

    writeFileSync(join(dir, "raw.json"), JSON.stringify({ state: "merged" }), "utf8");
    expect(readCachedIssue(root, REF, NOW).state).toBeNull();
  });

  it("reports a miss for a malformed repo slug", () => {
    const root = makeRoot();
    expect(readCachedIssue(root, { repo: "no-slash", number: 1 }, NOW).state).toBeNull();
  });
});

describe("resolveIssueStateScoped", () => {
  it("prefers the authoritative read over a fresh cached open", () => {
    const root = makeRoot();
    writeCache(root, REF, "open");
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify({ state: "closed" }),
      stderr: "",
    });
    expect(resolveIssueStateScoped(REF, context(root, runGh))).toEqual({
      state: "closed",
      basis: "live",
    });
  });

  it("accepts a cache hit inside the freshness bound when the live read fails", () => {
    const root = makeRoot();
    writeCache(root, REF, "open", NOW - 60_000);
    const resolved = resolveIssueStateScoped(REF, context(root, ALWAYS_FAILS));
    expect(resolved.state).toBe("open");
    expect(resolved.basis).toBe("cache");
    expect(resolved.cacheAgeMs).toBe(60_000);
  });

  it("refuses a cache hit past the freshness bound", () => {
    const root = makeRoot();
    writeCache(root, REF, "open", NOW - ISSUE_CACHE_MAX_AGE_MS - 1_000);
    const resolved = resolveIssueStateScoped(REF, context(root, ALWAYS_FAILS));
    expect(resolved.state).toBeNull();
    expect(resolved.basis).toBe("unverified");
    expect(resolved.detail).toContain("cached open is");
  });

  it("reports unverified with no cache entry and no network", () => {
    const root = makeRoot();
    const resolved = resolveIssueStateScoped(REF, context(root, NEVER_CALLED, true));
    expect(resolved.basis).toBe("unverified");
    expect(resolved.detail).toContain("--skip-gh");
  });

  it("reports unverified for a repo slug that is not owner/repo", () => {
    const root = makeRoot();
    const ref: IssueRef = { repo: "a/../../../evil", number: 1 };
    const resolved = resolveIssueStateScoped(ref, context(root, NEVER_CALLED));
    expect(resolved.basis).toBe("unverified");
    expect(resolved.detail).toContain("not a valid owner/repo slug");
  });

  it("ignores a non-JSON and a non-object live payload", () => {
    const root = makeRoot();
    const notJson: RunGhFn = () => ({ returncode: 0, stdout: "{oops", stderr: "" });
    expect(resolveIssueStateScoped(REF, context(root, notJson)).basis).toBe("unverified");
    const notObject: RunGhFn = () => ({ returncode: 0, stdout: "42", stderr: "" });
    expect(resolveIssueStateScoped(REF, context(root, notObject)).basis).toBe("unverified");
    const noState: RunGhFn = () => ({ returncode: 0, stdout: "{}", stderr: "" });
    expect(resolveIssueStateScoped(REF, context(root, noState)).basis).toBe("unverified");
  });
});

describe("resolveIssueStateAggregate", () => {
  it("resolves open from the inventory without a per-issue read", () => {
    const root = makeRoot();
    const calls: string[] = [];
    const runGh: RunGhFn = (cmd) => {
      calls.push(cmd.join(" "));
      return { returncode: 0, stdout: inventoryPayload([3611, 3767]), stderr: "" };
    };
    const ctx = context(root, runGh);
    expect(resolveIssueStateAggregate(REF, ctx).state).toBe("open");
    expect(resolveIssueStateAggregate({ repo: REF.repo, number: 3767 }, ctx).state).toBe("open");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--paginate --slurp");
  });

  it("confirms an apparent close with one authoritative read before reporting closed", () => {
    const root = makeRoot();
    const calls: string[] = [];
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      calls.push(joined);
      if (joined.includes("--slurp")) {
        return { returncode: 0, stdout: inventoryPayload([1]), stderr: "" };
      }
      return { returncode: 0, stdout: JSON.stringify({ state: "closed" }), stderr: "" };
    };
    const resolved = resolveIssueStateAggregate(REF, context(root, runGh));
    expect(resolved).toEqual({ state: "closed", basis: "live" });
    expect(calls).toHaveLength(2);
  });

  it("reuses a confirming read when several briefs name the same absent issue", () => {
    const root = makeRoot();
    const calls: string[] = [];
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      calls.push(joined);
      if (joined.includes("--slurp")) {
        return { returncode: 0, stdout: inventoryPayload([1]), stderr: "" };
      }
      return { returncode: 0, stdout: JSON.stringify({ state: "closed" }), stderr: "" };
    };
    const ctx = context(root, runGh);
    const first = resolveIssueStateAggregate(REF, ctx);
    const second = resolveIssueStateAggregate(REF, ctx);
    expect(first).toEqual({ state: "closed", basis: "live" });
    expect(second).toEqual({ state: "closed", basis: "live" });
    expect(calls.filter((c) => !c.includes("--slurp"))).toHaveLength(1);
  });

  it("treats an inventory absence whose confirming read fails as unverified, not closed", () => {
    const root = makeRoot();
    const runGh: RunGhFn = (cmd) =>
      cmd.join(" ").includes("--slurp")
        ? { returncode: 0, stdout: inventoryPayload([1]), stderr: "" }
        : { returncode: 1, stdout: "", stderr: "rate limited" };
    const resolved = resolveIssueStateAggregate(REF, context(root, runGh));
    expect(resolved.state).toBeNull();
    expect(resolved.basis).toBe("unverified");
    expect(resolved.detail).toContain("confirming read failed");
  });

  it("does not report closed when the inventory command fails", () => {
    const root = makeRoot();
    const resolved = resolveIssueStateAggregate(REF, context(root, ALWAYS_FAILS));
    expect(resolved.state).toBeNull();
    expect(resolved.basis).toBe("unverified");
    expect(resolved.detail).toContain("open-issue inventory unavailable");
  });

  it("does not report closed when the inventory payload is not a list", () => {
    const root = makeRoot();
    const runGh: RunGhFn = () => ({ returncode: 0, stdout: '{"total":5}', stderr: "" });
    const resolved = resolveIssueStateAggregate(REF, context(root, runGh));
    expect(resolved.basis).toBe("unverified");
    expect(resolved.detail).toContain("open-issue inventory unavailable");
  });

  it("falls back to a fresh cache hit when the inventory is unavailable", () => {
    const root = makeRoot();
    writeCache(root, REF, "open", NOW - 30_000);
    const resolved = resolveIssueStateAggregate(REF, context(root, ALWAYS_FAILS));
    expect(resolved.state).toBe("open");
    expect(resolved.basis).toBe("cache");
  });

  it("honours a fresh cache hit under --skip-gh and refuses a stale one", () => {
    const root = makeRoot();
    writeCache(root, REF, "closed", NOW - 60_000);
    expect(resolveIssueStateAggregate(REF, context(root, NEVER_CALLED, true))).toMatchObject({
      state: "closed",
      basis: "cache",
    });

    writeCache(root, REF, "closed", NOW - 12 * 3_600_000);
    const stale = resolveIssueStateAggregate(REF, context(root, NEVER_CALLED, true));
    expect(stale.state).toBeNull();
    expect(stale.detail).toContain("cached closed is 12h old");
  });

  it("reports unverified under --skip-gh with no cache entry", () => {
    const root = makeRoot();
    const resolved = resolveIssueStateAggregate(REF, context(root, NEVER_CALLED, true));
    expect(resolved.detail).toBe("--skip-gh with no cache entry");
  });

  it("reports unverified for a repo slug that is not owner/repo", () => {
    const root = makeRoot();
    const ref: IssueRef = { repo: "a/../../../evil", number: 1 };
    expect(resolveIssueStateAggregate(ref, context(root, NEVER_CALLED)).basis).toBe("unverified");
  });
});

describe("OpenIssueInventory", () => {
  it("memoises per repo and reports the failure reason once", () => {
    let calls = 0;
    const runGh: RunGhFn = () => {
      calls += 1;
      return { returncode: 1, stdout: "", stderr: "gh: bad credentials" };
    };
    const inventory = new OpenIssueInventory(runGh);
    const first = inventory.lookup("deftai/directive");
    const second = inventory.lookup("deftai/directive");
    expect(first).toBe(second);
    expect(calls).toBe(1);
    expect("error" in first && first.error).toContain("gh api failed");
  });

  it("skips rows without an integer number", () => {
    const runGh: RunGhFn = () => ({
      returncode: 0,
      stdout: JSON.stringify([[{ number: 7 }, { number: "8" }, { title: "no number" }]]),
      stderr: "",
    });
    const looked = new OpenIssueInventory(runGh).lookup("deftai/directive");
    expect("numbers" in looked && [...looked.numbers]).toEqual([7]);
  });

  it("reports an invalid repo slug as an inventory error", () => {
    const looked = new OpenIssueInventory(NEVER_CALLED).lookup("not-a-slug");
    expect("error" in looked).toBe(true);
  });
});

describe("budgets and runner", () => {
  it("records a smaller budget for scoped than for aggregate mode", () => {
    expect(SCOPED_LATENCY_BUDGET_MS).toBeLessThan(AGGREGATE_LATENCY_BUDGET_MS);
    expect(AGGREGATE_LATENCY_BUDGET_MS).toBeGreaterThan(4_200);
  });

  it("returns a runner and states whether reads are proxied", () => {
    const runner = makeGateRunner();
    expect(typeof runner.runGh).toBe("function");
    expect(typeof runner.proxied).toBe("boolean");
  });
});
