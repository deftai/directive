/**
 * One story, one line (#6468): the closing-keywords story-line check, the
 * story-line writer, the plan-id adopter and the completion identity join on a
 * brief that names several issues. Test names carry the brief clause ids.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { tryAdoptPlanIdFromPrStory } from "../intent-constraint/plan-id-adopter.js";
import { listActiveRunningBriefs } from "../orphan-active/running-briefs.js";
import {
  type FetchPrPayloadFn,
  type MergeTimeForge,
  verifyStoryPrMergeIdentity,
} from "../scope/delivery-evidence.js";
import { EXIT_HITS_FOUND, EXIT_OK } from "./constants.js";
import { evaluateStoryLineRequirement, run, writeStoryLineToBodyFile } from "./main.js";
import {
  briefForBodyRef,
  briefRelPath,
  demandForBrief,
  storyIssueIdentityMessage,
  storyIssueOfBrief,
  storyIssuesOfBrief,
} from "./story-issue.js";
import type { RunGhFn } from "./types.js";

const REPO = "deftai/directive";
const PR = 5001;
/** Forge `pulls/<N>/files` rows (live check) and the same diff as `PrDiffPath` rows. */
const PRODUCT = [{ filename: "packages/core/src/x.ts", status: "modified" }];
const DIFF = [{ path: "packages/core/src/x.ts", status: "modified" }];
const temps: string[] = [];

afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-one-story-line-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  return root;
}

interface BriefOpts {
  /** `plan.narratives.Origin` text, e.g. "Ingested from https://github.com/o/r/issues/1". */
  readonly origin?: string;
  /** `x-directive/plan-id` binding origin, e.g. "deftai/directive#1". */
  readonly binding?: string;
  readonly status?: string;
  readonly productPr?: number;
  readonly id?: string;
}

function plan(issues: readonly number[], opts: BriefOpts = {}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (opts.productPr !== undefined) metadata.productPullRequest = opts.productPr;
  if (opts.binding !== undefined) {
    metadata["x-directive/plan-id"] = { version: 1, origin: opts.binding, id: opts.id };
  }
  return {
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    title: `story ${issues.join("/")}`,
    status: opts.status ?? "running",
    narratives: opts.origin !== undefined ? { Origin: opts.origin } : {},
    references: issues.map((n) => ({
      uri: `https://github.com/${REPO}/issues/${String(n)}`,
      type: "x-xbrief/github-issue",
    })),
    metadata,
    items: [],
  };
}

function ingested(n: number): string {
  return `Ingested from https://github.com/${REPO}/issues/${String(n)}`;
}

function writeBrief(root: string, name: string, p: Record<string, unknown>): string {
  const rel = `xbrief/active/${name}`;
  writeFileSync(
    join(root, rel),
    JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: p }),
    "utf8",
  );
  return rel;
}

function liveGh(body: string): RunGhFn {
  return (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("/files")) {
      return { returncode: 0, stdout: JSON.stringify(PRODUCT), stderr: "" };
    }
    if (cmd.includes("commits")) {
      return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
    }
    // `pr view --json body` (closing-keywords) and REST `pulls/<N>` (plan-id adopter).
    if (cmd.includes("body") || joined.includes(`pulls/${String(PR)}`)) {
      return { returncode: 0, stdout: JSON.stringify({ body }), stderr: "" };
    }
    return { returncode: 1, stdout: "", stderr: "unexpected" };
  };
}

/** `pr:check-closing-keywords --pr <PR>` on a live body (stubbed forge). */
function check(root: string, body: string): { code: number; err: string } {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const code = run(["--pr", String(PR), "--mode", "fp", "--repo", REPO, "--project-root", root], {
    runGh: liveGh(body),
  });
  const err = stderr.mock.calls.join("");
  stderr.mockRestore();
  return { code, err };
}

function gitFor(changed: readonly string[], branch = "feat/x"): RunGhFn {
  return (cmd) => {
    if (cmd[0] === "merge-base") return { returncode: 0, stdout: "abc123\n", stderr: "" };
    if (cmd[0] === "diff") {
      return { returncode: 0, stdout: changed.map((p) => `M\0${p}\0`).join(""), stderr: "" };
    }
    if (cmd.includes("rev-parse")) return { returncode: 0, stdout: `${branch}\n`, stderr: "" };
    return { returncode: 1, stdout: "", stderr: "unexpected" };
  };
}

