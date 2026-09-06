import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesignCritiqueIngestBlockedError } from "../design-critique/completed-arc-record.js";
import type { CompletedProcess } from "../scm/call.js";
import { classifyScmArgv } from "../scm/call-shape.js";
import {
  fetchIssue,
  fetchIssueComments,
  ISSUE_COMMENT_PAGE_CAP,
  ISSUE_COMMENT_PAGE_SIZE,
  ISSUE_COMMENT_THREAD_KEY,
  type IssueComment,
  IssueCommentFetchError,
  ingestOne,
  issueCommentsPagePath,
} from "./issue-ingest.js";

function completed(stdout = "", stderr = "", returncode = 0): CompletedProcess {
  return { stdout, stderr, returncode };
}

function filler(id: number): IssueComment {
  return {
    id,
    body: `comment ${id}`,
    created_at: `2026-09-06T00:00:${String(id % 60).padStart(2, "0")}Z`,
    user: { login: "user" },
  };
}

const LEAN_ID = 5516000099;
const TABLE_ID = 5516000100;
const SYNTHESIS_ID = 5516000101;
const RECUT_LEAN_ID = 5516000102;
const SHAPE_P1_ID = 5516000001;
const SHAPE_P4_ID = 5516000103;

function leanComment(id: number, extra = "chips are convenience."): IssueComment {
  return {
    id,
    body: `**Lean:**\n${extra}\n`,
    created_at: "2026-09-06T12:00:00Z",
    user: { login: "parent" },
  };
}

function tableComment(id: number): IssueComment {
  return {
    id,
    body: "## Verified-claims table\n",
    created_at: "2026-09-06T12:01:00Z",
    user: { login: "parent" },
  };
}

function synthesisComment(id: number, leanId: number, tableId: number): IssueComment {
  return {
    id,
    body:
      "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
      `Bound contract: successor lean ${leanId}, verified-claims table ${tableId}.\n`,
    created_at: "2026-09-06T12:02:00Z",
    user: { login: "parent" },
  };
}

function currentShapeComment(
  id: number,
  pass: number,
  association: string,
  login: string,
): IssueComment {
  return {
    id,
    body: `## Current shape (as of pass-${pass})\n\nWave from comment ${id}.`,
    html_url: `https://github.com/o/r/issues/4137#issuecomment-${id}`,
    author_association: association,
    user: { login },
    created_at: "2026-09-06T12:03:00Z",
  };
}

function commentsOfLength(
  count: number,
  overlay: ReadonlyMap<number, IssueComment>,
): IssueComment[] {
  const out: IssueComment[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push(overlay.get(i) ?? filler(i));
  }
  return out;
}

function pagedScmCall(
  issue: Record<string, unknown>,
  comments: readonly IssueComment[],
  overrides: {
    readonly failPage?: number;
    readonly nonArrayPage?: number;
    readonly throwPage?: number;
    readonly unmappableFirstPage?: boolean;
  } = {},
) {
  return vi.fn((_source: string, verb: string, args: readonly string[]) => {
    expect(verb).toBe("api");
    expect(args).toHaveLength(1);
    expect(args.some((token) => token.startsWith("-"))).toBe(false);
    const path = args[0] ?? "";
    expect(classifyScmArgv(verb, args)).toBe("cached-get");
    const pageMatch = /\/comments\?per_page=100&page=(\d+)$/.exec(path);
    if (pageMatch) {
      const page = Number(pageMatch[1]);
      if (overrides.throwPage === page) {
        throw new Error("spawn boom");
      }
      if (overrides.failPage === page) {
        return completed("", "secondary rate limit", 1);
      }
      if (overrides.nonArrayPage === page) {
        return completed("{}", "", 0);
      }
      if (overrides.unmappableFirstPage === true) {
        if (page === 1) {
          return completed(
            JSON.stringify(
              Array.from({ length: ISSUE_COMMENT_PAGE_SIZE }, () => ({ body: "no-id" })),
            ),
            "",
            0,
          );
        }
        const start = (page - 2) * ISSUE_COMMENT_PAGE_SIZE;
        return completed(
          JSON.stringify(comments.slice(start, start + ISSUE_COMMENT_PAGE_SIZE)),
          "",
          0,
        );
      }
      const start = (page - 1) * ISSUE_COMMENT_PAGE_SIZE;
      return completed(
        JSON.stringify(comments.slice(start, start + ISSUE_COMMENT_PAGE_SIZE)),
        "",
        0,
      );
    }
    if (path.includes("/comments")) {
      throw new Error(`unexpected comments path: ${path}`);
    }
    return completed(JSON.stringify(issue), "", 0);
  });
}

