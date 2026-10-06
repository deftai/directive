import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashIssueBodyBytes, type ThreadComment } from "../design-critique/completed-arc-record.js";
import { DESIGN_CRITIQUE_CATALOG_CHIPS } from "../design-critique/exclusive-chip.js";
import { GitHubBodyError } from "../intake/github-body.js";
import { IssueCommentFetchError } from "../intake/issue-ingest.js";
import { ScmLabelClient, ScmLabelError } from "../vbrief-reconcile/labels.js";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import * as scm from "./call.js";
import {
  CHIP_ALIASES,
  DESIGN_CRITIQUE_CHIP_USAGE,
  type DesignCritiqueChipSeams,
  parseDesignCritiqueChipArgs,
  resolveDesignCritiqueChipArg,
  resolveRepoFromGitOrigin,
  runDesignCritiqueChip,
} from "./design-critique-chip.js";

/** Unit tests stub ensure so FakeLabelClient paths do not hit live REST (#5326). */
const ensurePresent: NonNullable<DesignCritiqueChipSeams["ensureCatalogChip"]> = () => ({
  ok: true,
  created: false,
  skippedExisting: true,
});

function runChip(
  extra: readonly string[],
  seams: DesignCritiqueChipSeams = {},
): ReturnType<typeof runDesignCritiqueChip> {
  return runDesignCritiqueChip(extra, { ensureCatalogChip: ensurePresent, ...seams });
}

const LEAN_ID = 5442939496;
const TABLE_ID = 5443106967;
const SYNTHESIS_ID = 5443114746;

const PLAIN_ENGLISH_SUMMARY =
  "## In plain English\n\n" +
  "The problem was missing ordinary-language summaries at ingest-ready.\n\n" +
  "The accepted design adds a presence-only gate on the cited artifacts.\n\n";

