import { afterEach, describe, expect, it, vi } from "vitest";
import * as scm from "../scm/call.js";
import * as ghRest from "../scm/gh-rest.js";
import { ScmUmbrellaClient, UmbrellaScmError } from "./umbrellas.js";

describe("ScmUmbrellaClient comment create (#2324)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses gh api --method POST with a JSON body payload (not -X POST)", () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    vi.spyOn(scm, "call").mockImplementation((_source, _verb, args, options) => {
      calls.push({ args: args ?? [], input: options?.input });
      const argv = args ?? [];
      if (argv.includes("--method") && argv.includes("POST")) {
        return {
          args: [],
          returncode: 0,
          stdout: JSON.stringify({ id: 9001 }),
          stderr: "",
        };
      }
      return {
        args: [],
        returncode: 0,
        stdout: JSON.stringify({ id: 9001, body: "probe" }),
        stderr: "",
      };
    });

    const id = new ScmUmbrellaClient().createComment("deftai/cartograph", 18, "probe");
    expect(id).toBe(9001);

    const postCall = calls.find((c) => c.args.includes("POST"));
    expect(postCall).toBeDefined();
    expect(postCall?.args).toContain("--method");
    expect(postCall?.args).not.toContain("-X");
    expect(postCall?.args.join(" ")).toContain("repos/deftai/cartograph/issues/18/comments");
    expect(postCall?.input).toBe(JSON.stringify({ body: "probe" }));
  });

  it("wraps GitHubBodyError as UmbrellaScmError", () => {
    vi.spyOn(scm, "call").mockReturnValue({
      args: [],
      returncode: 1,
      stdout: "",
      stderr: "gh: Invalid request. For 'links/0/schema', nil is not an object. (HTTP 422)",
    });
    expect(() => new ScmUmbrellaClient().createComment("deftai/cartograph", 18, "body")).toThrow(
      UmbrellaScmError,
    );
  });

  it("throws when POST succeeds but readback GET fails", () => {
    vi.spyOn(scm, "call")
      .mockReturnValueOnce({
        args: [],
        returncode: 0,
        stdout: JSON.stringify({ id: 9001 }),
        stderr: "",
      })
      .mockReturnValueOnce({
        args: [],
        returncode: 1,
        stdout: "",
        stderr: "create readback fail",
      });
    expect(() => new ScmUmbrellaClient().createComment("deftai/cartograph", 18, "body")).toThrow(
      UmbrellaScmError,
    );
  });
});

describe("ScmUmbrellaClient fetchComments pagination (#3428)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("walks later pages so a newest close comment is not dropped", () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `old-${i}` }));
    const page2 = [{ id: 101, body: "expected_close_signal=all-children-merged; children: #1" }];
    vi.spyOn(scm, "call").mockImplementation((_source, _verb, args) => {
      const path = (args ?? []).join(" ");
      const page = /[?&]page=(\d+)/.exec(path)?.[1] ?? "1";
      return {
        args: [],
        returncode: 0,
        stdout: JSON.stringify(page === "2" ? page2 : page === "1" ? page1 : []),
        stderr: "",
      };
    });
    const comments = new ScmUmbrellaClient().fetchComments("deftai/directive", 3377);
    expect(comments).toHaveLength(101);
    expect(comments[100]?.body).toContain("expected_close_signal=");
  });
});

describe("ScmUmbrellaClient closeIssue (#3428)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes via restCloseIssue PATCH completed", () => {
    const spy = vi.spyOn(ghRest, "restCloseIssue").mockReturnValue({ state: "closed" });
    new ScmUmbrellaClient().closeIssue("deftai/directive", 3377);
    expect(spy).toHaveBeenCalledWith("deftai/directive", 3377, "completed");
  });

  it("wraps close failures as UmbrellaScmError", () => {
    vi.spyOn(ghRest, "restCloseIssue").mockImplementation(() => {
      throw new Error("HTTP 503");
    });
    expect(() => new ScmUmbrellaClient().closeIssue("deftai/directive", 3377)).toThrow(
      UmbrellaScmError,
    );
  });
});