function write(root: string, changed: readonly string[], body = "## Summary\n\nRefs #0") {
  const bodyFile = join(root, "body.md");
  writeFileSync(bodyFile, body, "utf8");
  const result = writeStoryLineToBodyFile({
    bodyFile,
    projectRoot: root,
    repo: REPO,
    part: false,
    runGit: gitFor(changed),
  });
  return { result, text: readFileSync(bodyFile, "utf8") };
}

const ok = <T>(nodes: readonly T[]) => ({
  ok: true as const,
  nodes,
  hasNextPage: false,
  endCursor: null,
});

/** A forge with no other merged PR, no body edits and no Connected links. */
const quietForge: MergeTimeForge = {
  listMergedPrsPage: () => ok([]),
  fetchBodyRevisionsPage: () => ok([]),
  fetchConnectionEventsPage: () => ok([]),
  fetchPrFilesPage: () => ok([{ status: "modified", filename: "packages/core/src/x.ts" }]),
  probeRateLimit: () => ({ graphqlRemaining: 5000, coreRemaining: 5000 }),
  nowMs: () => 0,
};

function join_(p: Record<string, unknown>, body: string) {
  const fetchPrPayload: FetchPrPayloadFn = (n, repo) =>
    n === PR && repo === REPO
      ? {
          merged_at: "2026-11-16T10:00:00Z",
          merge_commit_sha: "mergesha",
          base: { ref: "master" },
          head: { sha: "headsha" },
          body,
        }
      : null;
  return verifyStoryPrMergeIdentity({
    plan: p,
    evidence: { prNumber: PR },
    mergeCommit: "mergesha",
    fetchPrPayload,
    mergeTimeForge: quietForge,
  });
}

const ONE_LINE = "## Summary\n\nRefs #101\n\ndeft-story: 101\n";

describe("story issue and identity agreement (#6468 Bound items 1-2)", () => {
  it("clause.1: the story issue is the join anchor; another repository's anchor is none", () => {
    expect(storyIssueOfBrief(plan([103, 101, 102]), REPO)).toBe(103);
    expect(storyIssueOfBrief(plan([]), REPO)).toBeNull();
    const foreign = {
      references: [
        { uri: "https://github.com/other/repo/issues/7", type: "x-xbrief/github-issue" },
      ],
    };
    expect(storyIssueOfBrief(foreign, REPO)).toBeNull();
  });

  it("clause.2: only case A and case B refuse; the other owner-list shapes are usable", () => {
    const root = makeRoot();
    const own = writeBrief(root, "own.xbrief.json", plan([101, 102], { origin: ingested(101) }));
    const none = writeBrief(root, "none.xbrief.json", plan([201, 202]));
    const msg = (rel: string, issues: number[]) =>
      storyIssueIdentityMessage({
        projectRoot: root,
        repo: REPO,
        rel,
        plan: plan(issues),
        issue: issues[0] ?? 0,
      });
    expect(msg(own, [101, 102])).toBeNull();
    expect(msg(none, [201, 202])).toBeNull();
    expect(msg(none, [101])).toMatch(
      /lists another owner of #101: xbrief\/active\/own\.xbrief\.json/,
    );
    expect(
      storyIssueIdentityMessage({ projectRoot: root, repo: "bad", rel: own, plan: {}, issue: 1 }),
    ).toBeNull();
  });

  it("maps a body reference to the anchored brief, the one naming brief, or today's rule", () => {
    const root = makeRoot();
    writeBrief(root, "a.xbrief.json", plan([101, 102]));
    writeBrief(root, "b.xbrief.json", plan([201, 102]));
    const running = listActiveRunningBriefs(root);
    expect(briefForBodyRef(running, REPO, 101)).toBe(running[0]);
    expect(briefForBodyRef(running, REPO, 102)).toBe("today");
    expect(briefForBodyRef(running, REPO, 999)).toBeNull();
    const [first] = running;
    if (first === undefined) throw new Error("no running brief");
    expect(briefRelPath(first.path, root)).toBe("xbrief/active/a.xbrief.json");
    expect(demandForBrief({ projectRoot: root, repo: REPO, brief: first, fallback: [] })).toEqual({
      kind: "line",
      issue: 101,
      others: [102],
      rel: "xbrief/active/a.xbrief.json",
    });
    // Several naming briefs and no anchor: the requirement for N is as today.
    const result = evaluateStoryLineRequirement({
      bodyText: "Refs #102\n",
      prNumber: PR,
      projectRoot: root,
      repo: REPO,
      files: DIFF,
    });
    expect(result.required).toEqual([102]);
    expect(result.messages[0]).toContain("several running briefs name it");
  });

  it("maps a body reference to a brief that owns N without naming it; no refs, no issues", () => {
    const root = makeRoot();
    writeBrief(root, "o.xbrief.json", plan([801], { origin: ingested(802) }));
    const running = listActiveRunningBriefs(root);
    expect(briefForBodyRef(running, REPO, 802)).toBe(running[0]);
    expect(storyIssuesOfBrief(plan([]), REPO)).toEqual([]);
    expect(storyIssuesOfBrief(plan([], { binding: "other/repo#9" }), REPO)).toEqual([]);
  });

  it("keeps today's per-issue rule for a brief with no GitHub issue reference", () => {
    const root = makeRoot();
    writeBrief(
      root,
      "bound.xbrief.json",
      plan([], { binding: `${REPO}#301`, id: "github.issue.301", productPr: PR }),
    );
    const result = evaluateStoryLineRequirement({
      bodyText: "",
      prNumber: PR,
      projectRoot: root,
      repo: REPO,
      files: DIFF,
    });
    expect(result.required).toEqual([301]);
    expect(write(root, ["xbrief/active/bound.xbrief.json"]).text).toContain("deft-story: 301");
  });
});

