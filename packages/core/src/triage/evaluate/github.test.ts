import { describe, expect, it } from "vitest";
import { GhRestError } from "../../scm/gh-rest.js";
import {
  collectGithubCensus,
  pullsMentioning,
  snapshotFromIssuePayload,
  snapshotFromPullPayload,
} from "./github.js";

describe("github snapshots", () => {
  it("parses labels, closed state, and duplicate-of body", () => {
    const snap = snapshotFromIssuePayload({
      number: 12,
      state: "closed",
      title: "dup",
      body: "duplicate of #9",
      labels: [{ name: "bug" }, "triaged"],
      html_url: "https://example.test/12",
      pull_request: { url: "x" },
    });
    expect(snap.state).toBe("closed");
    expect(snap.labels).toEqual(["bug", "triaged"]);
    expect(snap.duplicateOf).toBe(9);
    expect(snap.pullRequest).toBe(true);
  });

  it("parses duplicate from label plus hash title", () => {
    const snap = snapshotFromIssuePayload({
      number: "8",
      labels: ["Duplicate"],
      title: "Copy of #3",
    });
    expect(snap.number).toBe(8);
    expect(snap.duplicateOf).toBe(3);
    expect(snap.state).toBe("open");
  });

  it("extracts PR mentions", () => {
    const pull = snapshotFromPullPayload({
      number: 99,
      title: "Fixes #42",
      body: "also issues/7",
      html_url: "https://example.test/99",
    });
    expect([...pull.mentions].sort((a, b) => a - b)).toEqual([7, 42]);
    expect(pullsMentioning([pull], 42)).toHaveLength(1);
    expect(pullsMentioning([pull], 1)).toHaveLength(0);
  });
});

