import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../scm/binary.js", () => ({
  resolveBinary: () => "gh",
  defaultWhich: (name: string) => (name === "gh" ? "gh" : null),
}));

vi.mock("../scm/call-shape.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scm/call-shape.js")>();
  return {
    ...actual,
    resolveBinaryForArgv: () => "gh",
  };
});

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { runCurrentShape } from "./index.js";

const SAMPLE_BODY =
  "## Current shape (as of pass-2)\n\n" +
  "Last updated: 2026-06-28T12:00:00Z\n" +
  "Last pass type: additive\n" +
  "Child count: 3 (2/1)\n" +
  "Child-count history: pass-1: 2, pass-2: 3\n\n" +
  "### Open children\n\n- a\n\n" +
  "### Closed children\n\n- b\n\n" +
  "### Wave order\n\n- Wave 1: a\n\n" +
  "### Reading order for fresh contributors\n\n1. body";

describe("defaultFetchComments gh integration", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("passes --paginate to gh api and succeeds", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      // #2307: the selected comment must be maintainer-authored to be trusted.
      stdout: JSON.stringify([
        { id: 1, body: SAMPLE_BODY, user: { login: "maint" }, author_association: "MEMBER" },
      ]),
      stderr: "",
      pid: 1,
      output: [null, "", ""],
      signal: null,
      error: undefined,
    });
    expect(
      runCurrentShape({
        issueNumber: 1119,
        projectRoot: "/tmp",
        repo: "deftai/directive",
        writeOut: () => {},
        writeErr: () => {},
      }),
    ).toBe(0);
    expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).toEqual([
      "api",
      "--paginate",
      "repos/deftai/directive/issues/1119/comments?per_page=100",
    ]);
  });

  it("returns exit 2 when gh api fails", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "rate limited",
      pid: 1,
      output: [null, "", "rate limited"],
      signal: null,
      error: undefined,
    });
    const errLines: string[] = [];
    expect(
      runCurrentShape({
        issueNumber: 1119,
        projectRoot: "/tmp",
        repo: "deftai/directive",
        writeOut: () => {},
        writeErr: (t) => errLines.push(t),
      }),
    ).toBe(2);
    expect(errLines.join("")).toContain("rate limited");
  });

  it("returns exit 2 when spawnSync errors", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [null, "", ""],
      signal: null,
      error: new Error("ENOENT gh"),
    });
    expect(
      runCurrentShape({
        issueNumber: 1119,
        projectRoot: "/tmp",
        repo: "deftai/directive",
        writeOut: () => {},
        writeErr: () => {},
      }),
    ).toBe(2);
  });

  it("returns exit 2 when paginated output is invalid JSON", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "[{broken",
      stderr: "",
      pid: 1,
      output: [null, "[{broken", ""],
      signal: null,
      error: undefined,
    });
    expect(
      runCurrentShape({
        issueNumber: 1119,
        projectRoot: "/tmp",
        repo: "deftai/directive",
        writeOut: () => {},
        writeErr: () => {},
      }),
    ).toBe(2);
  });
});