describe("one line per running brief (#6468 Bound items 3-6)", () => {
  it("clause.3: a product-PR brief and a further-issue reference ask for the story issue only", () => {
    const root = makeRoot();
    writeBrief(root, "s.xbrief.json", plan([101, 102, 103], { productPr: PR }));
    const result = evaluateStoryLineRequirement({
      bodyText: "Refs #102, #103\n",
      prNumber: PR,
      projectRoot: root,
      repo: REPO,
      files: DIFF,
    });
    expect(result.required).toEqual([101]);
    expect(result.messages).toHaveLength(1);
  });

  it("clause.4: either line kind for the story issue satisfies it; both lines still fail", () => {
    const root = makeRoot();
    writeBrief(root, "s.xbrief.json", plan([101, 102, 103], { productPr: PR }));
    const req = (bodyText: string) =>
      evaluateStoryLineRequirement({
        bodyText,
        prNumber: PR,
        projectRoot: root,
        repo: REPO,
        files: DIFF,
      });
    expect(req("deft-story: 101\n").ok).toBe(true);
    expect(req("deft-story-part: 101\n").ok).toBe(true);
    expect(req("deft-story-part: 102\n").ok).toBe(false);
    expect(req("deft-story: 101\ndeft-story-part: 101\n").messages[0]).toMatch(/both/);
  });

  it("clause.5: the writer writes one line, for the story issue", () => {
    const root = makeRoot();
    const rel = writeBrief(root, "s.xbrief.json", plan([101, 102, 103], { origin: ingested(101) }));
    const { result, text } = write(root, [rel], "Refs #102\n");
    expect(result.code).toBe(0);
    expect(result.written).toEqual(["deft-story: 101"]);
    expect(text).toBe("Refs #102\n\ndeft-story: 101\n");
  });

  it("clause.6: the missing-line message names the story issue, the brief and the other issues", () => {
    const root = makeRoot();
    writeBrief(root, "s.xbrief.json", plan([101, 102, 103], { productPr: PR }));
    const { messages } = evaluateStoryLineRequirement({
      bodyText: "",
      prNumber: PR,
      projectRoot: root,
      repo: REPO,
      files: DIFF,
    });
    expect(messages[0]).toContain("running story #101");
    expect(messages[0]).toContain("xbrief/active/s.xbrief.json");
    expect(messages[0]).toContain("other issues the brief names (#102, #103) need no line");
  });

  it("clause.7: the join and the adopter still refuse a body with several marks, as before", () => {
    expect(join_(plan([101, 102, 103]), "deft-story: 101\ndeft-story: 102\n").ok).toBe(false);
    const root = makeRoot();
    writeBrief(root, "s.xbrief.json", plan([101], { origin: ingested(101), id: "github.issue.1" }));
    const adopted = tryAdoptPlanIdFromPrStory({
      projectRoot: root,
      pr: String(PR),
      repo: REPO,
      runGh: liveGh("deft-story: 101\ndeft-story: 102\n"),
    });
    expect(adopted.kind).toBe("config");
  });
});

