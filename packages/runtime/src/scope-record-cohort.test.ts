import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeCohortDigest } from "./scope-record-cohort.js";
import { run as runIntent } from "./scope-record-intent-constraint.js";
import { run as runObservable } from "./scope-record-observable-scope.js";

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function human(prompts: { count: number }, answer = "mint") {
  return {
    isTty: () => true,
    hasControllingTerminal: () => true,
    readInteractiveConfirm: () => {
      prompts.count += 1;
      return answer;
    },
    environ: {},
    repo: "deftai/example",
  };
}

function capture(): { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  return { out: () => out, err: () => err };
}

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "record-cohort-"));
  temps.push(dir);
  mkdirSync(join(dir, "xbrief", "active"), { recursive: true });
  return dir;
}

function brief(
  dir: string,
  name: string,
  planId: string,
  extra: Record<string, unknown> = {
    "x-directive/observableChange": {
      changeKind: "fields-only",
      allowedChanges: [{ kind: "control", op: "add", name: planId }],
    },
  },
): string {
  const path = join(dir, "xbrief", "active", `${name}.xbrief.json`);
  writeFileSync(
    path,
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { id: planId, title: name, status: "running", items: [], ...extra },
    }),
    "utf8",
  );
  return path;
}

function obsRecord(dir: string, planId: string): string {
  return join(dir, ".deft", "observable-scope", `${planId}.json`);
}

function args(dir: string, ...rest: string[]): string[] {
  return [...rest, "--actor", "scott", "--confirm", "--project-root", dir];
}

