/**
 * Spec-path harvest, source record and live identities (#6333).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hashHarvestIdentity,
  hashHarvestIdentityPreFold,
} from "../design-critique/pain-audit-follow-through-gate.js";
import type { CompletedProcess } from "../scm/call.js";
import { extractBoundRemedyHarvest } from "./markdown-scanners.js";
import {
  ALL_ITEMS_SLICED_REASON,
  attachSpecPathSourceRecord,
  fetchPlanAdmittedSourceText,
  fetchSpecPathLiveIdentities,
  fetchSpecPathSourceComments,
  findSpecPathSliceHolders,
  harvestSpecPathLean,
  readSpecPathSourceRecord,
  resolveSpecPathLiveIdentities,
  SPEC_PATH_SOURCE_KEY,
  type SpecPathSourceRecord,
} from "./spec-path-source.js";

const PLAIN =
  "## In plain English\n\n" +
  "The problem was hand-built acceptance clauses.\n\n" +
  "The accepted design harvests both lists of the lean.\n\n";

const LEAN_ID = 7100000001;
const TABLE_ID = 7100000002;
const SYNTHESIS_ID = 7100000003;

function lean(extra = ""): string {
  return (
    `${PLAIN}**Lean:** bind.\n\nSpec-path: Bound remedy on this lean\n\n` +
    "## Bound remedy\n" +
    "1. Harvest both lists. Keep the order.\n" +
    "2. Record the source.\n\n" +
    "## Acceptance Criteria\n" +
    "- Given a lean, then both lists are harvested.\n" +
    "- Given a brief, then it records the source.\n" +
    extra
  );
}

function thread(leanBody: string): { id: number; body: string }[] {
  return [
    { id: LEAN_ID, body: leanBody },
    { id: TABLE_ID, body: "## Verified-claims table\n" },
    {
      id: SYNTHESIS_ID,
      body:
        `${PLAIN}design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n` +
        `Bound contract: successor lean ${LEAN_ID}, verified-claims table ${TABLE_ID}.\n`,
    },
  ];
}

const RECORD: SpecPathSourceRecord = {
  repo: "o/r",
  issue: 6333,
  leanCommentId: LEAN_ID,
  harvestDigest: hashHarvestIdentity(lean()),
  slice: null,
};

describe("review fixes (#6333)", () => {
  it("keeps a repeated requirement in each slice that names it", () => {
    const body =
      `${PLAIN}Spec-path: x\n\n## Bound remedy\n1. Same text.\n2. Other limb.\n\n` +
      "## Acceptance Criteria\n- Same text.\n\n## Slices\n- slice-a: B1\n- slice-b: A1\n";
    for (const label of ["slice-a", "slice-b"]) {
      const harvest = harvestSpecPathLean(body, { kind: "label", label });
      if (!harvest.ok) throw new Error(harvest.reason);
      expect(harvest.items.map((item) => item.title)).toEqual(["Same text."]);
    }
  });

  it("counts slice references by list position when a list repeats a title", () => {
    const body =
      `${PLAIN}Spec-path: x\n\n## Bound remedy\n1. Same.\n2. Same.\n3. Other.\n\n` +
      "## Slices\n- slice-a: B2\n- slice-b: B3\n";
    const a = harvestSpecPathLean(body, { kind: "label", label: "slice-a" });
    const b = harvestSpecPathLean(body, { kind: "label", label: "slice-b" });
    if (!a.ok || !b.ok) throw new Error("harvest refused");
    expect(a.items.map((item) => item.title)).toEqual(["Same."]);
    expect(b.items.map((item) => item.title)).toEqual(["Other."]);
    const parent = harvestSpecPathLean(body, { kind: "unlabeled" });
    if (!parent.ok) throw new Error(parent.reason);
    expect(parent.items.map((item) => item.title)).toEqual(["Same."]);
  });

  it("folds a list item that wraps onto a continuation line (#7001)", () => {
    const body =
      `${PLAIN}Spec-path: x\n\n## Bound remedy\n1. Limb.\n\n` +
      "## Acceptance Criteria\n- Reject the request\n  when the token has expired.\n";
    const harvest = harvestSpecPathLean(body, { kind: "unlabeled" });
    if (!harvest.ok) throw new Error(harvest.reason);
    expect(harvest.items.map((item) => item.title)).toEqual([
      "Limb.",
      "Reject the request when the token has expired.",
    ]);
  });

  it("fails when the lean changed after ingest", () => {
    const live = resolveSpecPathLiveIdentities({
      comments: thread(lean()),
      record: { ...RECORD, harvestDigest: "a".repeat(64) },
    });
    expect(live).toMatchObject({
      ok: false,
      kind: "mismatch",
      reason: expect.stringContaining("changed after ingest"),
    });
  });
});

function page(stdout: string, returncode = 0, stderr = ""): CompletedProcess {
  return { args: ["gh"], returncode, stdout, stderr } as CompletedProcess;
}

describe("harvestSpecPathLean (#6333 items 1 and 2)", () => {
  it("harvests the Bound remedy items followed by the Acceptance Criteria items", () => {
    const harvest = harvestSpecPathLean(lean(), { kind: "unlabeled" });
    expect(harvest.ok).toBe(true);
    if (!harvest.ok) return;
    expect(harvest.items.map((item) => item.title)).toEqual([
      "Harvest both lists. Keep the order.",
      "Record the source.",
      "Given a lean, then both lists are harvested.",
      "Given a brief, then it records the source.",
    ]);
    expect(harvest.sourceText).toContain("## Acceptance Criteria");
    expect(harvest.labels).toEqual([]);
    expect(harvest.harvestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps a two-sentence list item as one item", () => {
    const harvest = harvestSpecPathLean(lean(), { kind: "unlabeled" });
    if (!harvest.ok) throw new Error(harvest.reason);
    expect(harvest.items[0]?.title).toBe("Harvest both lists. Keep the order.");
  });

  it("harvests a lean with no Acceptance Criteria list as today", () => {
    const body = `${PLAIN}Spec-path: x\n\n## Bound remedy\n1. Only limb.\n`;
    const harvest = harvestSpecPathLean(body, { kind: "unlabeled" });
    if (!harvest.ok) throw new Error(harvest.reason);
    expect(harvest.items.map((item) => item.title)).toEqual(["Only limb."]);
    expect(harvest.sourceText).toBe(extractBoundRemedyHarvest(body).sourceText);
  });

  it("refuses an empty Bound remedy list even with Acceptance Criteria", () => {
    const body = `${PLAIN}Spec-path: x\n\n## Acceptance Criteria\n- Given x, then y.\n`;
    expect(harvestSpecPathLean(body, { kind: "unlabeled" })).toEqual({
      ok: false,
      reason: "cited successor lean has no Bound-remedy list",
    });
  });

  it("#7085: returns the slice labels when every item belongs to a slice", () => {
    const body = lean("\n## Slices\n- slice-a: B1, A1\n- slice-b: B2, A2\n");
    expect(harvestSpecPathLean(body, { kind: "unlabeled" })).toEqual({
      ok: false,
      reason: ALL_ITEMS_SLICED_REASON,
      labels: ["slice-a", "slice-b"],
    });
  });

  it("does not harvest an Acceptance Criteria heading inside a fenced example", () => {
    const body =
      `${PLAIN}Spec-path: x\n\n## Bound remedy\n1. Real limb.\n\n` +
      "```\n## Acceptance Criteria\n- Fenced sample.\n```\n";
    const harvest = harvestSpecPathLean(body, { kind: "unlabeled" });
    if (!harvest.ok) throw new Error(harvest.reason);
    expect(harvest.items.map((item) => item.title)).toEqual(["Real limb."]);
  });

  it("does not repeat an Acceptance Criteria item that equals a limb", () => {
    const body =
      `${PLAIN}Spec-path: x\n\n## Bound remedy\n1. Same text.\n\n` +
      "## Acceptance Criteria\n- Same text.\n- Other text.\n";
    const harvest = harvestSpecPathLean(body, { kind: "unlabeled" });
    if (!harvest.ok) throw new Error(harvest.reason);
    expect(harvest.items.map((item) => item.title)).toEqual(["Same text.", "Other text."]);
  });
});

describe("harvestSpecPathLean slices (#6333 item 6)", () => {
  const sliced = lean("\n## Slices\nItems by slice:\n- slice-a: B1, A1\n- slice-b: A2\n");

  it("takes the items of one label", () => {
    const harvest = harvestSpecPathLean(sliced, { kind: "label", label: "slice-a" });
    if (!harvest.ok) throw new Error(harvest.reason);
    expect(harvest.items.map((item) => item.title)).toEqual([
      "Harvest both lists. Keep the order.",
      "Given a lean, then both lists are harvested.",
    ]);
    expect(harvest.labels).toEqual(["slice-a", "slice-b"]);
    expect(harvest.sourceText).toBe(
      "- Harvest both lists. Keep the order.\n- Given a lean, then both lists are harvested.\n",
    );
  });

  it("takes the items with no label for the parent", () => {
    const harvest = harvestSpecPathLean(sliced, { kind: "unlabeled" });
    if (!harvest.ok) throw new Error(harvest.reason);
    expect(harvest.items.map((item) => item.title)).toEqual(["Record the source."]);
  });

  it("refuses an unknown label, a label with no Slices section and an all-labeled parent", () => {
    expect(harvestSpecPathLean(sliced, { kind: "label", label: "slice-z" }).ok).toBe(false);
    expect(harvestSpecPathLean(lean(), { kind: "label", label: "slice-a" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no Slices section"),
    });
    const all = lean("\n## Slices\n- slice-a: B1, B2, A1, A2\n");
    expect(harvestSpecPathLean(all, { kind: "unlabeled" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("belongs to a slice label"),
    });
  });

  it("refuses a reference outside the lists, a double assignment and a malformed line", () => {
    expect(
      harvestSpecPathLean(lean("\n## Slices\n- slice-a: B9\n"), { kind: "unlabeled" }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("B9") });
    expect(
      harvestSpecPathLean(lean("\n## Slices\n- slice-a: B1\n- slice-b: B1\n"), {
        kind: "unlabeled",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("assigned to both") });
    expect(
      harvestSpecPathLean(lean("\n## Slices\n- Slice A: B1\n"), { kind: "unlabeled" }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("Slices section") });
  });
});

describe("Spec-path source record (#6333 item 4)", () => {
  it("round-trips a record and rejects a malformed one", () => {
    const plan: Record<string, unknown> = { metadata: { kind: "story" } };
    attachSpecPathSourceRecord(plan, { ...RECORD, slice: "slice-a" });
    expect(readSpecPathSourceRecord(plan)).toEqual({ ...RECORD, slice: "slice-a" });
    expect((plan.metadata as Record<string, unknown>).kind).toBe("story");
    const meta = plan.metadata as Record<string, Record<string, unknown>>;
    for (const bad of [
      { leanCommentId: 0 },
      { harvestDigest: "short" },
      { repo: "no-slash" },
      { issue: 1.5 },
      { slice: "" },
      { schema: "other" },
    ]) {
      const copy = {
        metadata: { [SPEC_PATH_SOURCE_KEY]: { ...meta[SPEC_PATH_SOURCE_KEY], ...bad } },
      };
      expect(readSpecPathSourceRecord(copy)).toBeNull();
    }
    expect(readSpecPathSourceRecord({})).toBeNull();
    const fresh: Record<string, unknown> = {};
    attachSpecPathSourceRecord(fresh, RECORD);
    expect(readSpecPathSourceRecord(fresh)).toEqual(RECORD);
  });
});

describe("resolveSpecPathLiveIdentities (#6333 item 4)", () => {
  it("resolves the cited lean through the completed-arc record", () => {
    const live = resolveSpecPathLiveIdentities({ comments: thread(lean()), record: RECORD });
    expect(live).toEqual({
      ok: true,
      identities: [
        "Harvest both lists. Keep the order.",
        "Record the source.",
        "Given a lean, then both lists are harvested.",
        "Given a brief, then it records the source.",
      ],
    });
  });

  it("fails when the recorded lean id differs from the cited lean", () => {
    const live = resolveSpecPathLiveIdentities({
      comments: thread(lean()),
      record: { ...RECORD, leanCommentId: TABLE_ID },
    });
    expect(live).toMatchObject({
      ok: false,
      kind: "mismatch",
      reason: expect.stringContaining(`differs from the cited lean ${LEAN_ID}`),
    });
  });

  it("fails when the source issue has no completed-arc record", () => {
    const live = resolveSpecPathLiveIdentities({ comments: [], record: RECORD });
    expect(live).toMatchObject({ ok: false, kind: "mismatch" });
    const sliced = resolveSpecPathLiveIdentities({
      comments: thread(lean()),
      record: { ...RECORD, slice: "slice-a" },
    });
    expect(sliced).toMatchObject({ ok: false, reason: expect.stringContaining("no Slices") });
  });
});

describe("fetchSpecPathSourceComments (#6333 item 4)", () => {
  it("reads every page over REST", () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: "x" }));
    const seen: string[] = [];
    const result = fetchSpecPathSourceComments(RECORD, (path) => {
      seen.push(path);
      return page(JSON.stringify(seen.length === 1 ? first : [{ id: 999, body: "y" }, { id: 5 }]));
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.comments).toHaveLength(101);
    expect(seen[0]).toBe("repos/o/r/issues/6333/comments?per_page=100&page=1");
    expect(seen).toHaveLength(2);
  });

  it("fails closed on an outage, a thrown spawn, non-JSON and a non-list page", () => {
    expect(fetchSpecPathSourceComments(RECORD, () => page("", 1, "HTTP 502"))).toEqual({
      ok: false,
      reason: "forge outage: HTTP 502",
    });
    expect(fetchSpecPathSourceComments(RECORD, () => page("", 1))).toEqual({
      ok: false,
      reason: "forge outage: exit 1",
    });
    expect(
      fetchSpecPathSourceComments(RECORD, () => {
        throw new Error("gh missing");
      }),
    ).toEqual({ ok: false, reason: "forge outage: gh missing" });
    expect(
      fetchSpecPathSourceComments(RECORD, () => {
        throw "boom";
      }),
    ).toEqual({ ok: false, reason: "forge outage: boom" });
    expect(fetchSpecPathSourceComments(RECORD, () => page("not json")).ok).toBe(false);
    expect(fetchSpecPathSourceComments(RECORD, () => page("{}")).ok).toBe(false);
    const full = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "" })));
    expect(fetchSpecPathSourceComments(RECORD, () => page(full))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("page cap"),
    });
  });

  it("composes the REST read with the resolver", () => {
    const body = JSON.stringify(thread(lean()));
    expect(fetchSpecPathLiveIdentities(RECORD, () => page(body)).ok).toBe(true);
    expect(fetchSpecPathLiveIdentities(RECORD, () => page("", 1, "down"))).toEqual({
      ok: false,
      kind: "unavailable",
      reason: "forge outage: down",
    });
  });
});

describe("verify:ac grandfathers a digestless audit of an unedited lean (#6477 clause.10)", () => {
  const STOP1_ID = 7200000001;
  const PAIN_LEAN_ID = 7200000002;
  const AUDIT_ID = 7200000003;
  const PAIN_TABLE_ID = 7200000004;
  const PAIN_SYNTHESIS_ID = 7200000005;
  const painLean = lean("\nrelieves: P1\n");
  const record: SpecPathSourceRecord = {
    ...RECORD,
    leanCommentId: PAIN_LEAN_ID,
    harvestDigest: hashHarvestIdentity(painLean),
  };

  /** One REST page; each row carries its own created_at / updated_at. */
  function restPage(leanUpdatedAt: unknown, auditCreatedAt: unknown): string {
    const rows: Record<string, unknown>[] = [
      {
        id: STOP1_ID,
        body: "role: parent\n\ndesign-critique: warranted, because hand work.\n\npain: P1\n",
        created_at: "2026-11-16T05:00:00Z",
        updated_at: "2026-11-16T05:00:00Z",
      },
      {
        id: PAIN_LEAN_ID,
        body: painLean,
        created_at: "2026-11-16T05:20:00Z",
        updated_at: leanUpdatedAt,
      },
      {
        id: AUDIT_ID,
        body: "role: critic\naudit-targets: pain-P1\nfinding-classes: none\nharvest-changed: false\n",
        created_at: auditCreatedAt,
        updated_at: auditCreatedAt,
      },
      {
        id: PAIN_TABLE_ID,
        body: "## Verified-claims table\n",
        created_at: "2026-11-16T05:30:00Z",
        updated_at: "2026-11-16T05:30:00Z",
      },
      {
        id: PAIN_SYNTHESIS_ID,
        body:
          `${PLAIN}design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n` +
          `Bound contract: successor lean ${PAIN_LEAN_ID}, verified-claims table ${PAIN_TABLE_ID}.\n`,
        created_at: "2026-11-16T05:31:00Z",
        updated_at: "2026-11-16T05:31:00Z",
      },
    ];
    return JSON.stringify(rows);
  }

  function live(leanUpdatedAt: unknown, auditCreatedAt: unknown) {
    return fetchSpecPathLiveIdentities(record, () => page(restPage(leanUpdatedAt, auditCreatedAt)));
  }

  it("copies created_at and updated_at from the REST row into the thread", () => {
    const result = fetchSpecPathSourceComments(record, () =>
      page(restPage("2026-11-16T05:26:59Z", "2026-11-16T05:28:57Z")),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments.find((c) => c.id === PAIN_LEAN_ID)).toMatchObject({
      updated_at: "2026-11-16T05:26:59Z",
    });
    expect(result.comments.find((c) => c.id === AUDIT_ID)).toMatchObject({
      created_at: "2026-11-16T05:28:57Z",
    });
  });

  it("admits strictly-before and refuses equal, later and unreadable timestamps, as issue:ingest does", () => {
    expect(live("2026-11-16T05:26:59Z", "2026-11-16T05:28:57Z")).toMatchObject({ ok: true });
    for (const [leanUpdatedAt, auditCreatedAt] of [
      ["2026-11-16T05:28:57Z", "2026-11-16T05:28:57Z"],
      ["2026-11-16T05:40:00Z", "2026-11-16T05:28:57Z"],
      [null, "2026-11-16T05:28:57Z"],
      ["2026-11-16T05:26:59Z", "yesterday"],
    ]) {
      expect(live(leanUpdatedAt, auditCreatedAt)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("no targeting audit counts for lean"),
      });
    }
  });
});

