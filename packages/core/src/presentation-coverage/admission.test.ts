import { afterEach, expect, it, vi } from "vitest";
import { buildIntentConstraintRecord } from "../intent-constraint/mint.js";
import { currentStory, scopedMint, storyCovers } from "./admission.js";
import type { CoverageSnapshot } from "./snapshot.js";

const tree = { paths: [], errors: [], read: () => null };
it("requires current and merge-base story identity instead of historical mint fallback", () => {
  expect(
    currentStory({
      projectRoot: ".",
      mergeBase: "base",
      candidate: "head",
      changed: [],
      base: tree,
      head: tree,
    }),
  ).toHaveProperty("error");
});

const rel = "xbrief/active/current.xbrief.json";
const plan = {
  id: "current",
  status: "running",
  metadata: { swarm: { file_scope: ["src/**"] } },
  "x-directive/intentConstraint": { constraints: [] },
};
function fixture(
  base: Record<string, string>,
  head: Record<string, string> = base,
): CoverageSnapshot {
  const make = (files: Record<string, string>) => ({
    paths: Object.keys(files),
    errors: [],
    read: (p: string) => files[p] ?? null,
  });
  return {
    projectRoot: "/tmp/story",
    candidate: "head",
    mergeBase: "base",
    changed: [],
    base: make(base),
    head: make(head),
  };
}
afterEach(() => vi.unstubAllEnvs());
it("selects only a current story with matching base identity and immutable path scope", () => {
  const base = { [rel]: JSON.stringify({ plan }) };
  const snapshot = fixture(base, {
    [rel]: JSON.stringify({ plan: { ...plan, metadata: { swarm: { file_scope: ["**"] } } } }),
    "xbrief/active/peer.xbrief.json": JSON.stringify({ plan: { ...plan, id: "peer" } }),
  });
  vi.stubEnv("DEFT_ACTIVE_SCOPE", "/tmp/story/" + rel);
  const story = currentStory(snapshot);
  expect(story).toMatchObject({ planId: "current", scope: ["src/**"] });
  if ("error" in story) return;
  expect(storyCovers(story, "src/a.ts")).toBe(true);
  expect(storyCovers(story, "outside/a.ts")).toBe(false);
  expect(currentStory(snapshot, "missing")).toHaveProperty("error");
  vi.stubEnv("DEFT_ACTIVE_SCOPE", "xbrief/active/missing.xbrief.json");
  expect(currentStory(snapshot)).toHaveProperty("error");
});
it("refuses malformed, missing and incompatible base story identity", () => {
  const valid = JSON.stringify({ plan });
  for (const head of ["{", "[]", JSON.stringify({ plan: { ...plan, status: "completed" } })])
    expect(currentStory(fixture({ [rel]: valid }, { [rel]: head }))).toHaveProperty("error");
  for (const base of ["{", "[]", JSON.stringify({ plan: { ...plan, id: "other" } })])
    expect(currentStory(fixture({ [rel]: base }, { [rel]: valid }))).toHaveProperty("error");
  expect(currentStory(fixture({}, { [rel]: valid }))).toHaveProperty("error");
});
it("recomputes intent contracts and rejects invalid, duplicate and unrelated mint authority", () => {
  const record = buildIntentConstraintRecord({
    planId: "current",
    xbriefRelPath: rel,
    constraints: [],
    humanApproval: { kind: "human", actor: "David", mintedAt: "2026-09-28T00:00:00Z" },
  });
  const recordRel = ".deft/intent-constraint/current.json";
  const files = { [rel]: JSON.stringify({ plan }), [recordRel]: JSON.stringify(record) };
  const snapshot = fixture(files);
  const story = currentStory(snapshot, "current");
  if ("error" in story) throw new Error(story.error);
  expect(scopedMint(snapshot, story, "intent")).toHaveProperty("authority", recordRel);
  for (const text of ["{", "{}", JSON.stringify({ ...record, planId: "other" })])
    expect(scopedMint(fixture({ ...files, [recordRel]: text }), story, "intent")).toHaveProperty(
      "error",
    );
  expect(
    scopedMint(
      fixture({ ...files, ".deft/intent-constraint/duplicate.json": JSON.stringify(record) }),
      story,
      "intent",
    ),
  ).toHaveProperty("error");
  expect(
    scopedMint(
      snapshot,
      { ...story, headPlan: { ...plan, "x-directive/intentConstraint": {} } },
      "intent",
    ),
  ).toHaveProperty("error");
});
it("selects the story brief this change set moves to completed/ as lands-with-product (#6277)", () => {
  const done = "xbrief/completed/current.xbrief.json";
  const landed = {
    ...plan,
    status: "completed",
    metadata: {
      ...plan.metadata,
      lifecycleWrite: {
        action: "complete",
        writtenAt: "2026-11-16T00:00:00Z",
        completionDisposition: "lands-with-product",
      },
    },
  };
  const peer = "xbrief/active/peer.xbrief.json";
  const peerText = JSON.stringify({ plan: { ...plan, id: "peer" } });
  const base = { [rel]: JSON.stringify({ plan }), [peer]: peerText };
  const head = { [done]: JSON.stringify({ plan: landed }), [peer]: peerText };
  const snapshot = { ...fixture(base, head), changed: [rel, done, "src/a.ts"] };
  expect(currentStory(snapshot)).toMatchObject({ planId: "current", rel: done, scope: ["src/**"] });
  // Not in the change set, or without the disposition: not the moved story.
  expect(currentStory({ ...snapshot, changed: ["src/a.ts"] })).toMatchObject({ planId: "peer" });
  const plain = {
    [done]: JSON.stringify({ plan: { ...landed, metadata: plan.metadata } }),
    [peer]: peerText,
  };
  expect(currentStory({ ...fixture(base, plain), changed: [done] })).toMatchObject({
    planId: "peer",
  });
});
