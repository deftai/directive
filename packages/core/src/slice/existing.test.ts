import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import {
  buildChildren,
  childrenSet,
  consumeWaveFlags,
  findDuplicate,
  parseChildrenCsv,
  runList,
  runRecordExisting,
  summariseWaves,
  validateIssueExists,
} from "./existing.js";
import { writeSliceUnlocked } from "./record.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-slice-existing-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  mkdirSync(join(root, ".git"));
  return root;
}

function fakeScm(existing: Set<number>) {
  return (_source: string, _verb: string, args: readonly string[] | null): CompletedProcess => ({
    args: [...(args ?? [])],
    returncode: existing.has(Number(args?.[1])) ? 0 : 1,
    stdout: "",
    stderr: existing.has(Number(args?.[1])) ? "{}" : "missing",
  });
}

describe("existing helpers", () => {
  it("parseChildrenCsv validates input", () => {
    expect(parseChildrenCsv("2,3")).toEqual([2, 3]);
    expect(() => parseChildrenCsv("")).toThrow(/at least one/);
    expect(() => parseChildrenCsv("2,2")).toThrow(/duplicate/);
    expect(() => parseChildrenCsv("abc")).toThrow(/invalid child/);
  });

  it("consumeWaveFlags extracts wave assignments", () => {
    const { waveMap, remaining } = consumeWaveFlags([
      "record-existing",
      "--wave-1=2",
      "--wave-2=3",
      "--umbrella=1",
    ]);
    expect(remaining).toEqual(["record-existing", "--umbrella=1"]);
    expect(waveMap.get(1)).toEqual([2]);
    expect(waveMap.get(2)).toEqual([3]);
    expect(() =>
      consumeWaveFlags(["record-existing", "--wave-1=2", "--wave-2=2", "--children=2,3"]),
    ).toThrow(/both --wave/);
  });

  it("summariseWaves merges unassigned children into wave 1", () => {
    expect(summariseWaves(new Map(), 3)).toBe("3 in wave 1 (default)");
    expect(
      summariseWaves(
        new Map([
          [1, [2]],
          [2, [3]],
        ]),
        3,
      ),
    ).toBe("2 wave(s): wave-1=2, wave-2=1");
  });

  it("buildChildren assigns default wave and role", () => {
    const children = buildChildren([2, 3], new Map([[2, [3]]]), "owner/repo");
    expect(children[0]).toMatchObject({ n: 2, wave: 1, role: "manual" });
    expect(children[1]).toMatchObject({ n: 3, wave: 2 });
  });
});

describe("runRecordExisting", () => {
  it("writes a valid entry with skip-validation", () => {
    const root = makeRoot();
    const result = runRecordExisting(
      {
        umbrella: 1,
        children: "2,3",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: "2026-05-14T17:00:00Z",
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: true,
        repo: "owner/repo",
        projectRoot: root,
      },
      new Map(),
      { newSliceId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("slice_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("dry-run prints preview without writing", () => {
    const root = makeRoot();
    const result = runRecordExisting(
      {
        umbrella: 42,
        children: "100,101",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: "2026-05-14T17:00:00Z",
        notes: null,
        dryRun: true,
        force: false,
        skipValidation: true,
        repo: "owner/repo",
        projectRoot: root,
      },
      new Map(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"slice_id": "<dry-run>"');
    expect(result.stderr).toContain("DRY-RUN");
  });

  it("is idempotent for matching umbrella + child set", () => {
    const root = makeRoot();
    const path = join(root, "vbrief", ".eval", "slices.jsonl");
    writeSliceUnlocked(
      {
        slice_id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
        umbrella: 1,
        umbrella_url: "https://github.com/owner/repo/issues/1",
        sliced_at: "2026-05-14T17:00:00Z",
        actor: "manual:operator",
        children: [
          { n: 2, url: "https://github.com/owner/repo/issues/2", wave: 1, role: "manual" },
          { n: 3, url: "https://github.com/owner/repo/issues/3", wave: 1, role: "manual" },
        ],
        expected_close_signal: "all-children-merged",
      },
      { path },
    );
    const args = {
      umbrella: 1,
      children: "2,3",
      actor: "manual:operator",
      expectedCloseSignal: "all-children-merged",
      slicedAt: "2026-05-14T17:00:00Z",
      notes: null,
      dryRun: false,
      force: false,
      skipValidation: true,
      repo: "owner/repo",
      projectRoot: root,
    };
    const result = runRecordExisting(args, new Map());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("already has a matching record");
    expect(findDuplicate(1, [2, 3], path)).not.toBeNull();
  });

  it("rejects umbrella numbers listed as children", () => {
    const root = makeRoot();
    const result = runRecordExisting(
      {
        umbrella: 1,
        children: "1,2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: null,
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: true,
        repo: "owner/repo",
        projectRoot: root,
      },
      new Map(),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot also appear in --children");
  });

  it("validates issue existence via scm shim", () => {
    const root = makeRoot();
    const ok = runRecordExisting(
      {
        umbrella: 1,
        children: "2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: null,
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: false,
        repo: "owner/repo",
        projectRoot: root,
      },
      new Map(),
      { scm: fakeScm(new Set([1, 2])) },
    );
    expect(ok.exitCode).toBe(0);

    const bad = runRecordExisting(
      {
        umbrella: 1,
        children: "2,3",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: null,
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: false,
        repo: "owner/repo",
        projectRoot: root,
      },
      new Map(),
      { scm: fakeScm(new Set([1, 2])) },
    );
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("issue #3");
  });
});

describe("runList", () => {
  it("lists seeded records and empty state", () => {
    const root = makeRoot();
    expect(runList({ projectRoot: root, asJson: false }).stdout).toContain("no records found");
    const path = join(root, "vbrief", ".eval", "slices.jsonl");
    writeSliceUnlocked(
      {
        slice_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        umbrella: 10,
        umbrella_url: "u",
        sliced_at: "2026-05-14T17:00:00Z",
        actor: "skill:gh-slice",
        children: [{ n: 11, url: "u", wave: 1, role: "manual" }],
        expected_close_signal: "all-children-merged",
        notes: "note",
      },
      { path },
    );
    const listed = runList({ projectRoot: root, asJson: false });
    expect(listed.stdout).toContain("umbrella=#10");
    expect(listed.stdout).toContain("notes='note'");
    const json = runList({ projectRoot: root, asJson: true });
    expect(json.stdout).toContain('"umbrella": 10');
  });
});

describe("wave and validation helpers", () => {
  it("consumeWaveFlags accepts space-separated wave values", () => {
    const { waveMap } = consumeWaveFlags(["record-existing", "--wave-1", "2,3", "--umbrella=1"]);
    expect(waveMap.get(1)).toEqual([2, 3]);
  });

  it("validateIssueExists maps scm failures to IssueValidationError", () => {
    expect(() =>
      validateIssueExists(1, "o/r", {
        scm: () => {
          throw new Error("timeout");
        },
      }),
    ).toThrow(/timed out validating issue #1/);
    expect(() =>
      validateIssueExists(2, "o/r", {
        scm: () => ({ args: [], returncode: 1, stdout: "", stderr: "" }),
      }),
    ).toThrow(/\(no stderr\)/);
  });

  it("childrenSet ignores malformed child entries", () => {
    expect(childrenSet({ children: ["bad", { n: 2 }] }).has(2)).toBe(true);
  });
});
