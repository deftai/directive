import { describe, expect, it } from "vitest";
import {
  CURRENT_SHAPE_HEADER_RE,
  detectSections,
  extractPassFromBody,
  fetchCurrentShape,
  type IssueComment,
  NO_CURRENT_SHAPE_MESSAGE,
  parseCommentsFromGhStdout,
  parseCurrentShapeArgv,
  runCurrentShape,
  sectionsRecord,
  selectCurrentShapeComment,
} from "./index.js";

const SAMPLE_BODY =
  "## Current shape (as of pass-2)\n\n" +
  "Last updated: 2026-06-28T12:00:00Z\n" +
  "Last pass type: additive\n" +
  "Child count: 3 (2/1)\n" +
  "Child-count history: pass-1: 2, pass-2: 3\n\n" +
  "### Open children\n\n" +
  "- child-a\n\n" +
  "### Closed children\n\n" +
  "- child-b\n\n" +
  "### Wave order\n\n" +
  "- Wave 1: child-a\n\n" +
  "### Open questions\n\n" +
  "- none\n\n" +
  "### Reading order for fresh contributors\n\n" +
  "1. Body\n2. This comment\n3. Amendments";

function comment(id: number, body: string, passOverride?: number): IssueComment {
  const effectiveBody =
    passOverride !== undefined ? body.replace(/pass-\d+/, `pass-${passOverride}`) : body;
  return {
    id,
    body: effectiveBody,
    htmlUrl: `https://github.com/deftai/directive/issues/1119#issuecomment-${id}`,
    updatedAt: "2026-06-28T12:00:00Z",
  };
}

describe("CURRENT_SHAPE_HEADER_RE", () => {
  it("matches canonical header", () => {
    expect(CURRENT_SHAPE_HEADER_RE.test("## Current shape (as of pass-3)\n")).toBe(true);
    expect(extractPassFromBody(SAMPLE_BODY)).toBe(2);
  });
});

describe("selectCurrentShapeComment", () => {
  it("returns null when no current-shape comment exists", () => {
    expect(
      selectCurrentShapeComment([
        comment(1, "Amendment note only"),
        comment(2, "## Other section\n\nnot the shape"),
      ]),
    ).toBeNull();
  });

  it("picks highest pass-N and tie-breaks by comment id", () => {
    const pass1 = comment(10, "## Current shape (as of pass-1)\n\nLast updated: x");
    const pass3 = comment(20, "## Current shape (as of pass-3)\n\nLast updated: y");
    const pass3Older = comment(15, "## Current shape (as of pass-3)\n\nLast updated: z");
    const selected = selectCurrentShapeComment([pass1, pass3Older, pass3]);
    expect(selected?.pass).toBe(3);
    expect(selected?.id).toBe(20);
  });
});

describe("detectSections", () => {
  it("reports all required sections present in sample body", () => {
    const presence = detectSections(SAMPLE_BODY);
    expect(presence.missing).toEqual([]);
    expect(presence.present).toContain("openChildren");
    expect(presence.optionalPresent).toContain("openQuestions");
  });

  it("reports missing required sections", () => {
    const minimal = "## Current shape (as of pass-1)\n\nLast updated: now\n";
    const presence = detectSections(minimal);
    expect(presence.missing.length).toBeGreaterThan(0);
    expect(presence.missing).toContain("waveOrder");
  });
});

