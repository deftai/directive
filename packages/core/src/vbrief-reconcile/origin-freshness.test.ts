import { describe, expect, it } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import {
  briefUpdatedOf,
  compareOriginFreshness,
  evaluateOriginFreshness,
  extractGithubIssueOrigin,
  fetchGithubIssueUpdatedAt,
  formatOriginStaleMessage,
  ORIGIN_FRESHNESS_REMEDIATION,
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

  it("fails closed when a provenance-only Origin URL is newer", () => {
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
    expect(result.message).toContain("#3363");
    expect(result.message).toContain("newer than this xBRIEF");
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
