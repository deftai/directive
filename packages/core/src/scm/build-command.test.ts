import { describe, expect, it } from "vitest";
import { buildCommand } from "./build-command.js";
import { ScmStubError } from "./errors.js";

describe("buildCommand", () => {
  it.each([
    "list",
    "view",
    "close",
    "edit",
  ] as const)("builds canonical argv for issue %s", (verb) => {
    expect(buildCommand("issue", verb, ["--repo", "deftai/directive"], { binary: "gh" })).toEqual([
      "gh",
      "issue",
      verb,
      "--repo",
      "deftai/directive",
    ]);
  });

  it("forwards --json verbatim", () => {
    expect(
      buildCommand(
        "issue",
        "view",
        ["883", "--repo", "deftai/directive", "--json", "number,title,body"],
        { binary: "gh" },
      ),
    ).toEqual([
      "gh",
      "issue",
      "view",
      "883",
      "--repo",
      "deftai/directive",
      "--json",
      "number,title,body",
    ]);
  });

  it("rejects unknown namespace", () => {
    expect(() => buildCommand("isue", "list", [], { binary: "gh" })).toThrow(ScmStubError);
    expect(() => buildCommand("isue", "list", [], { binary: "gh" })).toThrow(
      /unknown scm namespace/,
    );
  });

  it("rejects unknown issue verb", () => {
    expect(() => buildCommand("issue", "merge", [], { binary: "gh" })).toThrow(ScmStubError);
    expect(() => buildCommand("issue", "merge", [], { binary: "gh" })).toThrow(
      /unknown scm:issue verb/,
    );
  });
});
