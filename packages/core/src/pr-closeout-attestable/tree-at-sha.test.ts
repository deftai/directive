import { describe, expect, it } from "vitest";
import type { GitRunner, GitRunResult } from "../session/git.js";
import { parseLsTreeZ, readActiveRunningBriefsAtSha } from "./tree-at-sha.js";

const SHA = "a".repeat(40);

function ok(stdout = ""): GitRunResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(code = 128, stderr = "fatal"): GitRunResult {
  return { code, stdout: "", stderr };
}

function brief(status: string): string {
  return JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "t", status } });
}

/** Scripted git: map "args joined by space" prefix → result. */
function scripted(table: Record<string, GitRunResult>): GitRunner {
  return (_root, args) => {
    const key = args.join(" ");
    for (const [prefix, result] of Object.entries(table)) {
      if (key.startsWith(prefix)) return result;
    }
    throw new Error(`unexpected git ${key}`);
  };
}

describe("parseLsTreeZ", () => {
  it("parses NUL-separated ls-tree records and skips malformed ones", () => {
    const out = parseLsTreeZ(
      [
        "100644 blob b1\txbrief/active/a.xbrief.json",
        "040000 tree t1\txbrief",
        "garbage",
        "bad\tx",
        "",
      ].join("\0"),
    );
    expect(out).toEqual([
      { type: "blob", oid: "b1", path: "xbrief/active/a.xbrief.json" },
      { type: "tree", oid: "t1", path: "xbrief" },
    ]);
  });
});

describe("readActiveRunningBriefsAtSha", () => {
  it("rejects a value that is not a SHA", () => {
    const r = readActiveRunningBriefsAtSha("/r", "not-a-sha", scripted({}));
    expect(r.status).toBe("error");
  });

  it("reports a missing commit object", () => {
    const r = readActiveRunningBriefsAtSha("/r", SHA, scripted({ "cat-file -e": fail(1) }));
    expect(r.status).toBe("missing-object");
  });

  it("reports no layout when xbrief/ is absent at the SHA", () => {
    const r = readActiveRunningBriefsAtSha(
      "/r",
      SHA,
      scripted({ "cat-file -e": ok(), "ls-tree -z": ok("") }),
    );
    expect(r).toEqual({ status: "ok", hasLayout: false, briefs: [] });
  });

  it("returns running briefs only, sorted, skipping non-artifacts and trees", () => {
    const git: GitRunner = (_root, args) => {
      const key = args.join(" ");
      if (key.startsWith("cat-file -e")) return ok();
      if (key === `ls-tree -z ${SHA} -- xbrief`) return ok("040000 tree t0\txbrief\0");
      if (key === `ls-tree -z ${SHA} -- xbrief/active/`) {
        return ok(
          [
            "100644 blob b2\txbrief/active/z.xbrief.json",
            "100644 blob b1\txbrief/active/a.xbrief.json",
            "100644 blob b3\txbrief/active/done.xbrief.json",
            "100644 blob b4\txbrief/active/notes.md",
            "040000 tree t1\txbrief/active/sub",
          ].join("\0") + "\0",
        );
      }
      if (key === "cat-file blob b1") return ok(brief("running"));
      if (key === "cat-file blob b2") return ok(brief("Running"));
      if (key === "cat-file blob b3") return ok(brief("completed"));
      throw new Error(`unexpected git ${key}`);
    };
    const r = readActiveRunningBriefsAtSha("/r", SHA, git);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.hasLayout).toBe(true);
    expect(r.briefs.map((b) => b.relPath)).toEqual([
      "xbrief/active/a.xbrief.json",
      "xbrief/active/z.xbrief.json",
    ]);
  });

  it("fails on ls-tree and blob read errors", () => {
    expect(
      readActiveRunningBriefsAtSha("/r", SHA, scripted({ "cat-file -e": ok(), "ls-tree": fail() }))
        .status,
    ).toBe("error");
    const listFails: GitRunner = (_root, args) => {
      const key = args.join(" ");
      if (key.startsWith("cat-file -e")) return ok();
      if (key.endsWith("-- xbrief")) return ok("040000 tree t0\txbrief\0");
      return fail();
    };
    expect(readActiveRunningBriefsAtSha("/r", SHA, listFails).status).toBe("error");
    const blobFails: GitRunner = (_root, args) => {
      const key = args.join(" ");
      if (key.startsWith("cat-file -e")) return ok();
      if (key.endsWith("-- xbrief")) return ok("040000 tree t0\txbrief\0");
      if (key.endsWith("xbrief/active/"))
        return ok("100644 blob b1\txbrief/active/a.xbrief.json\0");
      return fail();
    };
    expect(readActiveRunningBriefsAtSha("/r", SHA, blobFails).status).toBe("error");
  });
});