describe("fetchCurrentShape", () => {
  it("returns result when comment found", () => {
    const outcome = fetchCurrentShape({
      repo: "deftai/directive",
      issueNumber: 1119,
      fetchComments: () => [comment(42, SAMPLE_BODY)],
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.commentId).toBe(42);
      expect(outcome.result.pass).toBe(2);
      expect(outcome.result.body).toContain("### Wave order");
    }
  });

  it("returns not-found when no shape comment", () => {
    const outcome = fetchCurrentShape({
      repo: "deftai/directive",
      issueNumber: 1119,
      fetchComments: () => [comment(1, "audit trail only")],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("not-found");
      expect(outcome.error).toBe(NO_CURRENT_SHAPE_MESSAGE);
    }
  });

  it("returns config error on scm failure", () => {
    const outcome = fetchCurrentShape({
      repo: "deftai/directive",
      issueNumber: 1119,
      fetchComments: () => ({ error: "network down" }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("config");
    }
  });
});

describe("runCurrentShape", () => {
  it("prints body in text mode", () => {
    const lines: string[] = [];
    const code = runCurrentShape({
      issueNumber: 1119,
      projectRoot: "/tmp",
      repo: "deftai/directive",
      fetchComments: () => [comment(1, SAMPLE_BODY)],
      writeOut: (t) => lines.push(t),
      writeErr: () => {},
    });
    expect(code).toBe(0);
    expect(lines.join("")).toContain("### Open children");
  });

  it("emits JSON with sections map", () => {
    const lines: string[] = [];
    const code = runCurrentShape({
      issueNumber: 1119,
      projectRoot: "/tmp",
      repo: "deftai/directive",
      jsonMode: true,
      fetchComments: () => [comment(1, SAMPLE_BODY)],
      writeOut: (t) => lines.push(t),
      writeErr: () => {},
    });
    expect(code).toBe(0);
    const payload = JSON.parse(lines.join("").trim()) as Record<string, unknown>;
    expect(payload.issueNumber).toBe(1119);
    expect(payload.pass).toBe(2);
    expect(payload.sections).toBeTruthy();
    expect((payload.sections as Record<string, boolean>).waveOrder).toBe(true);
  });

  it("exits 1 when no current-shape comment", () => {
    const errLines: string[] = [];
    const code = runCurrentShape({
      issueNumber: 1119,
      projectRoot: "/tmp",
      repo: "deftai/directive",
      fetchComments: () => [],
      writeOut: () => {},
      writeErr: (t) => errLines.push(t),
    });
    expect(code).toBe(1);
    expect(errLines.join("")).toContain("No ## Current shape");
  });

  it("exits 1 under --strict when sections missing without stdout", () => {
    const errLines: string[] = [];
    const outLines: string[] = [];
    const incomplete = "## Current shape (as of pass-1)\n\nLast updated: 2026-06-28T00:00:00Z\n";
    const code = runCurrentShape({
      issueNumber: 1119,
      projectRoot: "/tmp",
      repo: "deftai/directive",
      strict: true,
      fetchComments: () => [comment(1, incomplete)],
      writeOut: (t) => outLines.push(t),
      writeErr: (t) => errLines.push(t),
    });
    expect(code).toBe(1);
    expect(outLines).toEqual([]);
    expect(errLines.join("")).toContain("--strict");
  });

  it("exits 2 on invalid issue number", () => {
    expect(
      runCurrentShape({
        issueNumber: 0,
        projectRoot: "/tmp",
        repo: "deftai/directive",
        writeOut: () => {},
        writeErr: () => {},
      }),
    ).toBe(2);
  });

  it("exits 2 when repo cannot be resolved", () => {
    const errLines: string[] = [];
    const code = runCurrentShape({
      issueNumber: 1119,
      projectRoot: "/nonexistent-no-git",
      repo: null,
      fetchComments: () => [],
      writeOut: () => {},
      writeErr: (t) => errLines.push(t),
    });
    expect(code).toBe(2);
    expect(errLines.join("")).toContain("could not resolve owner/repo");
  });
});

describe("parseCurrentShapeArgv", () => {
  it("parses issue number and flags", () => {
    expect(
      parseCurrentShapeArgv(["2066", "--json", "--strict", "--repo", "deftai/directive"]),
    ).toEqual({
      issueNumber: 2066,
      repo: "deftai/directive",
      jsonMode: true,
      strict: true,
    });
  });

  it("reports unknown flags", () => {
    expect(parseCurrentShapeArgv(["--nope"]).passthroughError).toMatch(/unknown flag/);
  });

  it("parses --repo= form and argv errors", () => {
    expect(parseCurrentShapeArgv(["2066", "--repo=deftai/directive"]).repo).toBe(
      "deftai/directive",
    );
    expect(parseCurrentShapeArgv(["--repo"]).passthroughError).toMatch(/expected one argument/);
    expect(parseCurrentShapeArgv(["abc"]).passthroughError).toMatch(/invalid issue number/);
    expect(parseCurrentShapeArgv(["1", "2"]).passthroughError).toMatch(/unexpected positional/);
  });
});

describe("sectionsRecord", () => {
  it("maps presence to booleans", () => {
    const presence = detectSections(SAMPLE_BODY);
    const record = sectionsRecord(presence);
    expect(record.waveOrder).toBe(true);
    expect(record.openQuestions).toBe(true);
  });
});

describe("extractPassFromBody edge cases", () => {
  it("returns null for non-finite pass numbers", () => {
    expect(extractPassFromBody("## Current shape (as of pass-NaN)\n")).toBeNull();
  });
});

describe("parseCommentsFromGhStdout", () => {
  it("merges paginated gh api pages", () => {
    const page1 = [{ id: 1, body: "noise" }];
    const page2 = [{ id: 2, body: SAMPLE_BODY, html_url: "https://example.com/2" }];
    const parsed = parseCommentsFromGhStdout(`${JSON.stringify(page1)}${JSON.stringify(page2)}`);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.id).toBe(2);
  });

  it("parses a single JSON array page", () => {
    expect(parseCommentsFromGhStdout(JSON.stringify([{ id: 3, body: SAMPLE_BODY }]))).toHaveLength(
      1,
    );
  });

  it("skips malformed entries and blank stdout", () => {
    expect(parseCommentsFromGhStdout("")).toEqual([]);
    expect(
      parseCommentsFromGhStdout(JSON.stringify([{ id: "bad", body: 1 }, null, { foo: 1 }])),
    ).toEqual([]);
  });

  it("throws on unrecoverable paginated JSON", () => {
    expect(() => parseCommentsFromGhStdout("[{broken")).toThrow();
  });
});