describe("Acceptance Criteria of the accepted lean (#6468)", () => {
  function threeIssueStory(root: string): string {
    writeBrief(
      root,
      "other.xbrief.json",
      plan([901], { origin: ingested(901), id: "github.issue.901" }),
    );
    return writeBrief(
      root,
      "s.xbrief.json",
      plan([101, 102, 103], { origin: ingested(101), id: "github.issue.101", productPr: PR }),
    );
  }

  it("clause.8: a three-issue brief that owns its first issue passes with the one line", () => {
    const root = makeRoot();
    threeIssueStory(root);
    expect(check(root, ONE_LINE).code).toBe(EXIT_OK);
  });

  it("clause.9: the completion identity join admits that merged PR on the mark basis", () => {
    const result = join_(plan([101, 102, 103], { origin: ingested(101), productPr: PR }), ONE_LINE);
    expect(result.ok).toBe(true);
    expect(result.identityBasis).toBe("merge-time-mark");
  });

  it("clause.10: with several running briefs, the plan-id adopter resolves that brief", () => {
    const root = makeRoot();
    threeIssueStory(root);
    expect(listActiveRunningBriefs(root)).toHaveLength(2);
    expect(
      tryAdoptPlanIdFromPrStory({
        projectRoot: root,
        pr: String(PR),
        repo: REPO,
        runGh: liveGh(ONE_LINE),
      }),
    ).toEqual({ kind: "id", id: "github.issue.101" });
  });

  it("clause.11: the writer adds exactly one story line, for the story issue", () => {
    const root = makeRoot();
    const rel = threeIssueStory(root);
    const { result, text } = write(root, [rel], "## Summary\n\nRefs #101, #102, #103");
    expect(result.written).toEqual(["deft-story: 101"]);
    expect(text.match(/^deft-story/gm)).toEqual(["deft-story"]);
  });

  it("clause.12: a second, non-running owner of the story issue fails with the lookup's reason", () => {
    const root = makeRoot();
    threeIssueStory(root);
    writeBrief(
      root,
      "stale.xbrief.json",
      plan([101], { origin: ingested(101), status: "blocked" }),
    );
    const { code, err } = check(root, ONE_LINE);
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(err).toContain("xbrief/active/stale.xbrief.json (status: blocked)");
    expect(err).toContain("matches multiple xbrief/active briefs and cannot adopt a plan id");
  });

  it("clause.13: a bare-number ingest note on the first issue passes with the one line", () => {
    const root = makeRoot();
    writeBrief(
      root,
      "s.xbrief.json",
      plan([101, 102, 103], { origin: "Ingested from #101", productPr: PR }),
    );
    expect(check(root, ONE_LINE).code).toBe(EXIT_OK);
  });

  it("clause.14: a single-reference brief with no ownership record behaves as today", () => {
    const root = makeRoot();
    const rel = writeBrief(root, "s.xbrief.json", plan([101], { productPr: PR }));
    const missing = check(root, "Refs #101\n");
    expect(missing.code).toBe(EXIT_HITS_FOUND);
    expect(missing.err).toContain("running story #101");
    expect(missing.err).not.toContain("need no line");
    expect(check(root, ONE_LINE).code).toBe(EXIT_OK);
    expect(write(root, [rel], "Refs #101").result.written).toEqual(["deft-story: 101"]);
  });

  it("clause.15: brief A's first issue owned by running brief B fails and names B", () => {
    const root = makeRoot();
    writeBrief(root, "a.xbrief.json", plan([301, 302], { productPr: PR }));
    writeBrief(root, "b.xbrief.json", plan([301], { origin: ingested(301) }));
    const { code, err } = check(root, "Refs #301\n\ndeft-story: 301\n");
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(err).toContain("lists another owner of #301: xbrief/active/b.xbrief.json");
  });

  it("clause.16: three unowned issues pass with one line and complete on the mark basis", () => {
    const root = makeRoot();
    const p = plan([401, 402, 403], { productPr: PR });
    writeBrief(root, "s.xbrief.json", p);
    const body = "Refs #401, #402, #403\n\ndeft-story: 401\n";
    expect(check(root, body).code).toBe(EXIT_OK);
    const joined = join_(p, body);
    expect(joined.ok).toBe(true);
    expect(joined.identityBasis).toBe("merge-time-mark");
  });

  const WRONG_ORDER = () => plan([501, 502], { origin: ingested(502), productPr: PR });
  const OWNED_BY_OTHER = () => plan([601, 602], { origin: ingested(602), productPr: PR });

  it("clause.17: references in the wrong order fail with both issues and the repair", () => {
    const root = makeRoot();
    writeBrief(root, "s.xbrief.json", WRONG_ORDER());
    const { code, err } = check(root, "Refs #501\n\ndeft-story: 501\n");
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(err).toContain("anchors on #501");
    expect(err).toContain("it owns #502 and no brief owns #501");
    expect(err).toContain("Repair: make the owned issue (#502) the first GitHub issue reference");
  });

  it("clause.18: a first issue owned by another running brief fails with the case A message", () => {
    const root = makeRoot();
    writeBrief(root, "s.xbrief.json", OWNED_BY_OTHER());
    writeBrief(root, "t.xbrief.json", plan([601], { origin: ingested(601) }));
    const { code, err } = check(root, "Refs #601\n\ndeft-story: 601\n");
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(err).toContain("lists another owner of #601: xbrief/active/t.xbrief.json");
  });

  it("clause.19: for either brief the writer writes no line and prints that message", () => {
    const a = makeRoot();
    const relA = writeBrief(a, "s.xbrief.json", WRONG_ORDER());
    const wrong = write(a, [relA], "Refs #501");
    expect(wrong.result.code).toBe(1);
    expect(wrong.result.written).toEqual([]);
    expect(wrong.result.message).toContain("Repair: make the owned issue (#502)");
    expect(wrong.text).toBe("Refs #501");

    const b = makeRoot();
    const relB = writeBrief(b, "s.xbrief.json", OWNED_BY_OTHER());
    writeBrief(b, "t.xbrief.json", plan([601], { origin: ingested(601) }));
    const other = write(b, [relB], "Refs #601");
    expect(other.result.code).toBe(1);
    expect(other.result.message).toContain("lists another owner of #601");
    expect(other.text).toBe("Refs #601");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(
      [
        "--body-file",
        join(b, "body.md"),
        "--write-story-line",
        "--project-root",
        b,
        "--repo",
        REPO,
      ],
      { runGit: gitFor([relB]) },
    );
    const err = stderr.mock.calls.join("");
    stderr.mockRestore();
    expect(code).not.toBe(EXIT_OK);
    expect(err).toContain("lists another owner of #601");
  });

  it("clause.20: a Refs line to a further issue with no story line names the story issue", () => {
    const root = makeRoot();
    writeBrief(root, "s.xbrief.json", plan([101, 102, 103], { origin: ingested(101) }));
    const { code, err } = check(root, "Refs #102\n");
    expect(code).toBe(EXIT_HITS_FOUND);
    expect(err).toContain(
      "running story #101 (body names #102; running brief xbrief/active/s.xbrief.json)",
    );
  });

  it("clause.21: marks for the story issues of two running briefs are refused by the join", () => {
    const body = "deft-story: 101\ndeft-story: 201\n";
    const result = join_(plan([101, 102], { origin: ingested(101), productPr: PR }), body);
    expect(result.ok).toBe(false);
    expect(join_(plan([201], { origin: ingested(201), productPr: PR }), body).ok).toBe(false);
  });

  it("clause.22: a single-issue ingest brief behaves as today in each check", () => {
    const root = makeRoot();
    const rel = writeBrief(
      root,
      "s.xbrief.json",
      plan([101], { origin: ingested(101), id: "github.issue.101", productPr: PR }),
    );
    expect(check(root, "Refs #101\n").code).toBe(EXIT_HITS_FOUND);
    expect(check(root, ONE_LINE).code).toBe(EXIT_OK);
    expect(write(root, [rel], "Refs #101").result.written).toEqual(["deft-story: 101"]);
    expect(
      tryAdoptPlanIdFromPrStory({
        projectRoot: root,
        pr: String(PR),
        repo: REPO,
        runGh: liveGh(ONE_LINE),
      }),
    ).toEqual({ kind: "id", id: "github.issue.101" });
    expect(join_(plan([101], { origin: ingested(101), productPr: PR }), ONE_LINE).ok).toBe(true);
  });
});