describe("collectGithubCensus", () => {
  it("pages open pulls past the first 100 entries", () => {
    const pages: string[] = [];
    const runGhApiFn = (args: readonly string[]) => {
      if (args[0]?.includes("/issues/10")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ number: 10, state: "open", title: "ten", labels: [] }),
          stderr: "",
        };
      }
      if (args[0]?.endsWith("/issues")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (args[0]?.endsWith("/pulls")) {
        const pageField = args.find(
          (a, i) => args[i - 1] === "--raw-field" && a.startsWith("page="),
        );
        pages.push(pageField ?? "");
        if (pageField === "page=1") {
          return {
            returncode: 0,
            stdout: JSON.stringify(
              Array.from({ length: 100 }, (_, i) => ({
                number: i + 1,
                title: `p${i + 1}`,
                body: "",
              })),
            ),
            stderr: "",
          };
        }
        return {
          returncode: 0,
          stdout: JSON.stringify([{ number: 101, title: "p101", body: "Fixes #10" }]),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const census = collectGithubCensus("deftai/directive", [10], { runGhApiFn });
    expect(pages).toEqual(["page=1", "page=2"]);
    expect(census.openPulls).toHaveLength(101);
    expect(census.openPulls[100]?.mentions).toContain(10);
  });

  it("fails loud when a page past the cap still has open pulls", () => {
    const pages: string[] = [];
    const runGhApiFn = (args: readonly string[]) => {
      if (args[0]?.includes("/issues/10")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ number: 10, state: "open", title: "ten", labels: [] }),
          stderr: "",
        };
      }
      if (args[0]?.endsWith("/issues")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (args[0]?.endsWith("/pulls")) {
        const pageField = args.find(
          (a, i) => args[i - 1] === "--raw-field" && a.startsWith("page="),
        );
        pages.push(pageField ?? "");
        const page = Number.parseInt((pageField ?? "page=1").slice("page=".length), 10);
        const count = page > 50 ? 1 : 100;
        const start = (page - 1) * 100;
        return {
          returncode: 0,
          stdout: JSON.stringify(
            Array.from({ length: count }, (_, i) => ({
              number: start + i + 1,
              title: `p${String(start + i + 1)}`,
              body: "",
            })),
          ),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    try {
      collectGithubCensus("deftai/directive", [10], { runGhApiFn });
      expect.fail("expected truncated census to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GhRestError);
      expect(String(err)).toMatch(/open-pull census truncated: last page 50 was full/);
      expect(String(err)).toMatch(/page 51 has more/);
    }
    expect(pages).toContain("page=51");
  });

  it("returns the census when the cap page is full and the next page is empty", () => {
    const pages: string[] = [];
    const runGhApiFn = (args: readonly string[]) => {
      if (args[0]?.includes("/issues/10")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ number: 10, state: "open", title: "ten", labels: [] }),
          stderr: "",
        };
      }
      if (args[0]?.endsWith("/issues")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (args[0]?.endsWith("/pulls")) {
        const pageField = args.find(
          (a, i) => args[i - 1] === "--raw-field" && a.startsWith("page="),
        );
        pages.push(pageField ?? "");
        const page = Number.parseInt((pageField ?? "page=1").slice("page=".length), 10);
        if (page > 50) {
          return { returncode: 0, stdout: "[]", stderr: "" };
        }
        const start = (page - 1) * 100;
        return {
          returncode: 0,
          stdout: JSON.stringify(
            Array.from({ length: 100 }, (_, i) => ({
              number: start + i + 1,
              title: `p${String(start + i + 1)}`,
              body: "",
            })),
          ),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const census = collectGithubCensus("deftai/directive", [10], { runGhApiFn });
    expect(census.openPulls).toHaveLength(5000);
    expect(pages).toContain("page=51");
  });

  it("returns the census when the last page at the cap is short", () => {
    const runGhApiFn = (args: readonly string[]) => {
      if (args[0]?.includes("/issues/10")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ number: 10, state: "open", title: "ten", labels: [] }),
          stderr: "",
        };
      }
      if (args[0]?.endsWith("/issues")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (args[0]?.endsWith("/pulls")) {
        const pageField = args.find(
          (a, i) => args[i - 1] === "--raw-field" && a.startsWith("page="),
        );
        const page = Number.parseInt((pageField ?? "page=1").slice("page=".length), 10);
        const count = page === 50 ? 3 : 100;
        const start = (page - 1) * 100;
        return {
          returncode: 0,
          stdout: JSON.stringify(
            Array.from({ length: count }, (_, i) => ({
              number: start + i + 1,
              title: `p${String(start + i + 1)}`,
              body: "",
            })),
          ),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const census = collectGithubCensus("deftai/directive", [10], { runGhApiFn });
    expect(census.openPulls).toHaveLength(4903);
  });

  it("fails when an open-pull page GET is non-zero", () => {
    const runGhApiFn = (args: readonly string[]) => {
      if (args[0]?.includes("/issues/10")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ number: 10, state: "open", title: "ten", labels: [] }),
          stderr: "",
        };
      }
      if (args[0]?.endsWith("/issues")) {
        return { returncode: 0, stdout: "[]", stderr: "" };
      }
      if (args[0]?.endsWith("/pulls")) {
        return { returncode: 1, stdout: "", stderr: "rate limited" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    expect(() => collectGithubCensus("deftai/directive", [10], { runGhApiFn })).toThrow(
      /GET repos\/deftai\/directive\/pulls failed: rate limited/,
    );
  });

  it("uses GET-only rest seams", () => {
    const calls: string[][] = [];
    const runGhApiFn = (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0]?.includes("/issues/10")) {
        return {
          returncode: 0,
          stdout: JSON.stringify({ number: 10, state: "open", title: "ten", labels: [] }),
          stderr: "",
        };
      }
      if (args[0]?.endsWith("/issues")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([{ number: 10, state: "open", title: "ten", pull_request: null }]),
          stderr: "",
        };
      }
      if (args[0]?.endsWith("/pulls")) {
        return {
          returncode: 0,
          stdout: JSON.stringify([{ number: 1, title: "p", body: "Fixes #10" }]),
          stderr: "",
        };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const census = collectGithubCensus("deftai/directive", [10], { runGhApiFn });
    expect(census.issues[10]?.number).toBe(10);
    expect(census.openPulls[0]?.mentions).toContain(10);
    expect(calls.every((c) => !c.includes("POST") && !c.includes("PATCH"))).toBe(true);
  });
});
