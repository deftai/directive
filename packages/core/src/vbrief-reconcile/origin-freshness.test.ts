import { describe, expect, it } from "vitest";
import type { IssueComment } from "../intake/issue-ingest.js";
import type { SpecPathLiveIdentities } from "../intake/spec-path-source.js";
import { digestAdmittedSourceSentences } from "../product-first-done-gate/acceptance.js";
import type { CompletedProcess } from "../scm/call.js";
import {
  briefUpdatedOf,
  compareOriginFreshness,
  type EvaluateOriginFreshnessOptions,
  evaluateOriginFreshness,
  extractGithubIssueOrigin,
  fetchGithubIssueUpdatedAt,
  formatOriginStaleMessage,
  type GithubIssueOrigin,
  ORIGIN_FRESHNESS_REMEDIATION,
  type OriginIssueSnapshot,
  resolveOriginBaseline,
} from "./origin-freshness.js";

function completed(stdout = "", stderr = "", returncode = 0): CompletedProcess {
  return { args: [], returncode, stdout, stderr };
}

const ORIGIN_BRIEF = {
  xBRIEFInfo: { version: "0.8", updated: "2026-08-14T16:00:00Z" },
  plan: {
    status: "running",
    references: [
      {
        type: "x-xbrief/github-issue",
        uri: "https://github.com/deftai/directive/issues/3363",
      },
    ],
  },
};