function readNarratives(path: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`expected object at ${path}`);
  }
  const plan = (parsed as Record<string, unknown>).plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("expected plan object");
  }
  const narratives = (plan as Record<string, unknown>).narratives;
  if (narratives === null || typeof narratives !== "object" || Array.isArray(narratives)) {
    throw new Error("expected narratives object");
  }
  return narratives as Record<string, string>;
}

describe("fetchIssueComments pagination (#4137)", () => {
  it("walks per_page=100&page=N, preserves raw fields, and stays cached-get", () => {
    const comments = commentsOfLength(101, new Map());
    const scmCall = pagedScmCall({ number: 4137 }, comments);
    const fetched = fetchIssueComments("o/r", 4137, { scmCall });
    expect(fetched).toHaveLength(101);
    expect(fetched[0]?.id).toBe(1);
    expect(fetched[0]?.created_at).toBe(comments[0]?.created_at);
    expect(fetched[99]?.id).toBe(100);
    expect(fetched[100]?.id).toBe(101);
    expect(fetched[100]?.body).toBe("comment 101");
    expect(scmCall.mock.calls.map((call) => call[2][0])).toEqual([
      issueCommentsPagePath("o/r", 4137, 1),
      issueCommentsPagePath("o/r", 4137, 2),
    ]);
  });

  it("returns a successful empty thread from a short first page", () => {
    const scmCall = pagedScmCall({ number: 7 }, []);
    expect(fetchIssueComments("o/r", 7, { scmCall })).toEqual([]);
    expect(scmCall).toHaveBeenCalledTimes(1);
  });

  it("fails closed on spawn throw instead of returning []", () => {
    const scmCall = pagedScmCall({ number: 1 }, commentsOfLength(1, new Map()), { throwPage: 1 });
    expect(() => fetchIssueComments("o/r", 1, { scmCall })).toThrow(IssueCommentFetchError);
  });

  it("fails closed on non-zero instead of returning []", () => {
    const scmCall = pagedScmCall({ number: 1 }, commentsOfLength(1, new Map()), { failPage: 1 });
    expect(() => fetchIssueComments("o/r", 1, { scmCall })).toThrow(/page 1 failed/);
  });

  it("fails closed on non-JSON instead of returning []", () => {
    const scmCall = vi.fn(() => completed("not-json", "", 0));
    expect(() => fetchIssueComments("o/r", 1, { scmCall })).toThrow(/non-JSON/);
  });

  it("fails closed on a non-array page", () => {
    const scmCall = pagedScmCall({ number: 1 }, commentsOfLength(101, new Map()), {
      nonArrayPage: 2,
    });
    expect(() => fetchIssueComments("o/r", 1, { scmCall })).toThrow(/non-array/);
  });

  it("does not treat a failed later page as a successful partial history", () => {
    const scmCall = pagedScmCall({ number: 1 }, commentsOfLength(101, new Map()), { failPage: 2 });
    expect(() => fetchIssueComments("o/r", 1, { scmCall })).toThrow(IssueCommentFetchError);
    expect(scmCall.mock.calls.length).toBe(2);
  });

  it("stops on raw page length, not a filtered mapped length", () => {
    const page2 = [filler(101)];
    const scmCall = pagedScmCall({ number: 1 }, page2, { unmappableFirstPage: true });
    const fetched = fetchIssueComments("o/r", 1, { scmCall });
    expect(fetched).toHaveLength(ISSUE_COMMENT_PAGE_SIZE + 1);
    expect(fetched[ISSUE_COMMENT_PAGE_SIZE]?.id).toBe(101);
    expect(scmCall).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the page cap is exhausted without a short terminal page", () => {
    const scmCall = vi.fn((_source: string, _verb: string, args: readonly string[]) => {
      const path = args[0] ?? "";
      expect(path).toMatch(/\/comments\?per_page=100&page=\d+$/);
      return completed(
        JSON.stringify(Array.from({ length: ISSUE_COMMENT_PAGE_SIZE }, (_, i) => filler(i + 1))),
        "",
        0,
      );
    });
    expect(() => fetchIssueComments("o/r", 1, { scmCall })).toThrow(/page cap/);
    expect(scmCall).toHaveBeenCalledTimes(ISSUE_COMMENT_PAGE_CAP);
  });
});

