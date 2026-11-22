import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhResult } from "../pr-protected-issues/types.js";
import type { GitRunner } from "../session/git.js";
import {
  discoverDeliveryEvidenceForComplete,
  type FetchClosingPrRefsFn,
  type FetchPrPayloadFn,
  type MergedPrListNode,
  type MergeTimeForge,
  type PrBodyRevision,
  type PrFileEntry,
  scanSoleMarkCompetitors,
} from "./delivery-evidence.js";
import { runTransition } from "./transition.js";

// The default runner is mocked so the stale-cache case can tell the
// cache-eligible binary (no override) from the plain `gh` override (#6873).
vi.mock("../pr-protected-issues/gh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pr-protected-issues/gh.js")>();
  return {
    ...actual,
    defaultRunGh: vi.fn(
      (_cmd: readonly string[], _binary?: string): RunGhResult => ({
        returncode: 1,
        stdout: "",
        stderr: "unmocked gh call",
      }),
    ),
  };
});

const REPO = "deftai/directive";
const ISSUE = 6212;
const NAME = "2026-11-12-6212-story.xbrief.json";
const MERGED_AT = "2026-11-12T10:00:00Z";
const BEFORE = "2026-11-12T09:00:00Z";
const AFTER = "2026-11-12T11:00:00Z";
const NOW = new Date("2026-11-12T12:00:00.000Z");

const gitAncestry: GitRunner = (_cwd, args) => {
  const joined = args.join(" ");
  if (joined.includes("merge-base") && joined.includes("--is-ancestor")) {
    return { code: 0, stdout: "", stderr: "" };
  }
  if (joined.includes("rev-parse") && joined.includes("origin/")) {
    return { code: 0, stdout: "deliverytip", stderr: "" };
  }
  if (joined.includes("symbolic-ref")) {
    return { code: 0, stdout: "origin/master", stderr: "" };
  }
  return { code: 0, stdout: "ok", stderr: "" };
};

interface ForgeOpts {
  readonly merged: readonly MergedPrListNode[];
  readonly files?: Readonly<Record<number, readonly PrFileEntry[]>>;
  readonly revisions?: Readonly<Record<number, readonly PrBodyRevision[]>>;
  readonly listFails?: boolean;
}

function forgeOf(opts: ForgeOpts): MergeTimeForge & { readonly listCalls: () => number } {
  let listCalls = 0;
  const page = <T>(nodes: readonly T[]) => ({
    ok: true as const,
    nodes,
    hasNextPage: false,
    endCursor: null,
  });
  return {
    listCalls: () => listCalls,
    listMergedPrsPage: () => {
      listCalls += 1;
      return opts.listFails === true
        ? { ok: false as const, error: "secondary rate limit" }
        : page(opts.merged);
    },
    fetchBodyRevisionsPage: (_repo, n) => page(opts.revisions?.[n] ?? []),
    fetchConnectionEventsPage: () => page([]),
    fetchPrFilesPage: (_repo, n) =>
      page(opts.files?.[n] ?? [{ status: "modified", filename: "packages/core/src/x.ts" }]),
    listOpenPrsPage: () => page([]),
    probeRateLimit: () => ({ graphqlRemaining: 5000, coreRemaining: 5000 }),
    nowMs: () => 0,
  };
}

function node(number: number, body: string, lastEditedAt: string | null = null): MergedPrListNode {
  return { number, mergedAt: MERGED_AT, body, lastEditedAt };
}

function payload(number: number, body: string, base = "master"): Record<string, unknown> {
  return {
    number,
    merged_at: MERGED_AT,
    merge_commit_sha: `merge${number}`,
    base: { ref: base },
    head: { sha: `head${number}` },
    body,
  };
}

function payloads(map: Record<number, Record<string, unknown>>): FetchPrPayloadFn {
  return (n, repo) => (repo === REPO ? (map[n] ?? null) : null);
}

const noClosers: FetchClosingPrRefsFn = () => ({ ok: true, refs: [] });

const PART = `deft-story-part: ${ISSUE}`;
const MARK = `deft-story: ${ISSUE}\n\nRefs #${ISSUE}`;
const BRIEF_FILES: readonly PrFileEntry[] = [
  { status: "added", filename: `xbrief/active/${NAME}` },
  { status: "added", filename: `changelog.d/${ISSUE}-activate.md` },
];

let root = "";
afterEach(() => {
  if (root.length > 0) {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
  vi.mocked(defaultRunGh).mockReset();
});

function makeStory(metadata: Record<string, unknown> = {}): string {
  root = mkdtempSync(join(tmpdir(), "mark-discovery-"));
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  const path = join(root, "xbrief", "active", NAME);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "two-PR story",
          status: "running",
          references: [
            { uri: `https://github.com/${REPO}/issues/${ISSUE}`, type: "x-xbrief/github-issue" },
          ],
          metadata: {
            kind: "story",
            swarm: { file_scope: ["packages/core/src/x.ts"] },
            ...metadata,
          },
          items: [],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path;
}

function planOf(path: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(path, "utf8")) as { plan: Record<string, unknown> }).plan;
}

