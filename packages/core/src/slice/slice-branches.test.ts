import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { main, parseCli, runCli } from "./cli.js";
import { runList, runRecordExisting, summariseWaves } from "./existing.js";
import { withAppendLock } from "./lock.js";
import { resolveProjectRoot } from "./project-context.js";
import { findBySliceId, readAll, writeSlice, writeSliceUnlocked } from "./record.js";
import { validateRecord } from "./validate.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-slice-branches-"));
  temps.push(root);
  mkdirSync(join(root, "vbrief", ".eval"), { recursive: true });
  mkdirSync(join(root, ".git"));
  return root;
}

describe("slice branch coverage", () => {
  it("parseCli covers record-existing flag errors and help", () => {
    expect(parseCli(["record-existing", "--umbrella"]).error).toContain("--umbrella");
    expect(parseCli(["record-existing", "--children"]).error).toContain("--children");
    expect(parseCli(["record-existing", "--actor"]).error).toContain("--actor");
    expect(parseCli(["record-existing", "--expected-close-signal"]).error).toContain(
      "expected-close-signal",
    );
    expect(parseCli(["record-existing", "--sliced-at"]).error).toContain("--sliced-at");
    expect(parseCli(["record-existing", "--notes"]).error).toContain("--notes");
    expect(parseCli(["record-existing", "--repo"]).error).toContain("--repo");
    expect(parseCli(["record-existing", "--project-root"]).error).toContain("--project-root");
    expect(parseCli(["record-existing", "--nope"]).error).toContain("unrecognized");
    expect(parseCli(["record-existing", "--json"]).error).toContain("unrecognized");
    expect(parseCli(["-h"]).error).toBe("help");
    expect(parseCli(["list", "--project-root"]).error).toContain("--project-root");
    expect(parseCli(["list", "--nope"]).error).toContain("unrecognized");
  });

  it("runCli routes wave pre-pass and duplicate stderr paths", () => {
    const root = makeRoot();
    expect(
      runCli([
        "record-existing",
        "--wave-1=9",
        "--umbrella=1",
        "--children=2",
        "--repo=o/r",
        "--skip-validation",
        `--project-root=${root}`,
      ]).exitCode,
    ).toBe(2);
    const dup = runRecordExisting(
      {
        umbrella: 1,
        children: "2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: "2026-05-14T17:00:00Z",
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: true,
        repo: "o/r",
        projectRoot: root,
      },
      new Map(),
      { newSliceId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    );
    expect(dup.exitCode).toBe(0);
    const again = runRecordExisting(
      {
        umbrella: 1,
        children: "2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: "2026-05-14T17:00:00Z",
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: true,
        repo: "o/r",
        projectRoot: root,
      },
      new Map(),
    );
    expect(again.stderr).toContain("already has a matching record");
  });

  it("runRecordExisting covers force, validation, and guard paths", () => {
    const root = makeRoot();
    writeSliceUnlocked(
      {
        slice_id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
        umbrella: 1,
        umbrella_url: "u",
        sliced_at: "2026-05-14T17:00:00Z",
        actor: "manual:operator",
        children: [{ n: 2, url: "u2", wave: 1, role: "manual" }],
        expected_close_signal: "all-children-merged",
      },
      { path: join(root, "vbrief", ".eval", "slices.jsonl") },
    );
    const forced = runRecordExisting(
      {
        umbrella: 1,
        children: "2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: "2026-05-14T17:00:00Z",
        notes: "note",
        dryRun: false,
        force: true,
        skipValidation: true,
        repo: "o/r",
        projectRoot: root,
      },
      new Map(),
      { newSliceId: () => "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee" },
    );
    expect(forced.exitCode).toBe(0);
    expect(readAll({ path: join(root, "vbrief", ".eval", "slices.jsonl") })).toHaveLength(2);

    expect(
      runRecordExisting(
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
          repo: "o/r",
          projectRoot: root,
        },
        new Map(),
      ).exitCode,
    ).toBe(2);

    expect(
      runRecordExisting(
        {
          umbrella: 1,
          children: "2,2",
          actor: "manual:operator",
          expectedCloseSignal: "all-children-merged",
          slicedAt: null,
          notes: null,
          dryRun: false,
          force: false,
          skipValidation: true,
          repo: "o/r",
          projectRoot: root,
        },
        new Map(),
      ).exitCode,
    ).toBe(2);

    expect(
      runRecordExisting(
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
          repo: "o/r",
          projectRoot: root,
        },
        new Map(),
        {
          scm: () => {
            throw new Error("source='gitlab' not yet supported");
          },
        },
      ).exitCode,
    ).toBe(1);

    expect(
      runRecordExisting(
        {
          umbrella: 1,
          children: "2",
          actor: "manual:operator",
          expectedCloseSignal: "all-children-merged",
          slicedAt: null,
          notes: null,
          dryRun: false,
          force: false,
          skipValidation: true,
          repo: null,
          projectRoot: root,
        },
        new Map(),
      ).exitCode,
    ).toBe(2);

    expect(() =>
      runRecordExisting(
        {
          umbrella: 1,
          children: "2",
          actor: "manual:operator",
          expectedCloseSignal: "all-children-merged",
          slicedAt: null,
          notes: null,
          dryRun: false,
          force: false,
          skipValidation: true,
          repo: "o/r",
          projectRoot: root,
        },
        new Map(),
        {
          scm: () => ({ args: [], returncode: 0, stdout: "", stderr: "" }),
          newSliceId: () => "bad-id",
        },
      ),
    ).not.toThrow();
  });

  it("validateRecord covers remaining child and field branches", () => {
    const base = {
      slice_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      umbrella: 1,
      umbrella_url: "u",
      sliced_at: "2026-05-14T17:00:00Z",
      actor: "a",
      children: [{ n: 2, url: "u", wave: 1, role: "r" }],
      expected_close_signal: "all-children-merged",
    };
    expect(() => validateRecord({ ...base, umbrella_url: "" })).toThrow(/umbrella_url/);
    expect(() => validateRecord({ ...base, actor: "" })).toThrow(/actor/);
    expect(() => validateRecord({ ...base, children: [] })).toThrow(/non-empty list/);
    expect(() =>
      validateRecord({ ...base, children: [{ n: 2, url: "u", wave: 0, role: "r" }] }),
    ).toThrow(/wave/);
    expect(() =>
      validateRecord({ ...base, children: [{ n: 2, url: "u", wave: 1, role: "" }] }),
    ).toThrow(/role/);
    expect(() =>
      validateRecord({ ...base, children: [{ n: 2, url: "u", wave: 1, role: "r", extra: 1 }] }),
    ).toThrow(/unknown field/);
    expect(() => validateRecord({ ...base, children: ["bad"] })).toThrow(/must be a dict/);
  });

  it("record and lock modules cover idempotent unlocked write and lock timeout", () => {
    const path = join(makeRoot(), "s.jsonl");
    const record = {
      slice_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      umbrella: 1,
      umbrella_url: "u",
      sliced_at: "2026-05-14T17:00:00Z",
      actor: "a",
      children: [{ n: 2, url: "u", wave: 1, role: "r" }],
      expected_close_signal: "all-children-merged",
    };
    writeSliceUnlocked(record, { path });
    expect(writeSliceUnlocked(record, { path })).toBe(record.slice_id);
    expect(findBySliceId("missing", { path })).toBeNull();

    let now = 0;
    expect(() =>
      withAppendLock(
        path,
        () => {
          withAppendLock(path, () => undefined, {
            now: () => now,
            sleepMs: () => {
              now += 31_000;
            },
          });
        },
        {
          now: () => now,
          sleepMs: () => {
            now += 31_000;
          },
        },
      ),
    ).toThrow(/not reentrant|timed out/);
  });

  it("writeSlice supports notes and custom clocks", () => {
    const path = join(makeRoot(), "s2.jsonl");
    writeSlice(1, [{ n: 2, url: "u", wave: 1, role: "r" }], {
      umbrellaUrl: "u1",
      actor: "a",
      notes: "n",
      sliceId: "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee",
      slicedAt: "2026-05-14T17:00:00Z",
      path,
      expectedCloseSignal: "manual",
    });
    expect(readAll({ path })[0]?.notes).toBe("n");
  });

  it("runRecordExisting hits authoritative duplicate under lock", () => {
    const root = makeRoot();
    let calls = 0;
    const result = runRecordExisting(
      {
        umbrella: 1,
        children: "2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: "2026-05-14T17:00:00Z",
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: true,
        repo: "o/r",
        projectRoot: root,
      },
      new Map(),
      {
        newSliceId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        findDuplicateFn: () => {
          calls += 1;
          if (calls === 1) {
            return null;
          }
          return { slice_id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", actor: "manual:operator" };
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("already has a matching record");
  });

  it("runCli handles pre-pass wave errors", () => {
    const result = runCli([
      "record-existing",
      "--wave-1=bad",
      "--umbrella=1",
      "--children=2",
      "--repo=o/r",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("error:");
  });

  it("project-context walks parents and rejects bad env roots", () => {
    const prev = process.env.DEFT_PROJECT_ROOT;
    process.env.DEFT_PROJECT_ROOT = "/missing/deft/root/path";
    expect(resolveProjectRoot(undefined)).toBeNull();
    process.env.DEFT_PROJECT_ROOT = prev;
  });

  it("runList and summariseWaves cover formatting branches", () => {
    const root = makeRoot();
    expect(runList({ projectRoot: "/missing-deft-root-xyz", asJson: false }).exitCode).toBe(2);
    expect(summariseWaves(new Map([[2, [3, 4]]]), 3)).toBe("2 wave(s): wave-1=1, wave-2=2");
    const prev = process.env.DEFT_PROJECT_ROOT;
    delete process.env.DEFT_PROJECT_ROOT;
    expect(resolveProjectRoot(undefined, root)).toBe(root);
    process.env.DEFT_PROJECT_ROOT = prev;
    expect(main(["list", `--project-root=${root}`])).toBe(0);
  });

  it("runRecordExisting surfaces missing repo when origin is absent", () => {
    const root = makeRoot();
    const result = runRecordExisting(
      {
        umbrella: 1,
        children: "2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: null,
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: true,
        repo: null,
        projectRoot: root,
      },
      new Map(),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("repo slug");
  });

  it("dry-run and write paths include optional notes", () => {
    const root = makeRoot();
    const dry = runRecordExisting(
      {
        umbrella: 1,
        children: "2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: "2026-05-14T17:00:00Z",
        notes: "backfill",
        dryRun: true,
        force: false,
        skipValidation: true,
        repo: "o/r",
        projectRoot: root,
      },
      new Map(),
    );
    expect(dry.stdout).toContain('"notes": "backfill"');
    const write = runRecordExisting(
      {
        umbrella: 2,
        children: "3",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: "2026-05-14T17:00:00Z",
        notes: "saved",
        dryRun: false,
        force: false,
        skipValidation: true,
        repo: "o/r",
        projectRoot: root,
      },
      new Map(),
      { newSliceId: () => "eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee" },
    );
    expect(write.exitCode).toBe(0);
    const saved = readAll({ path: join(root, "vbrief", ".eval", "slices.jsonl") }).find(
      (r) => r.umbrella === 2,
    );
    expect(saved?.notes).toBe("saved");
  });

  it("parseCli accepts equals-form flags and wave equals syntax", () => {
    const parsed = parseCli([
      "record-existing",
      "--umbrella=1",
      "--children=2,3",
      "--wave-1=2",
      "--repo=o/r",
      "--skip-validation",
    ]);
    expect(parsed.recordArgs?.umbrella).toBe(1);
    expect(parsed.waveMap.get(1)).toEqual([2]);
  });

  it("main writes stderr for idempotent no-op", () => {
    const root = makeRoot();
    const args = [
      "record-existing",
      "--umbrella=1",
      "--children=2",
      "--repo=o/r",
      "--skip-validation",
      "--sliced-at=2026-05-14T17:00:00Z",
      `--project-root=${root}`,
    ];
    expect(main(args)).toBe(0);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(main(args)).toBe(0);
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain(
        "already has a matching record",
      );
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it("rethrows unexpected dependency failures", () => {
    const root = makeRoot();
    expect(() =>
      runRecordExisting(
        {
          umbrella: 1,
          children: "2",
          actor: "manual:operator",
          expectedCloseSignal: "all-children-merged",
          slicedAt: "2026-05-14T17:00:00Z",
          notes: null,
          dryRun: false,
          force: false,
          skipValidation: true,
          repo: "o/r",
          projectRoot: root,
        },
        new Map(),
        {
          findDuplicateFn: () => {
            throw new Error("boom");
          },
        },
      ),
    ).toThrow("boom");

    expect(() =>
      runRecordExisting(
        {
          umbrella: 1,
          children: "2",
          actor: "manual:operator",
          expectedCloseSignal: "all-children-merged",
          slicedAt: "2026-05-14T17:00:00Z",
          notes: null,
          dryRun: false,
          force: false,
          skipValidation: true,
          repo: "o/r",
          projectRoot: root,
        },
        new Map(),
        {
          withLock: () => {
            throw new Error("lock fail");
          },
        },
      ),
    ).toThrow("lock fail");
  });

  it("runRecordExisting returns exit 1 when issue validation fails", () => {
    const root = makeRoot();
    const result = runRecordExisting(
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
        repo: "o/r",
        projectRoot: root,
      },
      new Map(),
      {
        scm: () => ({ args: [], returncode: 1, stdout: "", stderr: "404 Not Found" }),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("issue #1");
  });

  it("runRecordExisting rejects wave members outside --children", () => {
    const root = makeRoot();
    const result = runRecordExisting(
      {
        umbrella: 1,
        children: "2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: null,
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: true,
        repo: "o/r",
        projectRoot: root,
      },
      new Map([[1, [9]]]),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not present in --children");
  });

  it("runCli prefixes generic parse errors", () => {
    expect(runCli(["record-existing"]).stderr).toContain("required: --umbrella");
  });

  it("runCli rejects record-existing without parsed args", () => {
    expect(runCli(["record-existing"]).stderr).toContain("--umbrella");
  });

  it("runRecordExisting surfaces SliceRecordError from invalid generated record", () => {
    const root = makeRoot();
    const bad = runRecordExisting(
      {
        umbrella: 1,
        children: "2",
        actor: "manual:operator",
        expectedCloseSignal: "all-children-merged",
        slicedAt: "not-an-iso-ts",
        notes: null,
        dryRun: false,
        force: false,
        skipValidation: true,
        repo: "o/r",
        projectRoot: root,
      },
      new Map(),
      { newSliceId: () => "not-a-uuid" },
    );
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("invalid record");
  });
});