describe("fetchIssue / ingestOne comment pagination (#4137)", () => {
  const issueBase = {
    number: 4137,
    title: "paginate ingest comments",
    body: "issue body",
    html_url: "https://github.com/o/r/issues/4137",
    labels: [{ name: "bug" }],
  };

  it("writes when the completed-arc record is on page 2 and selects that CurrentShape", () => {
    const overlay = new Map<number, IssueComment>([
      [1, currentShapeComment(SHAPE_P1_ID, 1, "CONTRIBUTOR", "outsider")],
      [99, leanComment(LEAN_ID)],
      [100, tableComment(TABLE_ID)],
      [101, synthesisComment(SYNTHESIS_ID, LEAN_ID, TABLE_ID)],
      [102, currentShapeComment(SHAPE_P4_ID, 4, "MEMBER", "maintainer")],
    ]);
    const comments = commentsOfLength(102, overlay);
    const scmCall = pagedScmCall(issueBase, comments);
    const issue = fetchIssue("o/r", 4137, { scmCall });
    expect(issue?.[ISSUE_COMMENT_THREAD_KEY]).toHaveLength(102);

    const root = mkdtempSync(join(tmpdir(), "ingest-4137-p2-"));
    const xbriefDir = join(root, "xbrief");
    mkdirSync(xbriefDir, { recursive: true });
    try {
      const [result, path] = ingestOne(issue as Record<string, unknown>, {
        vbriefDir: xbriefDir,
        status: "proposed",
        repoUrl: "https://github.com/o/r",
        cwd: root,
        scmCall,
      });
      expect(result).toBe("created");
      expect(path).toBeTruthy();
      const narratives = readNarratives(path as string);
      expect(narratives.CurrentShape).toContain("pass-4");
      expect(narratives.CurrentShape).toContain(`Wave from comment ${SHAPE_P4_ID}`);
      expect(narratives.CurrentShapeUnavailable).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays blocked when a stale complete record is on page 1 and a later recut lean is on page 2", () => {
    const overlay = new Map<number, IssueComment>([
      [1, leanComment(LEAN_ID)],
      [2, tableComment(TABLE_ID)],
      [3, synthesisComment(SYNTHESIS_ID, LEAN_ID, TABLE_ID)],
      [101, leanComment(RECUT_LEAN_ID, "recut lean")],
    ]);
    const comments = commentsOfLength(101, overlay);
    const scmCall = pagedScmCall(issueBase, comments);
    const issue = fetchIssue("o/r", 4137, { scmCall });
    expect(issue?.[ISSUE_COMMENT_THREAD_KEY]).toHaveLength(101);

    const root = mkdtempSync(join(tmpdir(), "ingest-4137-stale-"));
    const xbriefDir = join(root, "xbrief");
    mkdirSync(xbriefDir, { recursive: true });
    try {
      expect(() =>
        ingestOne(issue as Record<string, unknown>, {
          vbriefDir: xbriefDir,
          status: "proposed",
          repoUrl: "https://github.com/o/r",
          cwd: root,
          scmCall,
        }),
      ).toThrow(DesignCritiqueIngestBlockedError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write when a later comments page fails", () => {
    const scmCall = pagedScmCall(issueBase, commentsOfLength(101, new Map()), { failPage: 2 });
    const root = mkdtempSync(join(tmpdir(), "ingest-4137-fail-"));
    const xbriefDir = join(root, "xbrief");
    mkdirSync(xbriefDir, { recursive: true });
    try {
      expect(() => fetchIssue("o/r", 4137, { scmCall })).toThrow(IssueCommentFetchError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
