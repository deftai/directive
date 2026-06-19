import { describe, expect, it } from "vitest";
import { SliceRecordError } from "./errors.js";
import { validateRecord } from "./validate.js";

const validRecord = {
  slice_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  umbrella: 1,
  umbrella_url: "https://github.com/o/r/issues/1",
  sliced_at: "2026-05-14T17:00:00Z",
  actor: "manual:operator",
  children: [{ n: 2, url: "https://github.com/o/r/issues/2", wave: 1, role: "manual" }],
  expected_close_signal: "all-children-merged",
};

describe("validateRecord", () => {
  it("accepts a minimal valid record", () => {
    expect(() => validateRecord(validRecord)).not.toThrow();
  });

  it("rejects non-object records", () => {
    expect(() => validateRecord(null)).toThrow(SliceRecordError);
    expect(() => validateRecord([])).toThrow(/must be a dict/);
  });

  it("rejects missing and extra fields", () => {
    const { slice_id: _removed, ...missing } = validRecord;
    expect(() => validateRecord(missing)).toThrow(/missing required field/);
    expect(() => validateRecord({ ...validRecord, extra: true })).toThrow(/unknown field/);
  });

  it("rejects invalid slice_id, umbrella, sliced_at, and signal", () => {
    expect(() => validateRecord({ ...validRecord, slice_id: "bad" })).toThrow(/slice_id/);
    expect(() => validateRecord({ ...validRecord, umbrella: 0 })).toThrow(/umbrella/);
    expect(() => validateRecord({ ...validRecord, sliced_at: "2026-05-14" })).toThrow(/sliced_at/);
    expect(() => validateRecord({ ...validRecord, expected_close_signal: "nope" })).toThrow(
      /expected_close_signal/,
    );
  });

  it("validates child shape and notes type", () => {
    expect(() =>
      validateRecord({ ...validRecord, children: [{ url: "u", wave: 1, role: "r" }] }),
    ).toThrow(/missing required field/);
    expect(() =>
      validateRecord({ ...validRecord, children: [{ n: 0, url: "u", wave: 1, role: "r" }] }),
    ).toThrow(/children\[0\]\.n/);
    expect(() =>
      validateRecord({ ...validRecord, children: [{ n: 2, url: "", wave: 1, role: "r" }] }),
    ).toThrow(/url/);
    expect(() => validateRecord({ ...validRecord, notes: 1 })).toThrow(/notes must be a string/);
  });
});
