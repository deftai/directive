/**
 * Spec-path harvest, source record and live identities (#6333).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import { extractBoundRemedyHarvest } from "./markdown-scanners.js";
import {
  attachSpecPathSourceRecord,
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
  harvestDigest: "a".repeat(64),
  slice: null,
};

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