describe("extractGithubIssueOrigin", () => {
  it("extracts canonical x-xbrief/github-issue refs", () => {
    expect(extractGithubIssueOrigin(ORIGIN_BRIEF)).toEqual({
      owner: "deftai",
      repo: "directive",
      number: 3363,
      uri: "https://github.com/deftai/directive/issues/3363",
      type: "x-xbrief/github-issue",
    });
  });

  it("accepts legacy github-issue and x-vbrief/github-issue aliases", () => {
    expect(
      extractGithubIssueOrigin({
        plan: {
          references: [{ type: "github-issue", uri: "https://github.com/o/r/issues/9" }],
        },
      })?.number,
    ).toBe(9);
    expect(
      extractGithubIssueOrigin({
        plan: {
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/8" }],
        },
      })?.type,
    ).toBe("x-vbrief/github-issue");
  });

  it("fails closed when a nested item github-issue origin is newer", () => {
    const result = evaluateOriginFreshness(
      {
        xBRIEFInfo: { version: "0.8", updated: "2026-08-14T16:00:00Z" },
        plan: {
          status: "running",
          items: [
            {
              references: [
                {
                  type: "x-xbrief/github-issue",
                  uri: "https://github.com/deftai/directive/issues/99",
                },
              ],
            },
          ],
        },
      },
      { fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z" }) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("#99");
  });

  it("fails closed when a later github-issue origin is newer", () => {
    const brief = {
      xBRIEFInfo: { version: "0.8", updated: "2026-08-14T16:00:00Z" },
      plan: {
        status: "running",
        references: [
          {
            type: "x-xbrief/github-issue",
            uri: "https://github.com/deftai/directive/issues/1",
          },
          {
            type: "x-xbrief/github-issue",
            uri: "https://github.com/deftai/directive/issues/2",
          },
        ],
      },
    };
    const result = evaluateOriginFreshness(brief, {
      fetchOriginUpdatedAt: (origin) =>
        origin.number === 2
          ? { updatedAt: "2026-08-14T17:00:00Z" }
          : { updatedAt: "2026-08-14T15:00:00Z" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("#2");
    expect(result.message).toContain("newer than this xBRIEF");
  });

  it("returns null when there is no github-issue origin", () => {
    expect(extractGithubIssueOrigin({ plan: { references: [] } })).toBeNull();
    expect(extractGithubIssueOrigin({ plan: {} })).toBeNull();
    expect(
      extractGithubIssueOrigin({
        xBRIEFInfo: { description: "Scope xBRIEF ingested from GitHub issue #3363" },
        plan: { narratives: { Origin: "Ingested from issue #3363" } },
      }),
    ).toBeNull();
  });

  it("extracts a provenance-only Origin URL when references are absent", () => {
    expect(
      extractGithubIssueOrigin({
        plan: {
          narratives: {
            Origin: "Ingested from https://github.com/deftai/directive/issues/3363",
          },
        },
      }),
    ).toEqual({
      owner: "deftai",
      repo: "directive",
      number: 3363,
      uri: "https://github.com/deftai/directive/issues/3363",
      type: "x-xbrief/github-issue",
    });
  });

  it("extracts a provenance-only description URL including api.github.com", () => {
    expect(
      extractGithubIssueOrigin({
        xBRIEFInfo: {
          description: "Ingested from https://api.github.com/repos/o/r/issues/44",
        },
        plan: {},
      }),
    ).toMatchObject({ owner: "o", repo: "r", number: 44 });
    expect(
      extractGithubIssueOrigin({
        vBRIEFInfo: {
          description: "Ingested from https://github.com/o/r/issues/45",
        },
        plan: {},
      }),
    ).toMatchObject({ number: 45 });
  });

  it("skips non-object refs, non-github types, and unparseable github refs", () => {
    expect(
      extractGithubIssueOrigin({
        plan: {
          references: [
            "skip",
            { type: "x-xbrief/plan", uri: "https://github.com/o/r/issues/1" },
            { type: "github-issue", title: "no number" },
          ],
        },
      }),
    ).toBeNull();
    expect(extractGithubIssueOrigin({ plan: null as unknown as object })).toBeNull();
  });

  it("accepts a url field and #id-only refs", () => {
    expect(
      extractGithubIssueOrigin({
        plan: {
          references: [{ type: "github-issue", url: "https://github.com/o/r/issues/4" }],
        },
      }),
    ).toMatchObject({ owner: "o", repo: "r", number: 4 });
    expect(
      extractGithubIssueOrigin({
        plan: { references: [{ type: "github-issue", id: "#12" }] },
      }),
    ).toMatchObject({ owner: "", repo: "", number: 12 });
  });
});

describe("compareOriginFreshness", () => {
  it("flags stale when origin is newer", () => {
    expect(compareOriginFreshness("2026-08-14T16:00:00Z", "2026-08-14T17:00:00Z")).toBe("stale");
  });

  it("is current when brief is equal or newer", () => {
    expect(compareOriginFreshness("2026-08-14T17:00:00Z", "2026-08-14T17:00:00Z")).toBe("current");
    expect(compareOriginFreshness("2026-08-14T18:00:00Z", "2026-08-14T17:00:00Z")).toBe("current");
  });

  it("treats a missing brief timestamp as stale", () => {
    expect(compareOriginFreshness(null, "2026-08-14T17:00:00Z")).toBe("stale");
  });

  it("is uncomparable when origin stamp is missing or invalid", () => {
    expect(compareOriginFreshness("2026-08-14T16:00:00Z", null)).toBe("uncomparable");
    expect(compareOriginFreshness("2026-08-14T16:00:00Z", "   ")).toBe("uncomparable");
    expect(compareOriginFreshness("not-a-date", "also-not")).toBe("uncomparable");
  });

  it("treats a blank brief stamp as stale", () => {
    expect(compareOriginFreshness("   ", "2026-08-14T17:00:00Z")).toBe("stale");
  });
});

describe("evaluateOriginFreshness", () => {
  it("passes when there is no origin", () => {
    const result = evaluateOriginFreshness({ plan: { status: "running" } });
    expect(result).toEqual({ ok: true, kind: "no-origin" });
  });

  it("fails closed when the live origin is newer than the brief", () => {
    const result = evaluateOriginFreshness(ORIGIN_BRIEF, {
      fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("stale");
    expect(result.message).toContain("newer than this xBRIEF");
    expect(result.message).toContain("#2143");
    expect(result.message).toContain("Do not auto-write origin text");
    expect(result.message).not.toMatch(/overwrite the brief from origin automatically/i);
  });

  it("passes after dispose bumps brief updated past the origin", () => {
    const disposed = {
      ...ORIGIN_BRIEF,
      xBRIEFInfo: { ...ORIGIN_BRIEF.xBRIEFInfo, updated: "2026-08-14T17:00:00Z" },
    };
    const result = evaluateOriginFreshness(disposed, {
      fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z" }),
    });
    expect(result).toEqual({ ok: true, kind: "current" });
  });

  it("does not write origin text onto the brief", () => {
    const before = JSON.stringify(ORIGIN_BRIEF);
    evaluateOriginFreshness(ORIGIN_BRIEF, {
      fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z" }),
    });
    expect(JSON.stringify(ORIGIN_BRIEF)).toBe(before);
  });

  it("fails closed when the origin cannot be fetched", () => {
    const result = evaluateOriginFreshness(ORIGIN_BRIEF, {
      fetchOriginUpdatedAt: () => ({ error: "gh: Not Found" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Could not fetch origin");
    expect(result.message).toContain(ORIGIN_FRESHNESS_REMEDIATION);
  });

  it("skips the check when requested", () => {
    expect(evaluateOriginFreshness(ORIGIN_BRIEF, { skip: true })).toEqual({
      ok: true,
      kind: "no-origin",
    });
  });

  it("uses the default fetch when no injector is provided", () => {
    const result = evaluateOriginFreshness({
      plan: { references: [{ type: "github-issue", id: "#12" }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("missing owner/repo");
  });

  it("freshness-checks every GitHub issue URL in one Origin field", () => {
    const brief = {
      xBRIEFInfo: { version: "0.8", updated: "2026-08-14T16:00:00Z" },
      plan: {
        status: "running",
        narratives: {
          Origin:
            "See https://github.com/deftai/directive/issues/1 and https://github.com/deftai/directive/issues/2",
        },
      },
    };
    const checked: number[] = [];
    const result = evaluateOriginFreshness(brief, {
      fetchOriginUpdatedAt: (origin) => {
        checked.push(origin.number);
        return origin.number === 2
          ? { updatedAt: "2026-08-14T17:00:00Z" }
          : { updatedAt: "2026-08-14T15:00:00Z" };
      },
    });
    expect(checked).toEqual([1, 2]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("#2");
    expect(result.message).toContain("newer than this xBRIEF");
  });

  it("fails closed when a newer ingest Origin's body cannot be read (#7138)", () => {
    const brief = {
      xBRIEFInfo: { version: "0.8", updated: "2026-08-14T16:00:00Z" },
      plan: {
        status: "running",
        narratives: {
          Origin: "Ingested from https://github.com/deftai/directive/issues/3363",
        },
      },
    };
    const before = JSON.stringify(brief);
    const result = evaluateOriginFreshness(brief, {
      fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("origin unavailable");
    expect(result.message).toContain("#3363");
    expect(JSON.stringify(brief)).toBe(before);
  });

  it("fails closed when timestamps cannot be compared", () => {
    const result = evaluateOriginFreshness(ORIGIN_BRIEF, {
      fetchOriginUpdatedAt: () => ({ updatedAt: "not-a-date" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("uncomparable");
    expect(result.message).toContain("Could not compare origin");
  });
});

describe("fetchGithubIssueUpdatedAt", () => {
  it("reads updated_at from the REST payload", () => {
    const fetched = fetchGithubIssueUpdatedAt(
      {
        owner: "deftai",
        repo: "directive",
        number: 3363,
        uri: "https://github.com/deftai/directive/issues/3363",
        type: "x-xbrief/github-issue",
      },
      {
        scmCall: (_src, verb, args) => {
          expect(verb).toBe("api");
          expect(args?.[0]).toBe("repos/deftai/directive/issues/3363");
          return completed(JSON.stringify({ updated_at: "2026-08-14T17:00:00Z" }));
        },
      },
    );
    expect(fetched).toEqual({ updatedAt: "2026-08-14T17:00:00Z" });
  });

  it("surfaces gh failures without applying origin text", () => {
    const fetched = fetchGithubIssueUpdatedAt(
      {
        owner: "o",
        repo: "r",
        number: 1,
        uri: "https://github.com/o/r/issues/1",
        type: "github-issue",
      },
      {
        scmCall: () => completed("", "gh: Not Found (HTTP 404)", 1),
      },
    );
    expect(fetched).toEqual({ error: "gh: Not Found (HTTP 404)" });
  });

  it("rejects a missing owner/repo, thrown gh, and malformed payloads", () => {
    expect(
      fetchGithubIssueUpdatedAt({
        owner: "",
        repo: "",
        number: 1,
        uri: "",
        type: "github-issue",
      }),
    ).toEqual({ error: "origin reference is missing owner/repo in the GitHub issue URI" });
    expect(
      fetchGithubIssueUpdatedAt(
        {
          owner: "o",
          repo: "r",
          number: 1,
          uri: "https://github.com/o/r/issues/1",
          type: "github-issue",
        },
        {
          scmCall: () => {
            throw new Error("ENOENT");
          },
        },
      ),
    ).toEqual({ error: "gh CLI not available (ENOENT)" });
    expect(
      fetchGithubIssueUpdatedAt(
        {
          owner: "o",
          repo: "r",
          number: 1,
          uri: "https://github.com/o/r/issues/1",
          type: "github-issue",
        },
        {
          scmCall: () => {
            throw "raw";
          },
        },
      ),
    ).toEqual({ error: "gh CLI not available (raw)" });
    expect(
      fetchGithubIssueUpdatedAt(
        {
          owner: "o",
          repo: "r",
          number: 1,
          uri: "https://github.com/o/r/issues/1",
          type: "github-issue",
        },
        { scmCall: () => completed("", "", 2) },
      ),
    ).toEqual({ error: "gh api exited 2" });
    expect(
      fetchGithubIssueUpdatedAt(
        {
          owner: "o",
          repo: "r",
          number: 1,
          uri: "https://github.com/o/r/issues/1",
          type: "github-issue",
        },
        { scmCall: () => completed("not-json") },
      ),
    ).toEqual({ error: "origin issue payload is not valid JSON" });
    expect(
      fetchGithubIssueUpdatedAt(
        {
          owner: "o",
          repo: "r",
          number: 1,
          uri: "https://github.com/o/r/issues/1",
          type: "github-issue",
        },
        { scmCall: () => completed(JSON.stringify({ state: "open" })) },
      ),
    ).toEqual({ error: "origin issue payload lacks updated_at" });
  });
});

describe("briefUpdatedOf / formatOriginStaleMessage", () => {
  it("prefers xBRIEFInfo.updated over plan.updated", () => {
    expect(
      briefUpdatedOf({
        xBRIEFInfo: { updated: "2026-08-14T16:00:00Z" },
        plan: { updated: "2026-08-01T00:00:00Z" },
      }),
    ).toBe("2026-08-14T16:00:00Z");
    expect(briefUpdatedOf({ plan: { updated: "2026-08-01T00:00:00Z" } })).toBe(
      "2026-08-01T00:00:00Z",
    );
    expect(briefUpdatedOf({ xBRIEFInfo: { updated: "   " }, plan: {} })).toBeNull();
  });

  it("names re-read then dispose, not overwrite", () => {
    const message = formatOriginStaleMessage(
      {
        owner: "deftai",
        repo: "directive",
        number: 3363,
        uri: "https://github.com/deftai/directive/issues/3363",
        type: "x-xbrief/github-issue",
      },
      "2026-08-14T17:00:00Z",
      "2026-08-14T16:00:00Z",
    );
    expect(message).toContain("record intentional divergence");
    expect(message).toContain("#2143");
    expect(message).toContain("#309 D12");
    expect(
      formatOriginStaleMessage(
        { owner: "", repo: "", number: 1, uri: "", type: "github-issue" },
        "2026-08-14T17:00:00Z",
        null,
      ),
    ).toContain("(origin)");
  });
});

// ---------------------------------------------------------------------------
// #7138 (slice of #7007): content compare on drift.
// ---------------------------------------------------------------------------

const T_STORED = "2026-11-01T09:00:00Z";
const T_BRIEF = "2026-11-01T10:00:00Z";
const T_LATER = "2026-11-01T12:00:00Z";
const OVERVIEW = "Do the thing.\n\n## Acceptance Criteria\n\n- [ ] it works";
const AC_COMMENT = "More.\n\n## Acceptance Criteria\n\n- [ ] an extra criterion";
const PLAIN_TEXT = "PLAIN-COMMENT-TEXT thanks for the update";
const LEAN_ITEMS = ["First lean item.", "Second lean item."];

function row(
  id: number,
  body: string,
  login: string,
  updated: string = T_STORED,
  association = "CONTRIBUTOR",
): IssueComment {
  return {
    id,
    body,
    user: { login },
    created_at: updated,
    updated_at: updated,
    html_url: `https://github.com/o/r/issues/0#issuecomment-${id}`,
    author_association: association,
  };
}

const STORED_THREAD = [row(11, "stored plain note", "alice"), row(12, AC_COMMENT, "owner")];

function bodyBrief(
  options: {
    overview?: string | null;
    thread?: IssueComment[] | null;
    extraRefs?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  const overview = options.overview === undefined ? OVERVIEW : options.overview;
  const thread = options.thread === undefined ? STORED_THREAD : options.thread;
  return {
    xBRIEFInfo: { version: "0.8", updated: T_BRIEF },
    plan: {
      status: "running",
      narratives: {
        Origin: "Ingested from https://github.com/o/r/issues/5",
        ...(overview !== null ? { Overview: overview } : {}),
      },
      metadata: thread !== null ? { issueCommentThread: thread } : {},
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/5" },
        ...(options.extraRefs ?? []),
      ],
    },
  };
}

function specBrief(): Record<string, unknown> {
  return {
    xBRIEFInfo: { version: "0.8", updated: T_BRIEF },
    plan: {
      status: "running",
      narratives: {
        Origin: "Ingested from https://github.com/o/r/issues/8",
        Overview: LEAN_ITEMS.join("\n"),
      },
      metadata: {
        issueBody: "Slice s1 of #7",
        issueCommentThread: [row(81, "child note", "alice")],
        "x-directive/spec-path-source": {
          schema: "deft.scope.spec-path-source.v1",
          repo: "o/r",
          issue: 7,
          leanCommentId: 700,
          harvestDigest: "a".repeat(64),
          slice: "s1",
        },
      },
      acceptance: {
        admitted_source_sentences: LEAN_ITEMS,
        admitted_source_digest: digestAdmittedSourceSentences(LEAN_ITEMS),
      },
      references: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/8" },
        { type: "x-xbrief/refs", uri: "https://github.com/o/r/issues/7" },
      ],
    },
  };
}

interface Reads {
  readonly issue?: Partial<OriginIssueSnapshot> | { error: string };
  readonly comments?: IssueComment[] | { fail: string };
  readonly perm?: Record<string, boolean | null>;
  readonly spec?: SpecPathLiveIdentities;
  readonly others?: Record<number, OriginIssueSnapshot | { error: string }>;
}

function reads(
  authoritative: number,
  input: Reads,
): EvaluateOriginFreshnessOptions & { commentReads: number[] } {
  const commentReads: number[] = [];
  return {
    commentReads,
    fetchOriginUpdatedAt: (origin: GithubIssueOrigin) => {
      if (origin.number !== authoritative) {
        return input.others?.[origin.number] ?? { updatedAt: T_STORED };
      }
      const issue = input.issue ?? {};
      if ("error" in issue) {
        return issue;
      }
      return {
        updatedAt: T_LATER,
        body: authoritative === 5 ? OVERVIEW : "Parent body",
        state: "open",
        authorLogin: "owner",
        ...issue,
      };
    },
    fetchOriginComments: (origin) => {
      commentReads.push(origin.number);
      const comments = input.comments ?? [];
      return Array.isArray(comments)
        ? { ok: true, comments }
        : { ok: false, reason: comments.fail };
    },
    fetchAuthorWritePermission: (_repo, login) =>
      input.perm !== undefined && login in input.perm ? (input.perm[login] ?? null) : false,
    fetchSpecPathLiveIdentities: () => input.spec ?? { ok: true, identities: LEAN_ITEMS },
  };
}

function expectRefusal(result: ReturnType<typeof evaluateOriginFreshness>, reason: string): string {
  expect(result.ok).toBe(false);
  if (result.ok) return "";
  expect(result.reason).toBe(reason);
  expect(result.message).toContain(`reason: ${reason}`);
  expect(result.message).toContain(ORIGIN_FRESHNESS_REMEDIATION);
  return result.message;
}

function expectWarnPass(result: ReturnType<typeof evaluateOriginFreshness>): string[] {
  expect(result.ok).toBe(true);
  if (!result.ok) return [];
  const warnings = [...(result.warnings ?? [])];
  for (const warning of warnings) {
    expect(warning).not.toContain(PLAIN_TEXT);
  }
  return warnings;
}

describe("resolveOriginBaseline (#7138 item 1)", () => {
  it("uses the ingest Origin issue and Overview for a body-route brief", () => {
    const baseline = resolveOriginBaseline(bodyBrief());
    expect(baseline?.kind).toBe("body-route");
    if (baseline?.kind !== "body-route") return;
    expect(baseline.origin.number).toBe(5);
    expect(baseline.body).toBe(OVERVIEW);
    expect(baseline.thread).toHaveLength(2);
    const empty = resolveOriginBaseline(bodyBrief({ overview: null, thread: null }));
    expect(empty?.kind === "body-route" ? [empty.body, empty.thread] : null).toEqual(["", null]);
  });

  it("uses the source record's issue (the parent for a slice) for a Spec-path brief", () => {
    const baseline = resolveOriginBaseline(specBrief());
    expect(baseline?.kind).toBe("spec-path");
    if (baseline?.kind !== "spec-path") return;
    expect(baseline.origin).toMatchObject({ owner: "o", repo: "r", number: 7 });
    expect(baseline.storedBody).toBeNull();
  });

  it("has no baseline without an ingest Origin or with a refused body and no record", () => {
    expect(resolveOriginBaseline(ORIGIN_BRIEF)).toBeNull();
    const refused = bodyBrief();
    (refused.plan as { metadata: Record<string, unknown> }).metadata.issueBody = "refused";
    expect(resolveOriginBaseline(refused)).toBeNull();
    expect(resolveOriginBaseline({})).toBeNull();
  });
});

describe("body-route content compare (#7138 items 2-3)", () => {
  it("does not read comments when the origin did not drift", () => {
    const options = reads(5, { issue: { updatedAt: T_STORED } });
    expect(evaluateOriginFreshness(bodyBrief(), options)).toEqual({ ok: true, kind: "current" });
    expect(options.commentReads).toEqual([]);
  });

  it("passes a plain comment with one WARN naming its id and URL, never its text", () => {
    const options = reads(5, {
      comments: [...STORED_THREAD, row(21, PLAIN_TEXT, "bob", T_LATER)],
    });
    const warnings = expectWarnPass(evaluateOriginFreshness(bodyBrief(), options));
    expect(options.commentReads).toEqual([5]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("#5");
    expect(warnings[0]).toContain(
      "1 newer comment(s): 21 https://github.com/o/r/issues/0#issuecomment-21",
    );
    expect(warnings[0]).toContain("#2143");
  });

  it("passes a label (no new comment) with the WARN", () => {
    const warnings = expectWarnPass(
      evaluateOriginFreshness(bodyBrief(), reads(5, { comments: STORED_THREAD })),
    );
    expect(warnings).toEqual([expect.stringContaining("no newer comments")]);
  });

  it("passes a close with the WARN and a closed line", () => {
    const warnings = expectWarnPass(
      evaluateOriginFreshness(
        bodyBrief(),
        reads(5, { issue: { state: "closed" }, comments: STORED_THREAD }),
      ),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("is closed; closure alone does not refuse");
  });

  it("passes a same-content body edit (line ends and trailing whitespace only)", () => {
    const body = `${OVERVIEW.split("\n").join("  \r\n")}\r\n\r\n`;
    expectWarnPass(
      evaluateOriginFreshness(bodyBrief(), reads(5, { issue: { body }, comments: STORED_THREAD })),
    );
  });

  it("refuses a changed body, a Constraints-only change and a changed body on a closed origin", () => {
    for (const issue of [
      { body: "Do another thing." },
      { body: `${OVERVIEW}\n\n## Constraints\n\n- never touch the cache` },
      { body: "Do another thing.", state: "closed" },
    ]) {
      const message = expectRefusal(
        evaluateOriginFreshness(bodyBrief(), reads(5, { issue, comments: STORED_THREAD })),
        "origin body changed",
      );
      expect(message).toContain("#5");
    }
  });

  it("refuses an edited old comment that adds an Acceptance Criteria list by a writer", () => {
    const message = expectRefusal(
      evaluateOriginFreshness(
        bodyBrief(),
        reads(5, {
          comments: [row(11, AC_COMMENT, "alice", T_LATER), STORED_THREAD[1] as IssueComment],
          perm: { alice: true },
        }),
      ),
      "requirement comment",
    );
    expect(message).toContain("Comment 11");
    expect(message).toContain("acceptance-criteria");
  });

  it("refuses an Acceptance Criteria comment whose author permission read fails", () => {
    expectRefusal(
      evaluateOriginFreshness(
        bodyBrief(),
        reads(5, {
          comments: [...STORED_THREAD, row(21, AC_COMMENT, "bob", T_LATER)],
          perm: { bob: null },
        }),
      ),
      "author permission unknown",
    );
  });

  it("passes an Acceptance Criteria comment by a non-writer with the WARN", () => {
    const warnings = expectWarnPass(
      evaluateOriginFreshness(
        bodyBrief(),
        reads(5, {
          comments: [...STORED_THREAD, row(21, AC_COMMENT, "bob", T_LATER)],
          perm: { bob: false },
        }),
      ),
    );
    expect(warnings[0]).toContain("21 ");
  });

  it("passes a same-content edit of an ingest-time Acceptance Criteria comment", () => {
    const warnings = expectWarnPass(
      evaluateOriginFreshness(
        bodyBrief(),
        reads(5, {
          comments: [
            STORED_THREAD[0] as IssueComment,
            row(12, `${AC_COMMENT.split("\n").join("  \r\n")}\r\n`, "owner", T_LATER),
          ],
        }),
      ),
    );
    expect(warnings[0]).toContain("12 ");
  });

  it("does not re-refuse comments acknowledged by a later brief stamp (block/unblock)", () => {
    const restamped = bodyBrief();
    (restamped.xBRIEFInfo as Record<string, unknown>).updated = "2026-11-01T11:30:00Z";
    const ackTime = "2026-11-01T11:00:00Z";
    const warnings = expectWarnPass(
      evaluateOriginFreshness(
        restamped,
        reads(5, {
          comments: [
            row(11, AC_COMMENT, "alice", ackTime),
            STORED_THREAD[1] as IssueComment,
            row(24, "model: gpt-6\nrole: critic\n\nfindings", "owner", ackTime),
            row(25, PLAIN_TEXT, "bob", T_LATER),
          ],
          perm: { alice: true },
        }),
      ),
    );
    expect(warnings[0]).toContain("1 newer comment(s): 25 ");
  });

  it("ignores the Current shape section the issue cache appends to a cached body", () => {
    const cached =
      `${OVERVIEW}\n\n---\n\n## Canonical current shape (#1152 / #1870)\n\n` +
      "_Authoritative planning surface._\n\nOpen children: none.\n";
    expectWarnPass(
      evaluateOriginFreshness(
        bodyBrief({ overview: cached }),
        reads(5, { comments: STORED_THREAD }),
      ),
    );
    expectRefusal(
      evaluateOriginFreshness(
        bodyBrief({ overview: cached }),
        reads(5, { issue: { body: "Do another thing." }, comments: STORED_THREAD }),
      ),
      "origin body changed",
    );
  });

  it("refuses an ingest-time Acceptance Criteria comment edited to plain text, or deleted", () => {
    const edited = expectRefusal(
      evaluateOriginFreshness(
        bodyBrief(),
        reads(5, {
          comments: [STORED_THREAD[0] as IssueComment, row(12, PLAIN_TEXT, "owner", T_LATER)],
        }),
      ),
      "requirement comment",
    );
    expect(edited).toContain("Comment 12");
    expect(edited).toContain("was edited after ingest");
    expect(edited).not.toContain(PLAIN_TEXT);
    const deleted = expectRefusal(
      evaluateOriginFreshness(
        bodyBrief(),
        reads(5, { comments: [STORED_THREAD[0] as IssueComment] }),
      ),
      "requirement comment",
    );
    expect(deleted).toContain("was deleted after ingest");
  });

  it("refuses a new design-critique record and a new selected Current shape comment", () => {
    expectRefusal(
      evaluateOriginFreshness(
        bodyBrief(),
        reads(5, {
          comments: [
            ...STORED_THREAD,
            row(22, "model: gpt-6\nrole: critic\n\nfindings", "owner", T_LATER),
          ],
        }),
      ),
      "requirement comment",
    );
    const shape = expectRefusal(
      evaluateOriginFreshness(
        bodyBrief(),
        reads(5, {
          comments: [
            ...STORED_THREAD,
            row(
              23,
              "## Current shape (as of pass-2)\n\nOpen children: none.",
              "owner",
              T_LATER,
              "OWNER",
            ),
          ],
        }),
      ),
      "requirement comment",
    );
    expect(shape).toContain("current-shape");
  });

  it("an issue ingested with an empty body passes a plain comment and refuses a new body", () => {
    const brief = bodyBrief({ overview: null, thread: null });
    const comments = [
      row(30, "older note", "alice", T_STORED),
      row(31, PLAIN_TEXT, "bob", T_LATER),
    ];
    const warnings = expectWarnPass(
      evaluateOriginFreshness(brief, reads(5, { issue: { body: null }, comments })),
    );
    expect(warnings[0]).toContain("1 newer comment(s): 31 ");
    expectRefusal(
      evaluateOriginFreshness(brief, reads(5, { issue: { body: "Now it has a body." }, comments })),
      "origin body changed",
    );
  });

  it("refuses a failed thread read and an unreadable origin", () => {
    expectRefusal(
      evaluateOriginFreshness(bodyBrief(), reads(5, { comments: { fail: "page cap exhausted" } })),
      "origin unavailable",
    );
    expectRefusal(
      evaluateOriginFreshness(bodyBrief(), reads(5, { issue: { error: "HTTP 502" } })),
      "origin unavailable",
    );
  });

  it("only warns for a referenced origin's drift or fetch failure", () => {
    const brief = bodyBrief({
      extraRefs: [
        { type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/6" },
        { type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/9" },
      ],
    });
    const warnings = expectWarnPass(
      evaluateOriginFreshness(
        brief,
        reads(5, {
          issue: { updatedAt: T_STORED },
          others: { 6: { updatedAt: T_LATER }, 9: { error: "HTTP 404" } },
        }),
      ),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("referenced origin GitHub issue #6");
    expect(warnings[0]).toContain("does not refuse");
    expect(warnings[1]).toContain("referenced origin GitHub issue #9");
    expect(warnings[1]).toContain("HTTP 404");
  });

  it("keeps the timestamp refusal for a brief with no baseline", () => {
    expectRefusal(
      evaluateOriginFreshness(ORIGIN_BRIEF, {
        fetchOriginUpdatedAt: () => ({ updatedAt: "2026-08-14T17:00:00Z", body: "same" }),
      }),
      "no baseline",
    );
  });
});

describe("Spec-path content compare (#7138 item 4)", () => {
  it("checks a slice against its parent and passes a plain parent comment with the WARN", () => {
    const options = reads(7, {
      comments: [row(701, PLAIN_TEXT, "bob", T_LATER)],
      others: { 8: { updatedAt: T_LATER } },
    });
    const warnings = expectWarnPass(evaluateOriginFreshness(specBrief(), options));
    expect(options.commentReads).toEqual([7]);
    expect(warnings[0]).toContain("origin GitHub issue #7 (o/r)");
    expect(warnings[0]).toContain("701 ");
    expect(warnings[1]).toContain("referenced origin GitHub issue #8");
  });

  it("passes a parent label or body change with the WARN (the lean is the contract)", () => {
    expectWarnPass(evaluateOriginFreshness(specBrief(), reads(7, {})));
    expectWarnPass(
      evaluateOriginFreshness(specBrief(), reads(7, { issue: { body: "Edited parent body" } })),
    );
  });

  it("refuses a newer Acceptance Criteria comment by a writer on the parent", () => {
    expectRefusal(
      evaluateOriginFreshness(
        specBrief(),
        reads(7, { comments: [row(702, AC_COMMENT, "carol", T_LATER)], perm: { carol: true } }),
      ),
      "requirement comment",
    );
  });

  it("refuses a new design-critique record on the parent", () => {
    expectRefusal(
      evaluateOriginFreshness(
        specBrief(),
        reads(7, {
          comments: [row(703, "model: gpt-6\nrole: parent\n\nLean: v2", "owner", T_LATER)],
        }),
      ),
      "requirement comment",
    );
  });

  it("refuses a changed Spec-path lean, a pin that disagrees and an unreadable source", () => {
    expectRefusal(
      evaluateOriginFreshness(
        specBrief(),
        reads(7, {
          spec: { ok: false, kind: "mismatch", reason: "lean 700 of #7 changed after ingest" },
        }),
      ),
      "Spec-path source changed",
    );
    expectRefusal(
      evaluateOriginFreshness(
        specBrief(),
        reads(7, { spec: { ok: true, identities: ["A different item."] } }),
      ),
      "Spec-path source changed",
    );
    expectRefusal(
      evaluateOriginFreshness(
        specBrief(),
        reads(7, { spec: { ok: false, kind: "unavailable", reason: "forge outage" } }),
      ),
      "origin unavailable",
    );
  });

  it("refuses a failed parent thread read", () => {
    expectRefusal(
      evaluateOriginFreshness(specBrief(), reads(7, { comments: { fail: "HTTP 500" } })),
      "origin unavailable",
    );
  });
});
