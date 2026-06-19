import { describe, expect, it, vi } from "vitest";
import * as ghRest from "./gh-rest.js";
import { GhRestError } from "./gh-rest.js";
import { main } from "./main.js";
import * as restDispatch from "./rest-dispatch.js";

describe("main", () => {
  it("returns 2 for usage errors", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main([])).toBe(2);
    expect(stderr.mock.calls.join("")).toContain("usage:");
    stderr.mockRestore();
  });

  it("returns 2 for unknown namespace", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main(["isue", "list"], { whichFn: () => "/usr/bin/gh" })).toBe(2);
    expect(stderr.mock.calls.join("")).toContain("unknown scm namespace");
    stderr.mockRestore();
  });

  it("rejects --rest on close", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main(["issue", "close", "--rest", "1", "--repo", "deftai/directive"])).toBe(2);
    expect(stderr.mock.calls.join("")).toContain("--rest is only supported");
    stderr.mockRestore();
  });

  it("routes issue view --rest through REST dispatcher", () => {
    const spy = vi.spyOn(restDispatch, "runRestView").mockReturnValue({
      exitCode: 0,
      stdout: '{"number": 1}\n',
      stderr: "",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(main(["issue", "view", "--rest", "1", "--repo", "deftai/directive"])).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    stdout.mockRestore();
  });

  it("routes issue list --rest through REST dispatcher", () => {
    const spy = vi.spyOn(restDispatch, "runRestList").mockReturnValue({
      exitCode: 0,
      stdout: '[{"number": 1}]\n',
      stderr: "",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(main(["issue", "list", "--rest", "--repo", "deftai/directive"])).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    stdout.mockRestore();
  });
});

describe("runRestView", () => {
  it("filters json fields on success", () => {
    vi.spyOn(ghRest, "restIssueView").mockReturnValue({
      number: 1,
      title: "REST migration smoke",
      state: "open",
    });
    const result = restDispatch.runRestView([
      "1",
      "--repo",
      "deftai/directive",
      "--json",
      "number,title",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('{"number": 1, "title": "REST migration smoke"}\n');
    vi.restoreAllMocks();
  });

  it("surfaces GhRestError as exit 1", () => {
    vi.spyOn(ghRest, "restIssueView").mockImplementation(() => {
      throw new GhRestError({
        stderr: "HTTP 404",
        exitCode: 1,
        endpoint: "repos/deftai/directive/issues/999",
        payload: null,
      });
    });
    const result = restDispatch.runRestView(["999", "--repo", "deftai/directive"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("HTTP 404");
    vi.restoreAllMocks();
  });

  it("surfaces InvalidRepoError as exit 2", () => {
    const result = restDispatch.runRestView(["1", "--repo", "directive"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid --repo value");
  });

  it("requires --repo", () => {
    const result = restDispatch.runRestView(["1"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--repo OWNER/NAME");
  });

  it("rejects unknown flags", () => {
    const result = restDispatch.runRestView([
      "1",
      "--repo",
      "deftai/directive",
      "--state",
      "closed",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("does not recognise these flags");
  });
});

describe("runRestList", () => {
  it("invokes helper with parsed flags", () => {
    const listSpy = vi.spyOn(ghRest, "restIssueList").mockReturnValue([
      { number: 1, title: "first", state: "open" },
      { number: 2, title: "second", state: "open" },
    ]);
    const result = restDispatch.runRestList([
      "--repo",
      "deftai/directive",
      "--state",
      "closed",
      "--label",
      "epic,cache",
      "--limit",
      "50",
      "--json",
      "number,title",
    ]);
    expect(result.exitCode).toBe(0);
    expect(listSpy).toHaveBeenCalledWith(
      "deftai/directive",
      expect.objectContaining({
        state: "closed",
        labels: ["epic", "cache"],
        perPage: 50,
      }),
      expect.anything(),
    );
    vi.restoreAllMocks();
  });

  it("threads the injected runGhApi seam through to the REST helper", () => {
    const viewSpy = vi.spyOn(ghRest, "restIssueView").mockReturnValue({ number: 7 });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const runGhApiFn = vi.fn();
    main(["issue", "view", "--rest", "7", "--repo", "deftai/directive"], {
      whichFn: () => "/usr/bin/gh",
      runGhApiFn,
    });
    expect(viewSpy).toHaveBeenCalledWith(
      "deftai/directive",
      7,
      expect.objectContaining({ runGhApiFn }),
    );
    stdout.mockRestore();
    vi.restoreAllMocks();
  });

  it("rejects leftover positionals", () => {
    const result = restDispatch.runRestList(["123", "--repo", "deftai/directive"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("takes no positional arguments");
  });

  it("rejects non-integer --limit", () => {
    const result = restDispatch.runRestList(["--repo", "deftai/directive", "--limit", "many"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--limit must be an integer");
  });
});
