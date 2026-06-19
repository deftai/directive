import { describe, expect, it } from "vitest";
import { pythonJsonPretty, pythonJsonStringify, sortKeysDeep } from "./json.js";

describe("json helpers", () => {
  it("sortKeysDeep sorts nested objects", () => {
    expect(sortKeysDeep({ b: 1, a: { d: 2, c: 3 } })).toEqual({ a: { c: 3, d: 2 }, b: 1 });
  });

  it("pythonJsonStringify matches Python separators and key order", () => {
    const value = {
      slice_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      umbrella: 1,
      children: [{ n: 2, role: "manual", url: "u", wave: 1 }],
    };
    expect(pythonJsonStringify(value)).toBe(
      '{"children": [{"n": 2, "role": "manual", "url": "u", "wave": 1}], "slice_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "umbrella": 1}',
    );
  });

  it("pythonJsonPretty emits indented sorted JSON", () => {
    const pretty = pythonJsonPretty({ b: 1, a: 2 });
    expect(pretty).toBe('{\n  "a": 2,\n  "b": 1\n}');
  });
});