function provenanceOf(path: string): Record<string, unknown> {
  const plan = planOf(path) as { metadata: { completionProvenance: Record<string, unknown> } };
  return plan.metadata.completionProvenance;
}

function discover(
  path: string,
  extra: {
    forge?: MergeTimeForge;
    fetchPrPayload?: FetchPrPayloadFn;
    fetchClosingPrRefs?: FetchClosingPrRefsFn;
  },
) {
  return discoverDeliveryEvidenceForComplete({
    projectRoot: root,
    plan: planOf(path),
    runGit: gitAncestry,
    fetchPrPayload: extra.fetchPrPayload,
    fetchClosingPrRefs: extra.fetchClosingPrRefs ?? noClosers,
    mergeTimeForge: extra.forge,
  });
}

function expectFlags(message: string): void {
  expect(message).toContain("--merge-commit <sha>");
  expect(message).toContain("--pr <n>");
}

describe("scope:complete discovers a deft-story: N product PR (#6873)", () => {
  it("completes a two-PR-path story with no flags (part-line activation PR) and restamps the same PR", () => {
    const path = makeStory();
    const options = {
      runGit: gitAncestry,
      fetchClosingPrRefs: noClosers,
      fetchClosingIssueIds: () => [],
      fetchPrPayload: payloads({ 6214: payload(6214, PART), 6215: payload(6215, MARK) }),
      mergeTimeForge: forgeOf({
        merged: [node(6214, PART), node(6215, MARK)],
        files: { 6214: BRIEF_FILES },
      }),
    };
    const result = runTransition("complete", path, NOW, options);
    expect(result.ok).toBe(true);
    const done = join(root, "xbrief", "completed", NAME);
    const stored = provenanceOf(done);
    expect(stored.prNumber).toBe(6215);
    expect(stored.mergeCommit).toBe("merge6215");
    expect(stored.identityBasis).toBe("merge-time-mark");

    // Restamp path: the brief is already in completed/.
    const restamp = runTransition("complete", done, NOW, options);
    expect(restamp.ok).toBe(true);
    expect(provenanceOf(done).prNumber).toBe(6215);
  });

  it("skips a brief-only activation PR that carries deft-story: N", () => {
    const path = makeStory();
    const result = runTransition("complete", path, NOW, {
      runGit: gitAncestry,
      fetchClosingPrRefs: noClosers,
      fetchClosingIssueIds: () => [],
      fetchPrPayload: payloads({ 6214: payload(6214, MARK), 6215: payload(6215, MARK) }),
      mergeTimeForge: forgeOf({
        merged: [node(6214, MARK), node(6215, MARK)],
        files: { 6214: BRIEF_FILES },
      }),
    });
    expect(result.ok).toBe(true);
    const stored = provenanceOf(join(root, "xbrief", "completed", NAME));
    expect(stored.prNumber).toBe(6215);
    expect(stored.identityBasis).toBe("merge-time-mark");
  });

  it("does not pick a PR whose mark was added only after merge", () => {
    const path = makeStory();
    const result = discover(path, {
      fetchPrPayload: payloads({ 6215: payload(6215, MARK) }),
      forge: forgeOf({
        merged: [node(6215, MARK, AFTER)],
        revisions: {
          6215: [
            { editedAt: BEFORE, body: `Refs #${ISSUE}` },
            { editedAt: AFTER, body: MARK },
          ],
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain(
        `no merged PR whose merge-time body carries the sole mark \`deft-story: ${ISSUE}\``,
      );
      expect(result.message).toContain("Stamp plan.metadata.productPullRequest or pass");
      expectFlags(result.message);
    }
  });

  it("refuses two marked PRs on different bases and names the delivery-branch stamp", () => {
    const path = makeStory();
    const result = discover(path, {
      fetchPrPayload: payloads({
        6215: payload(6215, MARK, "master"),
        6216: payload(6216, MARK, "develop"),
      }),
      forge: forgeOf({ merged: [node(6215, MARK), node(6216, MARK)] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("#6215 (base 'master', merge commit merge6215)");
      expect(result.message).toContain("#6216 (base 'develop', merge commit merge6216)");
      expect(result.message).toContain("metadata.productPullRequest in the brief on the fetched");
      expect(result.message).toContain("a working-tree stamp does not count");
      expectFlags(result.message);
    }
  });

  it("refuses one marked PR merged into another base and names it", () => {
    const path = makeStory();
    const result = discover(path, {
      fetchPrPayload: payloads({ 6216: payload(6216, MARK, "develop") }),
      forge: forgeOf({ merged: [node(6216, MARK)] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("#6216 (base 'develop', merge commit merge6216)");
      expect(result.message).toContain("--pr 6216 --merge-commit merge6216");
      expectFlags(result.message);
    }
  });

  it("refuses a failed scan page with a retry, never as zero", () => {
    const path = makeStory();
    const result = discover(path, {
      fetchPrPayload: payloads({}),
      forge: forgeOf({ merged: [], listFails: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("secondary rate limit");
      expect(result.message).toContain("Retry; passing --pr and --merge-commit runs the same scan");
      expect(result.message).not.toContain("found no merged PR");
      expectFlags(result.message);
    }
  });

  it("an incomplete scan page also refuses with the retry text", () => {
    const forge = forgeOf({ merged: [node(6215, MARK)] });
    const broken: MergeTimeForge = {
      ...forge,
      listMergedPrsPage: () => ({ ok: true, nodes: [], hasNextPage: true, endCursor: null }),
    };
    const path = makeStory();
    const result = discover(path, { fetchPrPayload: payloads({}), forge: broken });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("incomplete page");
      expect(result.message).toContain("Retry");
    }
  });

  it("keeps closing-PR and productPullRequest precedence without running the scan", () => {
    const path = makeStory();
    const forge = forgeOf({ merged: [node(6215, MARK)] });
    const closing = discover(path, {
      fetchPrPayload: payloads({ 6300: payload(6300, `Closes #${ISSUE}`) }),
      fetchClosingPrRefs: () => ({ ok: true, refs: [{ repository: REPO, prNumber: 6300 }] }),
      forge,
    });
    expect(closing.ok).toBe(true);
    if (closing.ok) expect(closing.message).toContain("closing PR #6300");

    const stamped = makeStory({ productPullRequest: 6301 });
    const seeded = discover(stamped, {
      fetchPrPayload: payloads({ 6301: payload(6301, "product") }),
      forge,
    });
    expect(seeded.ok).toBe(true);
    if (seeded.ok) expect(seeded.message).toContain("productPullRequest #6301");
    expect(forge.listCalls()).toBe(0);
  });

  it("without a forge, skips the mark step and says only closing links were searched", () => {
    const path = makeStory();
    const result = discover(path, { fetchPrPayload: payloads({ 6215: payload(6215, MARK) }) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("zero merged delivery-base PRs");
      expect(result.message).toContain("searched only the issue's closing-PR links");
      expect(result.message).not.toContain("sole mark");
      expectFlags(result.message);
    }
  });

  it("picks the sole marked PR and says so", () => {
    const path = makeStory();
    const result = discover(path, {
      fetchPrPayload: payloads({ 6215: payload(6215, MARK) }),
      forge: forgeOf({ merged: [node(6215, MARK)] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.discovered).toBe(true);
      expect(result.evidence?.prNumber).toBe(6215);
      expect(result.evidence?.mergeCommit).toBe("merge6215");
      expect(result.message).toBe(
        `auto-discovered delivery evidence from \`deft-story: ${ISSUE}\` PR #6215`,
      );
    }
  });

  it("reads PR payloads live in discovery and the gate when ghx holds a pre-merge copy", () => {
    vi.mocked(defaultRunGh).mockImplementation((cmd, binary) => {
      const path = cmd.slice(2).join(" ");
      if (path !== `repos/${REPO}/pulls/6215`) {
        return { returncode: 1, stdout: "", stderr: `unexpected ${path}` };
      }
      const live = binary === "gh";
      const body = live
        ? payload(6215, MARK)
        : { ...payload(6215, MARK), merged_at: null, merge_commit_sha: null };
      return { returncode: 0, stdout: JSON.stringify(body), stderr: "" };
    });
    const path = makeStory();
    const result = runTransition("complete", path, NOW, {
      runGit: gitAncestry,
      fetchClosingPrRefs: noClosers,
      fetchClosingIssueIds: () => [],
      fetchPrChangedFiles: () => [{ status: "modified", filename: "packages/core/src/x.ts" }],
      mergeTimeForge: forgeOf({ merged: [node(6215, MARK)] }),
    });
    expect(result.message).not.toMatch(/unmerged|not a merged/);
    expect(result.ok).toBe(true);
    expect(provenanceOf(join(root, "xbrief", "completed", NAME)).prNumber).toBe(6215);
    const binaries = vi.mocked(defaultRunGh).mock.calls.map((call) => call[1]);
    expect(binaries.length).toBeGreaterThan(0);
    expect(binaries.every((binary) => binary === "gh")).toBe(true);
  });

  it("scanSoleMarkCompetitors without a candidate counts every marked PR", () => {
    const scan = scanSoleMarkCompetitors({
      repository: REPO,
      issueNumber: ISSUE,
      forge: forgeOf({
        merged: [node(6214, PART), node(6215, MARK), node(6216, MARK)],
      }),
    });
    expect(scan).toEqual({ ok: true, competitors: [6215, 6216], partLinePrs: [6214] });
  });
});
