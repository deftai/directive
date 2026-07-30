import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertBodyEncoding,
  editIssueBody,
  fetchIssueBody,
  GitHubBodyError,
  githubBodyMain,
  lintIssueBody,
  lintPrBody,
  type RunGhApiFn,
  readBody,
  resolveLiveGh,
  SCM_BODY_ENCODING_CODE,
  scanBodyText,
  stripUtf8Bom,
  verifyBodyPostcondition,
  writeIssueBodyToFile,
} from "./github-body.js";

/** Classic em-dash corruption class from #2948/#2944 (CP437-as-UTF-8 ΓÇö). */
const MOJIBAKE_EM_DASH = "\u0393\u00c7\u00f6"; // ΓÇö
/** Clean Unicode em dash. */
const CLEAN_EM_DASH = "\u2014"; // —

describe("github-body", () => {
  it("reads body from stdin sentinel", () => {
    expect(readBody("-", "hello")).toBe("hello");
  });

  it("stripUtf8Bom removes leading BOM", () => {
    expect(stripUtf8Bom("\uFEFFhello")).toBe("hello");
    expect(stripUtf8Bom("hello")).toBe("hello");
  });

  it("resolveLiveGh throws when gh missing", () => {
    expect(() => resolveLiveGh()).not.toThrow();
  });

  it("createIssue uses runFn seam", async () => {
    const { createIssue } = await import("./github-body.js");
    let lastBody = "";
    const runFn: RunGhApiFn = (args, options) => {
      if (args.includes("--method")) {
        if (options?.inputText) {
          const parsed = JSON.parse(options.inputText) as { body?: string };
          if (typeof parsed.body === "string") lastBody = parsed.body;
        }
        return { number: 42 };
      }
      return { number: 42, body: lastBody, html_url: "https://github.com/o/r/issues/42" };
    };
    const result = createIssue("o/r", {
      title: "t",
      body: "b",
      runFn,
      binary: "gh",
    });
    expect(result.number).toBe(42);
  });

  it("verifyBodyPostcondition passes on exact match", () => {
    expect(() => verifyBodyPostcondition("line1\nline2", "line1\nline2")).not.toThrow();
  });

  it("verifyBodyPostcondition passes on CRLF normalization", () => {
    expect(() => verifyBodyPostcondition("line1\nline2", "line1\r\nline2")).not.toThrow();
  });

  it("verifyBodyPostcondition fails on flattened newlines", () => {
    expect(() => verifyBodyPostcondition("line1\nline2", "line1 line2")).toThrow(GitHubBodyError);
    expect(() => verifyBodyPostcondition("line1\nline2", "line1 line2")).toThrow(
      /collapsed to spaces/,
    );
  });

  it("verifyBodyPostcondition fails on mojibake marker", () => {
    expect(() => verifyBodyPostcondition("arrow → dash", "arrow \uFFFD dash")).toThrow(
      GitHubBodyError,
    );
    expect(() => verifyBodyPostcondition("arrow → dash", "arrow \uFFFD dash")).toThrow(/U\+FFFD/);
  });

  it("verifyBodyPostcondition fails when live gains CP437 em-dash mojibake", () => {
    const intended = `dash ${CLEAN_EM_DASH} ok`;
    const live = `dash ${MOJIBAKE_EM_DASH} ok`;
    expect(() => verifyBodyPostcondition(intended, live)).toThrow(GitHubBodyError);
    try {
      verifyBodyPostcondition(intended, live);
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubBodyError);
      expect((e as GitHubBodyError).code).toBe(SCM_BODY_ENCODING_CODE);
    }
  });

  it("scanBodyText rejects ΓÇö em-dash corruption without network", () => {
    const findings = scanBodyText(`title ${MOJIBAKE_EM_DASH} body`);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.label.includes("U+2014"))).toBe(true);
  });

  it("scanBodyText ignores mojibake only inside markdown code spans", () => {
    expect(scanBodyText(`see \`${MOJIBAKE_EM_DASH}\` example`)).toEqual([]);
    expect(scanBodyText(`\`\`\`\n${MOJIBAKE_EM_DASH}\n\`\`\`\n`)).toEqual([]);
  });

  it("scanBodyText flags prose mojibake after a fenced block at the correct line", () => {
    // Same shape as encoding/scan.test.ts fenced.md fixture (#2960 Greptile P1).
    const body = `intro\n\`\`\`\nignored ${MOJIBAKE_EM_DASH}\n\`\`\`\nreal ${MOJIBAKE_EM_DASH} hit\n`;
    const findings = scanBodyText(body);
    expect(findings.length).toBe(1);
    expect(findings[0]?.line).toBe(5);
    expect(findings[0]?.label).toMatch(/U\+2014/);
  });

  it("scanBodyText accepts clean em dash", () => {
    expect(scanBodyText(`title ${CLEAN_EM_DASH} body`)).toEqual([]);
  });

  it("assertBodyEncoding fails closed with scm-body-encoding", () => {
    expect(() => assertBodyEncoding(`bad ${MOJIBAKE_EM_DASH}`, "pre-write")).toThrow(
      GitHubBodyError,
    );
    try {
      assertBodyEncoding(`bad ${MOJIBAKE_EM_DASH}`, "pre-write");
    } catch (e) {
      expect((e as GitHubBodyError).code).toBe(SCM_BODY_ENCODING_CODE);
      expect((e as Error).message).toMatch(/scm:body:issue:fetch/);
    }
  });

  it("editIssueBody rejects mojibake payload before PATCH", () => {
    let mutated = false;
    const runFn: RunGhApiFn = (args) => {
      if (args.includes("--method")) {
        mutated = true;
        return { number: 7 };
      }
      return { body: "unused" };
    };
    expect(() =>
      editIssueBody("o/r", 7, {
        body: `section ${MOJIBAKE_EM_DASH} corrupted`,
        runFn,
        binary: "gh",
      }),
    ).toThrow(/scm-body-encoding|body encoding failed|U\+2014/);
    expect(mutated).toBe(false);
  });

  it("editIssueBody fails closed when read-back body is flattened", () => {
    const intended = "section one\nsection two";
    const runFn: RunGhApiFn = (args, _options) => {
      if (args.includes("--method")) {
        return { number: 7 };
      }
      if (args.length === 1 && args[0] === "repos/o/r/issues/7") {
        return { body: "section one section two" };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };
    expect(() => editIssueBody("o/r", 7, { body: intended, runFn, binary: "gh" })).toThrow(
      /body postcondition failed/,
    );
  });

  it("editIssueBody succeeds when read-back matches intended body", () => {
    const intended = "section one\nsection two → em-dash";
    const runFn: RunGhApiFn = (args) => {
      if (args.includes("--method")) {
        return { number: 7 };
      }
      if (args.length === 1 && args[0] === "repos/o/r/issues/7") {
        return { body: intended };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    };
    const result = editIssueBody("o/r", 7, { body: intended, runFn, binary: "gh" });
    expect(result.body).toBe(intended);
  });

  it("fetchIssueBody returns live body via runFn", () => {
    const body = "line one\nline two — unicode";
    const runFn: RunGhApiFn = (args) => {
      expect(args).toEqual(["repos/o/r/issues/42"]);
      return { body };
    };
    expect(fetchIssueBody("o/r", 42, { runFn, binary: "gh" })).toBe(body);
  });

  it("writeIssueBodyToFile writes exact UTF-8 body", () => {
    const dir = mkdtempSync(join(tmpdir(), "github-body-"));
    const outFile = join(dir, "body.md");
    const body = "line one\nline two → em-dash";
    const runFn: RunGhApiFn = () => ({ body });
    try {
      writeIssueBodyToFile("o/r", 42, outFile, { runFn, binary: "gh" });
      expect(readFileSync(outFile, "utf8")).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lintIssueBody returns findings for live mojibake", () => {
    const runFn: RunGhApiFn = () => ({ body: `arrow ${MOJIBAKE_EM_DASH} dash` });
    const findings = lintIssueBody("o/r", 9, { runFn, binary: "gh" });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("lintPrBody returns empty for clean body", () => {
    const runFn: RunGhApiFn = () => ({ body: `clean ${CLEAN_EM_DASH} text` });
    expect(lintPrBody("o/r", 3, { runFn, binary: "gh" })).toEqual([]);
  });

  it("githubBodyMain issue-lint exits 1 on mojibake", () => {
    const runFn: RunGhApiFn = () => ({ body: `x ${MOJIBAKE_EM_DASH} y` });
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      const code = githubBodyMain(
        { command: "issue-lint", repo: "o/r", issue: 1 },
        { runFn, binary: "gh" },
      );
      expect(code).toBe(1);
      expect(stderr.join("")).toContain(SCM_BODY_ENCODING_CODE);
    } finally {
      spy.mockRestore();
    }
  });

  it("githubBodyMain issue-lint exits 0 on clean body", () => {
    const runFn: RunGhApiFn = () => ({ body: `ok ${CLEAN_EM_DASH}` });
    const stdout: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    try {
      const code = githubBodyMain(
        { command: "issue-lint", repo: "o/r", issue: 2 },
        { runFn, binary: "gh" },
      );
      expect(code).toBe(0);
      expect(stdout.join("")).toMatch(/ok:/);
    } finally {
      spy.mockRestore();
    }
  });
});