describe("findSpecPathSliceHolders (#6333 item 6)", () => {
  it("maps each recorded label to its brief and skips cancelled and other leans", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-path-holders-"));
    try {
      const write = (folder: string, name: string, record: SpecPathSourceRecord | null) => {
        mkdirSync(join(root, folder), { recursive: true });
        const plan: Record<string, unknown> = {};
        if (record !== null) attachSpecPathSourceRecord(plan, record);
        writeFileSync(join(root, folder, name), JSON.stringify({ plan }), "utf8");
      };
      write("active", "a.xbrief.json", { ...RECORD, repo: "O/R", slice: "slice-a" });
      write("cancelled", "b.xbrief.json", { ...RECORD, slice: "slice-b" });
      write("pending", "c.xbrief.json", { ...RECORD, leanCommentId: 1, slice: "slice-c" });
      write("completed", "d.xbrief.json", RECORD);
      write("proposed", "e.xbrief.json", null);
      writeFileSync(join(root, "proposed", "f.xbrief.json"), "{not json", "utf8");
      const holders = findSpecPathSliceHolders(root, RECORD);
      expect([...holders.entries()]).toEqual([["slice-a", "active/a.xbrief.json"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("criteria-only source record and live identities (#6609 item 6)", () => {
  const COMMENT_ID = 7200000001;
  const NW = "design-critique: not warranted, because the criteria are the whole change";
  const body = (items: readonly string[] = ["Crit one.", "Crit two."]): string =>
    `${NW}\n\nTarget-digest: sha256:${"b".repeat(64)}\n\n## Acceptance Criteria\n` +
    `${items.map((item) => `- ${item}`).join("\n")}\n`;
  const CRITERIA_RECORD: SpecPathSourceRecord = {
    repo: "o/r",
    issue: 77,
    leanCommentId: COMMENT_ID,
    harvestDigest: hashHarvestIdentity(body()),
    slice: null,
    kind: "criteria-only",
  };

  function forge(options: {
    commentBody?: string;
    commentLogin?: string;
    issueLogin?: string;
    permission?: string | null;
    outage?: boolean;
  }) {
    return (path: string): CompletedProcess => {
      if (options.outage === true) {
        return { args: [], returncode: 1, stdout: "", stderr: "502" };
      }
      const ok = (value: unknown): CompletedProcess => ({
        args: [],
        returncode: 0,
        stdout: JSON.stringify(value),
        stderr: "",
      });
      if (path === `repos/o/r/issues/comments/${COMMENT_ID}`) {
        return ok({
          id: COMMENT_ID,
          body: options.commentBody ?? body(),
          user: { login: options.commentLogin ?? "author" },
        });
      }
      if (path === "repos/o/r/issues/77") {
        return ok({ number: 77, user: { login: options.issueLogin ?? "author" } });
      }
      if (path.includes("/collaborators/")) {
        return options.permission === null || options.permission === undefined
          ? { args: [], returncode: 1, stdout: "", stderr: "404" }
          : ok({ permission: options.permission });
      }
      return { args: [], returncode: 1, stdout: "", stderr: "unexpected" };
    };
  }

  it("round-trips kind and reads a record without kind as a lean record", () => {
    const plan: Record<string, unknown> = {};
    attachSpecPathSourceRecord(plan, CRITERIA_RECORD);
    expect(readSpecPathSourceRecord(plan)).toEqual(CRITERIA_RECORD);
    const lean: Record<string, unknown> = {};
    attachSpecPathSourceRecord(lean, { ...CRITERIA_RECORD, kind: undefined });
    expect(readSpecPathSourceRecord(lean)?.kind).toBeUndefined();
    const meta = (plan.metadata as Record<string, Record<string, unknown>>)[SPEC_PATH_SOURCE_KEY];
    (meta as Record<string, unknown>).kind = "other";
    expect(readSpecPathSourceRecord(plan)).toBeNull();
  });

  it("resolves the items of the record comment by its author", () => {
    expect(fetchSpecPathLiveIdentities(CRITERIA_RECORD, forge({}))).toEqual({
      ok: true,
      identities: ["Crit one.", "Crit two."],
    });
  });

  it("accepts a writer who is not the author and refuses one who lost access", () => {
    const base = { commentLogin: "maintainer" };
    expect(
      fetchSpecPathLiveIdentities(CRITERIA_RECORD, forge({ ...base, permission: "write" })).ok,
    ).toBe(true);
    const lost = fetchSpecPathLiveIdentities(
      CRITERIA_RECORD,
      forge({ ...base, permission: "read" }),
    );
    expect(lost).toMatchObject({ ok: false, kind: "mismatch" });
    expect(
      fetchSpecPathLiveIdentities(CRITERIA_RECORD, forge({ ...base, permission: null })),
    ).toMatchObject({ ok: false, kind: "mismatch" });
  });

  it("refuses an edited record comment and an empty list", () => {
    const edited = fetchSpecPathLiveIdentities(
      CRITERIA_RECORD,
      forge({ commentBody: body(["Crit one.", "Crit two.", "Crit three."]) }),
    );
    expect(edited).toMatchObject({ ok: false, kind: "mismatch" });
    const emptied = fetchSpecPathLiveIdentities(
      { ...CRITERIA_RECORD, harvestDigest: hashHarvestIdentity(`${NW}\n`) },
      forge({ commentBody: `${NW}\n` }),
    );
    expect(emptied).toMatchObject({ ok: false, kind: "mismatch" });
  });

  it("reports a forge outage as unavailable, not as a mismatch", () => {
    expect(fetchSpecPathLiveIdentities(CRITERIA_RECORD, forge({ outage: true }))).toMatchObject({
      ok: false,
      kind: "unavailable",
    });
  });
});

describe("fetchPlanAdmittedSourceText (#6609 item 7)", () => {
  const ok = (value: unknown): CompletedProcess => ({
    args: [],
    returncode: 0,
    stdout: JSON.stringify(value),
    stderr: "",
  });
  const issuePlan = {
    references: [{ type: "x-xbrief/github-issue", uri: "https://github.com/o/r/issues/12" }],
  };

  it("reads the live body of the origin issue for a body-route brief", () => {
    let asked = "";
    const result = fetchPlanAdmittedSourceText(issuePlan, (path) => {
      asked = path;
      return ok({ body: "Live body." });
    });
    expect(asked).toBe("repos/o/r/issues/12");
    expect(result).toEqual({ ok: true, text: "Live body." });
    expect(fetchPlanAdmittedSourceText(issuePlan, () => ok({ body: null }))).toEqual({
      ok: true,
      text: "",
    });
  });

  it("reads the Overview harvest for a Spec-path brief, and fails closed when it is empty", () => {
    const specPath = (overview: string) => ({
      ...issuePlan,
      metadata: { issueBody: "refused" },
      narratives: { Overview: overview },
    });
    expect(fetchPlanAdmittedSourceText(specPath("- item"), () => ok({}))).toEqual({
      ok: true,
      text: "- item",
    });
    expect(fetchPlanAdmittedSourceText(specPath("  "), () => ok({})).ok).toBe(false);
  });

  it("fails on a missing or odd reference and on an outage", () => {
    expect(fetchPlanAdmittedSourceText({}, () => ok({})).ok).toBe(false);
    expect(
      fetchPlanAdmittedSourceText(
        { references: [{ type: "x-xbrief/github-issue", uri: "https://example.com/x" }] },
        () => ok({}),
      ).ok,
    ).toBe(false);
    expect(
      fetchPlanAdmittedSourceText(issuePlan, () => ({
        args: [],
        returncode: 1,
        stdout: "",
        stderr: "down",
      })),
    ).toMatchObject({ ok: false });
  });
});

describe("harvestSpecPathLean on the #6904 lean shape (#7001)", () => {
  const LEAN_6904 = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures/lean-6904-7070710091.md"),
    "utf8",
  );

  it("harvests, with item 8 carrying sub-items (a) to (f) as one item", () => {
    const harvest = harvestSpecPathLean(LEAN_6904, { kind: "unlabeled" });
    if (!harvest.ok) throw new Error(harvest.reason);
    expect(harvest.items).toHaveLength(18);
    const item8 = harvest.items[7]?.title ?? "";
    expect(item8.startsWith("Tests. None needs a built `dist` worker. (a) Through the seam")).toBe(
      true,
    );
    expect(item8.endsWith("asserts that `runSmokeCommand` forwards that plan.")).toBe(true);
    for (const marker of ["(a)", "(b)", "(c)", "(d)", "(e)", "(f)"]) {
      expect(item8).toContain(` ${marker} `);
    }
    expect(harvest.harvestDigest).toBe(hashHarvestIdentity(LEAN_6904));
    expect(harvest.harvestDigest).not.toBe(hashHarvestIdentityPreFold(LEAN_6904));
    expect(harvest.constraintLines).toHaveLength(3);
  });
});
