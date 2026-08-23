import { describe, expect, it } from "vitest";
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