function withPlainEnglish(body: string): string {
  if (/(?:^|\n)##\s+In plain English\b/i.test(body)) return body;
  return `${PLAIN_ENGLISH_SUMMARY}${body}`;
}

const completeComments: ThreadComment[] = [
  {
    id: LEAN_ID,
    body: withPlainEnglish("**Lean:** operator amend of 5442883752. Chips stay convenience.\n"),
  },
  { id: TABLE_ID, body: "## Verified-claims table\n\n| Verified claim | Result |\n" },
  {
    id: SYNTHESIS_ID,
    body: withPlainEnglish(
      "model: grok-4.6\nrole: parent\n\n" +
        "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
        `Bound contract: successor lean ${LEAN_ID}, confirmed by operator, verified-claims table ${TABLE_ID}.\n`,
    ),
  },
];

const malformedCanonicalComments: ThreadComment[] = [
  { id: 1, body: "role: critic\n\n## Finding 1\n" },
  {
    id: SYNTHESIS_ID,
    body: "design-critique: synthesis accepted because agents agreed (empty disagreement set)\n",
  },
];

const unresolvedPainComments: ThreadComment[] = [
  {
    id: 10,
    body: "role: parent\n\ndesign-critique: warranted, because coverage gap.\n\npain: P1\npain: P2\n",
  },
  {
    id: LEAN_ID,
    body: withPlainEnglish("**Lean:** bind relief.\n\nrelieves: P1\nrelieves: P2\n"),
  },
  { id: TABLE_ID, body: "## Verified-claims table\n\n| Verified claim | Result |\n" },
  {
    id: SYNTHESIS_ID,
    body: withPlainEnglish(
      "model: grok-4.6\nrole: parent\n\n" +
        "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
        `Bound contract: successor lean ${LEAN_ID}, confirmed by operator, verified-claims table ${TABLE_ID}.\n`,
    ),
  },
];

const completeFetch = (): readonly ThreadComment[] => completeComments;
/** Unpinned lean fixtures: any live body admits (#4995). */
const unpinnedBodyFetch = (): string => "## Summary\n\nunpinned live body";

class FakeLabelClient implements LabelClient {
  labels: string[];
  applyCalls: Array<{ add: readonly string[]; remove: readonly string[] }> = [];

  constructor(labels: string[]) {
    this.labels = [...labels];
  }

  fetchLabels(_repo: string, _issueNumber: number): string[] {
    return [...this.labels];
  }

  apply(
    _repo: string,
    _issueNumber: number,
    add: readonly string[],
    remove: readonly string[],
  ): void {
    this.applyCalls.push({ add: [...add], remove: [...remove] });
    const next = new Set(this.labels);
    for (const name of remove) next.delete(name);
    for (const name of add) next.add(name);
    this.labels = [...next];
  }
}

describe("resolveDesignCritiqueChipArg", () => {
  it("CHIP_ALIASES covers every catalog chip short and full name", () => {
    for (const chip of DESIGN_CRITIQUE_CATALOG_CHIPS) {
      expect(CHIP_ALIASES[chip]).toBe(chip);
      const short = chip.slice("design-critique:".length);
      expect(CHIP_ALIASES[short]).toBe(chip);
    }
  });

  it("accepts short and full catalog names", () => {
    expect(resolveDesignCritiqueChipArg("ingest-ready")).toBe("design-critique:ingest-ready");
    expect(resolveDesignCritiqueChipArg("mechanism-shaped")).toBe(
      "design-critique:mechanism-shaped",
    );
    expect(resolveDesignCritiqueChipArg("in-progress")).toBe("design-critique:in-progress");
    expect(resolveDesignCritiqueChipArg("design-critique:ingest-ready")).toBe(
      "design-critique:ingest-ready",
    );
    expect(resolveDesignCritiqueChipArg("design-critique:in-progress")).toBe(
      "design-critique:in-progress",
    );
  });

  it("fails closed on unknown chip names", () => {
    expect(() => resolveDesignCritiqueChipArg("triage-ready")).toThrow(
      /unknown design-critique chip/,
    );
    expect(() => resolveDesignCritiqueChipArg("recut-needed")).toThrow(
      /unknown design-critique chip/,
    );
    expect(() => resolveDesignCritiqueChipArg("decisions-needed")).toThrow(
      /unknown design-critique chip/,
    );
    expect(() => resolveDesignCritiqueChipArg("design-critique:halted")).toThrow(
      /unknown design-critique chip/,
    );
    expect(() => resolveDesignCritiqueChipArg("critic-posted")).toThrow(
      /unknown design-critique chip/,
    );
    expect(() => resolveDesignCritiqueChipArg("bug")).toThrow(/unknown design-critique chip/);
    expect(() => resolveDesignCritiqueChipArg("recut")).toThrow(/unknown design-critique chip/);
  });
});

describe("parseDesignCritiqueChipArgs", () => {
  it("parses --issue --chip --repo", () => {
    expect(
      parseDesignCritiqueChipArgs([
        "--issue",
        "3642",
        "--chip",
        "ingest-ready",
        "--repo",
        "deftai/directive",
      ]),
    ).toEqual({
      issue: 3642,
      chip: "design-critique:ingest-ready",
      repo: "deftai/directive",
      json: false,
    });
  });

  it("parses -R as the repository flag (#3858)", () => {
    expect(
      parseDesignCritiqueChipArgs([
        "--issue",
        "3642",
        "--chip",
        "ingest-ready",
        "-R",
        "owner/repo",
      ]),
    ).toEqual({
      issue: 3642,
      chip: "design-critique:ingest-ready",
      repo: "owner/repo",
      json: false,
    });
  });

  it("accepts positional issue number", () => {
    expect(
      parseDesignCritiqueChipArgs([
        "3637",
        "--chip",
        "mechanism-shaped",
        "--repo",
        "deftai/directive",
        "--json",
      ]),
    ).toEqual({
      issue: 3637,
      chip: "design-critique:mechanism-shaped",
      repo: "deftai/directive",
      json: true,
    });
  });

  it("requires --chip and --issue; --repo may be omitted", () => {
    expect(() => parseDesignCritiqueChipArgs(["--chip", "ingest-ready"])).toThrow(
      /missing --issue/,
    );
    expect(parseDesignCritiqueChipArgs(["--issue", "1", "--chip", "ingest-ready"])).toEqual({
      issue: 1,
      chip: "design-critique:ingest-ready",
      repo: null,
      json: false,
    });
    expect(() =>
      parseDesignCritiqueChipArgs(["--issue", "1", "--repo", "deftai/directive"]),
    ).toThrow(/missing --chip/);
  });

  it("rejects leftover flags and non-integer issue", () => {
    expect(() =>
      parseDesignCritiqueChipArgs([
        "--issue",
        "1",
        "--chip",
        "ingest-ready",
        "--repo",
        "deftai/directive",
        "--add-label",
        "bug",
      ]),
    ).toThrow(/unrecognized flags/);
    expect(() =>
      parseDesignCritiqueChipArgs([
        "--issue",
        "1.5",
        "--chip",
        "ingest-ready",
        "--repo",
        "deftai/directive",
      ]),
    ).toThrow(/positive integer/);
    expect(() =>
      parseDesignCritiqueChipArgs([
        "1",
        "--issue",
        "2",
        "--chip",
        "ingest-ready",
        "--repo",
        "deftai/directive",
      ]),
    ).toThrow(/conflicts with positional/);
    expect(() =>
      parseDesignCritiqueChipArgs([
        "1",
        "2",
        "--chip",
        "ingest-ready",
        "--repo",
        "deftai/directive",
      ]),
    ).toThrow(/at most one positional/);
  });
});

describe("runDesignCritiqueChip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces mechanism-shaped with ingest-ready in one apply", () => {
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped", "area:cli"]);
    const result = runChip(
      ["--issue", "3642", "--chip", "ingest-ready", "--repo", "deftai/directive", "--json"],
      { client, fetchComments: completeFetch, fetchIssueBody: unpinnedBodyFetch },
    );
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toHaveLength(1);
    expect(client.applyCalls[0]).toEqual({
      add: ["design-critique:ingest-ready"],
      remove: ["design-critique:mechanism-shaped"],
    });
    const payload = JSON.parse(result.stdout) as {
      remaining: string[];
      add: string[];
      remove: string[];
    };
    expect(payload.remaining).toEqual(["bug", "area:cli", "design-critique:ingest-ready"]);
    expect(payload.add).toEqual(["design-critique:ingest-ready"]);
    expect(payload.remove).toEqual(["design-critique:mechanism-shaped"]);
    expect(client.labels.sort()).toEqual(
      ["area:cli", "bug", "design-critique:ingest-ready"].sort(),
    );
  });

  it("applies in-progress in one remaining-set write (#4298)", () => {
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped", "area:cli"]);
    const result = runChip(
      ["--issue", "4205", "--chip", "in-progress", "--repo", "deftai/directive", "--json"],
      { client },
    );
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toEqual([
      { add: ["design-critique:in-progress"], remove: ["design-critique:mechanism-shaped"] },
    ]);
    const payload = JSON.parse(result.stdout) as { remaining: string[] };
    expect(payload.remaining).toEqual(["bug", "area:cli", "design-critique:in-progress"]);
    expect(payload.remaining).not.toContain("design-critique:ingest-ready");
  });

  it("recuts to mechanism-shaped and keeps other facets", () => {
    const client = new FakeLabelClient(["enhancement", "design-critique:ingest-ready"]);
    const result = runChip(["--issue", "1", "--chip", "mechanism-shaped", "--repo", "o/r"], {
      client,
    });
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toEqual([
      { add: ["design-critique:mechanism-shaped"], remove: ["design-critique:ingest-ready"] },
    ]);
    expect(result.stdout).toContain("applied design-critique:mechanism-shaped");
    expect(result.stdout).toContain("removed design-critique:ingest-ready");
  });

  it("skips write when already exclusive", () => {
    const client = new FakeLabelClient(["process", "design-critique:ingest-ready"]);
    const result = runChip(
      ["--issue", "3642", "--chip", "ingest-ready", "--repo", "deftai/directive"],
      { client, fetchComments: completeFetch, fetchIssueBody: unpinnedBodyFetch },
    );
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toHaveLength(0);
    expect(result.stdout).toContain("already exclusive");
  });

  it("fails closed on unknown chip without writing", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runChip(
      ["--issue", "1", "--chip", "design-critique:halted", "--repo", "deftai/directive"],
      { client },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unknown design-critique chip/);
    expect(client.applyCalls).toHaveLength(0);
  });

  it("prints usage on --help", () => {
    const result = runChip(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(DESIGN_CRITIQUE_CHIP_USAGE.trim());
  });

  it("prints usage on -h", () => {
    const result = runChip(["-h"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("scm issue design-critique-chip");
  });

  it("adds the chip when no catalog name is present", () => {
    const client = new FakeLabelClient(["enhancement"]);
    const result = runChip(["--issue", "1", "--chip", "mechanism-shaped", "--repo", "o/r"], {
      client,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(added)");
    expect(client.applyCalls).toEqual([{ add: ["design-critique:mechanism-shaped"], remove: [] }]);
  });

  it("fails closed on invalid repo", () => {
    const result = runChip(["--issue", "1", "--chip", "ingest-ready", "--repo", "not-a-repo"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/invalid --repo value/);
  });

  it("treats fetch LabelClient failure as a non-blocking apply miss (#3806)", () => {
    const client: LabelClient = {
      fetchLabels: () => {
        throw new ScmLabelError("issue view failed");
      },
      apply: () => {
        throw new Error("should not write");
      },
    };
    const result = runChip(
      ["--issue", "1", "--chip", "ingest-ready", "--repo", "deftai/directive"],
      { client, fetchComments: completeFetch, fetchIssueBody: unpinnedBodyFetch },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("already exclusive");
    expect(result.stderr).toMatch(/chip apply missed \(non-blocking convenience\)/);
    expect(result.stderr).toMatch(/issue view failed/);
    expect(result.stderr).toMatch(/ingest is not blocked/);
  });

  it("treats ingest-ready comment fetch failure as blocking proof-fail (#4700)", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runChip(
      ["--issue", "1", "--chip", "ingest-ready", "--repo", "deftai/directive", "--json"],
      {
        client,
        fetchComments: () => {
          throw new IssueCommentFetchError("deftai/directive", 1, "page 1 failed");
        },
        fetchIssueBody: unpinnedBodyFetch,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(client.applyCalls).toHaveLength(0);
    const payload = JSON.parse(result.stdout) as { miss: boolean; blocking: boolean };
    expect(payload).toMatchObject({ miss: false, blocking: true });
    expect(result.stdout).not.toContain("chip apply missed");
  });

  it("treats ingest-ready body fetch failure as blocking proof-fail (#4995)", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runChip(
      ["--issue", "1", "--chip", "ingest-ready", "--repo", "deftai/directive", "--json"],
      {
        client,
        fetchComments: completeFetch,
        fetchIssueBody: () => {
          throw new GitHubBodyError("live REST body fetch failed");
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(client.applyCalls).toHaveLength(0);
    const payload = JSON.parse(result.stdout) as {
      miss: boolean;
      blocking: boolean;
      applied: boolean;
      error: string;
    };
    expect(payload).toMatchObject({ applied: false, miss: false, blocking: true });
    expect(payload.error).toMatch(/live REST body fetch failed/);
    expect(result.stdout).not.toContain("chip apply missed");
  });

  it("parses git origin as OWNER/NAME in this checkout", () => {
    const repo = resolveRepoFromGitOrigin();
    expect(repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  });

  it("resolves omitted --repo from git origin", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runChip(["--issue", "1", "--chip", "ingest-ready", "--json"], {
      client,
      resolveDefaultRepo: () => "deftai/directive",
      fetchComments: completeFetch,
      fetchIssueBody: unpinnedBodyFetch,
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { repo: string };
    expect(payload.repo).toBe("deftai/directive");
    expect(client.applyCalls).toHaveLength(1);
  });

  it("fails closed when --repo is omitted and origin cannot be resolved", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runChip(["--issue", "1", "--chip", "ingest-ready"], {
      client,
      resolveDefaultRepo: () => null,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/could not resolve from git origin/);
    expect(client.applyCalls).toHaveLength(0);
  });

  it("treats mocked LabelClient.apply failure as a miss, not already exclusive (#3806)", () => {
    const client: LabelClient = {
      fetchLabels: () => ["bug"],
      apply: () => {
        throw new Error("HTTP 403 Forbidden");
      },
    };
    const result = runChip(
      ["--issue", "1", "--chip", "ingest-ready", "--repo", "deftai/directive", "--json"],
      { client, fetchComments: completeFetch, fetchIssueBody: unpinnedBodyFetch },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("already exclusive");
    const payload = JSON.parse(result.stdout) as {
      applied: boolean;
      miss: boolean;
      blocking: boolean;
      error: string;
    };
    expect(payload).toMatchObject({ applied: false, miss: true, blocking: false });
    expect(payload.error).toMatch(/403/);
  });

  it("does not fetch comments for mechanism-shaped or in-progress (#4700)", () => {
    const client = new FakeLabelClient(["bug"]);
    let fetches = 0;
    const fetchComments = (): ThreadComment[] => {
      fetches += 1;
      return completeComments;
    };
    const shaped = runChip(["--issue", "1", "--chip", "mechanism-shaped", "--repo", "o/r"], {
      client,
      fetchComments,
    });
    expect(shaped.exitCode).toBe(0);
    expect(fetches).toBe(0);
    const progress = runChip(["--issue", "1", "--chip", "in-progress", "--repo", "o/r"], {
      client,
      fetchComments,
    });
    expect(progress.exitCode).toBe(0);
    expect(fetches).toBe(0);
  });

  it("refuses malformed canonical record plus label (#4700)", () => {
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped"]);
    const result = runChip(
      ["--issue", "652", "--chip", "ingest-ready", "--repo", "deftai/directive", "--json"],
      {
        client,
        fetchComments: () => malformedCanonicalComments,
        fetchIssueBody: unpinnedBodyFetch,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(client.applyCalls).toHaveLength(0);
    const payload = JSON.parse(result.stdout) as {
      miss: boolean;
      blocking: boolean;
      error: string;
    };
    expect(payload).toMatchObject({ miss: false, blocking: true });
    expect(payload.error).toMatch(/synthesis accepted because/);
    expect(result.stdout).not.toContain("chip apply missed");
  });

  it("refuses unresolved pain audit plus label (#4700)", () => {
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped"]);
    const result = runChip(
      ["--issue", "657", "--chip", "ingest-ready", "--repo", "deftai/directive"],
      {
        client,
        fetchComments: () => unresolvedPainComments,
        fetchIssueBody: unpinnedBodyFetch,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(client.applyCalls).toHaveLength(0);
    expect(result.stderr).toMatch(/unresolved-pain-audit/);
    expect(result.stderr).not.toMatch(/chip apply missed/);
  });

  it("chip caller refuses stale-target digest mismatch with zero writes (#4995)", () => {
    const liveBody = "## Summary\n\nNo trailing newline";
    const pinned = hashIssueBodyBytes(`${liveBody}\n`);
    const comments: ThreadComment[] = [
      {
        id: LEAN_ID,
        body: withPlainEnglish(`**Lean:** pin.\n\nTarget-digest: sha256:${pinned}\n`),
      },
      { id: TABLE_ID, body: "## Verified-claims table\n\n| Verified claim | Result |\n" },
      {
        id: SYNTHESIS_ID,
        body: withPlainEnglish(
          "model: grok-4.6\nrole: parent\n\n" +
            "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
            `Bound contract: successor lean ${LEAN_ID}, confirmed by operator, verified-claims table ${TABLE_ID}.\n`,
        ),
      },
    ];
    const client = new FakeLabelClient(["bug", "design-critique:mechanism-shaped"]);
    const result = runChip(
      ["--issue", "4995", "--chip", "ingest-ready", "--repo", "deftai/directive", "--json"],
      {
        client,
        fetchComments: () => comments,
        fetchIssueBody: () => liveBody,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(client.applyCalls).toHaveLength(0);
    const payload = JSON.parse(result.stdout) as { error: string; blocking: boolean };
    expect(payload.blocking).toBe(true);
    expect(payload.error).toMatch(/stale-target/);
  });

  it("does not re-enter ScmLabelClient ingest-ready gate after chip proof (#4995)", () => {
    const spy = vi.spyOn(scm, "call");
    spy
      .mockReturnValueOnce({
        args: [],
        returncode: 0,
        stdout: JSON.stringify({
          labels: [{ name: "bug" }, { name: "design-critique:mechanism-shaped" }],
        }),
        stderr: "",
      })
      .mockReturnValueOnce({ args: [], returncode: 0, stdout: "", stderr: "" });
    const result = runChip(
      ["--issue", "3637", "--chip", "ingest-ready", "--repo", "deftai/directive"],
      {
        client: new ScmLabelClient(),
        fetchComments: completeFetch,
        fetchIssueBody: unpinnedBodyFetch,
      },
    );
    expect(result.exitCode).toBe(0);
    // view + edit only; comments/body already supplied by seams (no second admit).
    expect(spy).toHaveBeenCalledTimes(2);
    const editArgs = spy.mock.calls[1]?.[2] ?? [];
    expect(editArgs).toContain("edit");
    expect(editArgs).toContain("design-critique:ingest-ready");
  });

  it("ensure-on-write then apply succeeds for virgin missing-repo-label (#5326)", () => {
    const client = new FakeLabelClient(["bug"]);
    let ensured = false;
    const result = runChip(
      ["--issue", "1", "--chip", "mechanism-shaped", "--repo", "o/r", "--json"],
      {
        client,
        ensureCatalogChip: () => {
          ensured = true;
          return { ok: true, created: true, skippedExisting: false };
        },
      },
    );
    expect(ensured).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toHaveLength(1);
    const payload = JSON.parse(result.stdout) as { chip: string; add: string[] };
    expect(payload.chip).toBe("design-critique:mechanism-shaped");
    expect(payload.add).toContain("design-critique:mechanism-shaped");
  });

  it("ensure-failed falls through as non-blocking miss (#5326)", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runChip(["--issue", "1", "--chip", "in-progress", "--repo", "o/r", "--json"], {
      client,
      ensureCatalogChip: () => ({
        ok: false,
        missClass: "ensure-failed",
        error: "Forbidden create",
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(client.applyCalls).toHaveLength(0);
    const payload = JSON.parse(result.stdout) as {
      miss: boolean;
      missClass: string;
      blocking: boolean;
      error: string;
    };
    expect(payload).toMatchObject({ miss: true, missClass: "ensure-failed", blocking: false });
    expect(payload.error).toMatch(/ensure-failed/);
  });

  it("auth-or-permission ensure miss stays non-blocking exit 0 (#5326)", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runChip(["--issue", "1", "--chip", "ingest-ready", "--repo", "o/r"], {
      client,
      fetchComments: completeFetch,
      fetchIssueBody: unpinnedBodyFetch,
      ensureCatalogChip: () => ({
        ok: false,
        missClass: "auth-or-permission",
        error: "label probe auth-or-permission",
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/chip apply missed/);
    expect(result.stderr).toMatch(/ensure-failed|auth-or-permission/);
    expect(client.applyCalls).toHaveLength(0);
  });

  it("ingest-ready proof fail does not call ensure (#5326)", () => {
    const client = new FakeLabelClient(["bug"]);
    let ensured = false;
    const result = runChip(["--issue", "1", "--chip", "ingest-ready", "--repo", "o/r", "--json"], {
      client,
      fetchComments: () => malformedCanonicalComments,
      fetchIssueBody: unpinnedBodyFetch,
      ensureCatalogChip: () => {
        ensured = true;
        return { ok: true, created: true, skippedExisting: false };
      },
    });
    expect(ensured).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(client.applyCalls).toHaveLength(0);
    const payload = JSON.parse(result.stdout) as { blocking: boolean; miss: boolean };
    expect(payload).toMatchObject({ blocking: true, miss: false });
  });

  it("uses seams.projectRoot for judgmentGates advisory (#5326)", () => {
    const client = new FakeLabelClient(["bug"]);
    const result = runChip(
      ["--issue", "1", "--chip", "mechanism-shaped", "--repo", "o/r", "--json"],
      {
        client,
        // Empty tree: not deposited → no advisory even if cwd has the deposit.
        projectRoot: mkdtempSync(join(tmpdir(), "dc-chip-root-")),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as { judgmentGatesAdvisory?: string };
    expect(payload.judgmentGatesAdvisory).toBeUndefined();
  });
});