describe("record cohort form (#6937)", () => {
  it("writes N records after one prompt with a shared cohortDigest", () => {
    const dir = root();
    const a = brief(dir, "a", "story-a");
    const b = brief(dir, "b", "story-b");
    const prompts = { count: 0 };
    const io = capture();
    expect(runObservable(args(dir, a, b), human(prompts))).toBe(0);
    expect(prompts.count).toBe(1);
    const ra = JSON.parse(readFileSync(obsRecord(dir, "story-a"), "utf8")) as Record<
      string,
      unknown
    >;
    const rb = JSON.parse(readFileSync(obsRecord(dir, "story-b"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(ra.cohortDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ra.cohortDigest).toBe(rb.cohortDigest);
    expect(ra.xbriefRelPath).toBe("xbrief/active/a.xbrief.json");
    const shown = io.out();
    expect(shown).toContain("2 record(s) to write after one typed mint");
    expect(shown).toContain(".deft/observable-scope/story-a.json");
    expect(shown).toContain("allowedChanges:");
    expect(shown).toContain("the record's control is the merge that lands it");
    expect(shown.indexOf("story-b.json")).toBeLessThan(shown.indexOf("Wrote "));
  });

  it("reads --manifest and lists briefs without a contract as skipped", () => {
    const dir = root();
    brief(dir, "a", "story-a");
    brief(dir, "b", "story-b");
    brief(dir, "c", "story-c", {});
    const manifest = join(dir, "launch.json");
    writeFileSync(
      manifest,
      JSON.stringify(
        ["a", "b", "c"].map((n) => ({
          story_id: n,
          xbrief_path: `xbrief/active/${n}.xbrief.json`,
        })),
      ),
      "utf8",
    );
    const prompts = { count: 0 };
    const io = capture();
    expect(runObservable(args(dir, "--manifest", manifest), human(prompts))).toBe(0);
    expect(prompts.count).toBe(1);
    expect(existsSync(obsRecord(dir, "story-a"))).toBe(true);
    expect(existsSync(obsRecord(dir, "story-b"))).toBe(true);
    expect(existsSync(obsRecord(dir, "story-c"))).toBe(false);
    expect(io.out()).toContain(
      'Skipped (no plan["x-directive/observableChange"]): xbrief/active/c.xbrief.json',
    );
  });

  it("writes nothing when the typed mint is refused or the shell is an agent", () => {
    const dir = root();
    const a = brief(dir, "a", "story-a");
    const b = brief(dir, "b", "story-b");
    capture();
    expect(runObservable(args(dir, a, b), human({ count: 0 }, "no"))).toBe(2);
    expect(
      runObservable(args(dir, a, b), { ...human({ count: 0 }), environ: { CLAUDECODE: "1" } }),
    ).toBe(2);
    expect(existsSync(join(dir, ".deft", "observable-scope"))).toBe(false);
  });

  it("refuses before the prompt when a named brief has no valid contract", () => {
    const dir = root();
    const a = brief(dir, "a", "story-a");
    const c = brief(dir, "c", "story-c", {});
    const prompts = { count: 0 };
    const io = capture();
    expect(runObservable(args(dir, a, c), human(prompts))).toBe(2);
    expect(prompts.count).toBe(0);
    expect(io.err()).toContain("refusing the whole cohort before the prompt");
    expect(io.err()).toContain("xbrief/active/c.xbrief.json");
    expect(existsSync(obsRecord(dir, "story-a"))).toBe(false);
  });

  it("refuses before the prompt when two plan ids map to one file name", () => {
    const dir = root();
    const a = brief(dir, "a", "story/x");
    const b = brief(dir, "b", "story_x");
    const prompts = { count: 0 };
    const io = capture();
    expect(runObservable(args(dir, a, b), human(prompts))).toBe(2);
    expect(prompts.count).toBe(0);
    expect(io.err()).toContain("map to one record file .deft/observable-scope/story_x.json");
  });

  it("leaves a matching existing record byte-identical and lists it", () => {
    const dir = root();
    const a = brief(dir, "a", "story-a");
    const b = brief(dir, "b", "story-b");
    capture();
    expect(runObservable(args(dir, a), human({ count: 0 }))).toBe(0);
    const before = readFileSync(obsRecord(dir, "story-a"));
    const prompts = { count: 0 };
    const io = capture();
    expect(runObservable(args(dir, a, b), human(prompts))).toBe(0);
    expect(prompts.count).toBe(1);
    expect(readFileSync(obsRecord(dir, "story-a")).equals(before)).toBe(true);
    expect(io.out()).toContain(
      "Already recorded (left untouched, not re-approved): .deft/observable-scope/story-a.json",
    );
    expect(existsSync(obsRecord(dir, "story-b"))).toBe(true);
  });

  it.each([
    [
      "contract",
      {
        changeKind: "fields-only",
        allowedChanges: [{ kind: "control", op: "add", name: "other" }],
      },
    ],
    [
      "changeKind",
      {
        changeKind: "layout-authorized",
        allowedChanges: [{ kind: "control", op: "add", name: "story-a" }],
      },
    ],
  ])("refuses the whole set before the prompt when an existing record's %s would change", (_label, contract) => {
    const dir = root();
    const a = brief(dir, "a", "story-a");
    const b = brief(dir, "b", "story-b");
    capture();
    expect(runObservable(args(dir, a), human({ count: 0 }))).toBe(0);
    const before = readFileSync(obsRecord(dir, "story-a"));
    brief(dir, "a", "story-a", { "x-directive/observableChange": contract });
    const prompts = { count: 0 };
    const io = capture();
    expect(runObservable(args(dir, a, b), human(prompts))).toBe(2);
    expect(prompts.count).toBe(0);
    expect(io.err()).toContain("existing record .deft/observable-scope/story-a.json would change");
    expect(io.err()).toContain("single-story form");
    expect(readFileSync(obsRecord(dir, "story-a")).equals(before)).toBe(true);
    expect(existsSync(obsRecord(dir, "story-b"))).toBe(false);
  });

  it("refuses when an existing record names another brief path or does not parse", () => {
    const dir = root();
    const a = brief(dir, "a", "story-a");
    const b = brief(dir, "b", "story-b");
    capture();
    expect(runObservable(args(dir, a), human({ count: 0 }))).toBe(0);
    const recA = obsRecord(dir, "story-a");
    const rec = JSON.parse(readFileSync(recA, "utf8")) as Record<string, unknown>;
    writeFileSync(recA, JSON.stringify({ ...rec, xbriefRelPath: "xbrief/active/old.xbrief.json" }));
    let io = capture();
    expect(runObservable(args(dir, a, b), human({ count: 0 }))).toBe(2);
    expect(io.err()).toContain("would change (brief path)");
    writeFileSync(recA, "{not json");
    io = capture();
    expect(runObservable(args(dir, a, b), human({ count: 0 }))).toBe(2);
    expect(io.err()).toContain("does not parse");
    expect(readFileSync(recA, "utf8")).toBe("{not json");
    expect(existsSync(obsRecord(dir, "story-b"))).toBe(false);
  });

  it("on a failed write removes only records it created and keeps pre-existing ones", () => {
    const dir = root();
    const a = brief(dir, "a", "story-a");
    const b = brief(dir, "b", "story-b");
    const c = brief(dir, "c", "story-c");
    capture();
    expect(runObservable(args(dir, a), human({ count: 0 }))).toBe(0);
    const before = readFileSync(obsRecord(dir, "story-a"));
    const io = capture();
    const code = runObservable(args(dir, a, b, c), {
      ...human({ count: 0 }),
      // Another writer creates C between the check and the publish: the
      // exclusive publish must not overwrite it.
      beforePublish: (abs: string) => {
        if (abs === obsRecord(dir, "story-c")) writeFileSync(abs, "foreign", "utf8");
      },
    });
    expect(code).not.toBe(0);
    expect(io.err()).toContain("removed the 1 record(s) this run created");
    expect(readFileSync(obsRecord(dir, "story-a")).equals(before)).toBe(true);
    expect(existsSync(obsRecord(dir, "story-b"))).toBe(false);
    expect(readFileSync(obsRecord(dir, "story-c"), "utf8")).toBe("foreign");
  });

  it("keeps cohortDigest stable across input order", () => {
    const one = root();
    const two = root();
    for (const dir of [one, two]) {
      brief(dir, "a", "story-a");
      brief(dir, "b", "story-b");
    }
    capture();
    const rel = (n: string) => `xbrief/active/${n}.xbrief.json`;
    expect(runObservable(args(one, rel("a"), rel("b")), human({ count: 0 }))).toBe(0);
    expect(runObservable(args(two, rel("b"), rel("a")), human({ count: 0 }))).toBe(0);
    const d1 = (
      JSON.parse(readFileSync(obsRecord(one, "story-a"), "utf8")) as { cohortDigest: string }
    ).cohortDigest;
    const d2 = (
      JSON.parse(readFileSync(obsRecord(two, "story-a"), "utf8")) as { cohortDigest: string }
    ).cohortDigest;
    expect(d1).toBe(d2);
    const entry = {
      kind: "observable-scope" as const,
      planId: "p",
      xbriefRelPath: "xbrief/active/p.xbrief.json",
      changeKind: "fields-only",
      contract: { allowedChanges: [] },
    };
    const other = { ...entry, planId: "q", xbriefRelPath: "xbrief/active/q.xbrief.json" };
    expect(computeCohortDigest([entry, other], "o/r")).toBe(
      computeCohortDigest([other, entry], "o/r"),
    );
    expect(computeCohortDigest([entry], "o/r")).not.toBe(computeCohortDigest([entry], "o/s"));
  });

  it("mints an intent-constraint cohort after one prompt", () => {
    const dir = root();
    const intent = (v: string) => ({
      "x-directive/intentConstraint": {
        constraints: [{ value: v, unit: "ms", rejectionScope: "operation" }],
      },
    });
    const a = brief(dir, "a", "story-a", intent("100"));
    const b = brief(dir, "b", "story-b", intent("200"));
    const prompts = { count: 0 };
    const io = capture();
    expect(runIntent(args(dir, a, b), human(prompts))).toBe(0);
    expect(prompts.count).toBe(1);
    const rec = JSON.parse(
      readFileSync(join(dir, ".deft", "intent-constraint", "story-b.json"), "utf8"),
    ) as { cohortDigest: string; constraints: unknown[] };
    expect(rec.cohortDigest).toMatch(/^sha256:/);
    expect(rec.constraints).toHaveLength(1);
    expect(io.out()).toContain("constraints:");
  });

  it("refuses brief paths together with --manifest", () => {
    const dir = root();
    const a = brief(dir, "a", "story-a");
    const io = capture();
    expect(runObservable(args(dir, a, "--manifest", "m.json"), human({ count: 0 }))).toBe(2);
    expect(io.err()).toContain("--manifest");
  });
});
