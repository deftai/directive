import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SliceRecordError } from "./errors.js";
import { withAppendLock } from "./lock.js";
import {
  findBySliceId,
  findByUmbrella,
  newSliceId,
  nowIso,
  readAll,
  writeSlice,
  writeSliceUnlocked,
} from "./record.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makePath(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-slice-record-"));
  temps.push(root);
  const path = join(root, "slices.jsonl");
  mkdirSync(join(root), { recursive: true });
  return path;
}

const child = { n: 2, url: "https://github.com/o/r/issues/2", wave: 1, role: "manual" };

describe("record module", () => {
  it("newSliceId returns a UUID string", () => {
    expect(newSliceId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("nowIso returns UTC Z suffix without fractional seconds", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("writeSlice uses generated ids when sliceId omitted", () => {
    const path = makePath();
    const sid = writeSlice(1, [child], {
      umbrellaUrl: "https://github.com/o/r/issues/1",
      actor: "manual:operator",
      newSliceId: () => "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee",
      nowIso: () => "2026-05-14T18:00:00Z",
      path,
    });
    expect(sid).toBe("dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(readAll({ path })[0]?.sliced_at).toBe("2026-05-14T18:00:00Z");
  });

  it("writeSlice roundtrips through readAll", () => {
    const path = makePath();
    const sid = writeSlice(1, [child], {
      umbrellaUrl: "https://github.com/o/r/issues/1",
      actor: "manual:operator",
      sliceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      slicedAt: "2026-05-14T17:00:00Z",
      path,
    });
    expect(sid).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const records = readAll({ path });
    expect(records).toHaveLength(1);
    expect(records[0]?.umbrella).toBe(1);
  });

  it("writeSlice is idempotent on slice_id retry", () => {
    const path = makePath();
    const opts = {
      umbrellaUrl: "https://github.com/o/r/issues/1",
      actor: "manual:operator",
      sliceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      slicedAt: "2026-05-14T17:00:00Z",
      path,
    };
    writeSlice(1, [child], opts);
    writeSlice(1, [child], opts);
    expect(readAll({ path })).toHaveLength(1);
  });

  it("writeSliceUnlocked rejects invalid records before writing", () => {
    const path = makePath();
    expect(() =>
      writeSliceUnlocked(
        {
          slice_id: "bad",
          umbrella: 1,
          umbrella_url: "u",
          sliced_at: "x",
          actor: "a",
          children: [],
          expected_close_signal: "manual",
        },
        { path },
      ),
    ).toThrow(SliceRecordError);
    expect(readAll({ path })).toEqual([]);
  });

  it("readAll tolerates missing file, blanks, and malformed lines", () => {
    const path = makePath();
    expect(readAll({ path: join(path, "missing.jsonl") })).toEqual([]);
    const warnings: string[] = [];
    writeSliceUnlocked(
      {
        slice_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        umbrella: 1,
        umbrella_url: "u",
        sliced_at: "2026-05-14T17:00:00Z",
        actor: "a",
        children: [child],
        expected_close_signal: "all-children-merged",
      },
      { path },
    );
    const fdPath = path;
    const existing = readFileSync(fdPath, "utf8");
    const appended = `${existing}\n\n{bad}\n[1,2,3]\n   \n`;
    writeFileSync(fdPath, appended, "utf8");
    const records = readAll({ path, warn: (m) => warnings.push(m) });
    expect(records).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("find helpers return targeted records", () => {
    const path = makePath();
    writeSlice(10, [child], {
      umbrellaUrl: "u10",
      actor: "a",
      sliceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      slicedAt: "2026-05-14T17:00:00Z",
      path,
    });
    writeSlice(20, [child], {
      umbrellaUrl: "u20",
      actor: "a",
      sliceId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
      slicedAt: "2026-05-14T17:00:00Z",
      path,
    });
    expect(findBySliceId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", { path })?.umbrella).toBe(10);
    expect(findByUmbrella(20, { path })).toHaveLength(1);
    expect(findBySliceId("nope", { path })).toBeNull();
  });

  it("writeSliceUnlocked logs malformed id lines via warn hook", () => {
    const path = makePath();
    writeFileSync(path, "{bad json\n", "utf8");
    const warnings: string[] = [];
    writeSliceUnlocked(
      {
        slice_id: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
        umbrella: 3,
        umbrella_url: "u",
        sliced_at: "2026-05-14T17:00:00Z",
        actor: "a",
        children: [child],
        expected_close_signal: "all-children-merged",
      },
      { path, warn: (m) => warnings.push(m) },
    );
    expect(warnings.length).toBe(1);
  });

  it("withAppendLock serialises callbacks", () => {
    const path = makePath();
    const order: number[] = [];
    withAppendLock(path, () => order.push(1));
    withAppendLock(path, () => order.push(2));
    expect(order).toEqual([1, 2]);
  });
});
