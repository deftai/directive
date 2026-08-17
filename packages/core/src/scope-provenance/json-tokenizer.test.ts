import { describe, expect, it } from "vitest";
import { parseJsonRejectingDuplicateKeys } from "./json-tokenizer.js";

describe("parseJsonRejectingDuplicateKeys (#3385 F3 / E9)", () => {
  it("parses objects, arrays, and scalars", () => {
    const r = parseJsonRejectingDuplicateKeys('{"a":1,"b":[true,false,null],"c":{"d":"x\\n"}}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: 1, b: [true, false, null], c: { d: "x\n" } });
    }
  });

  it("rejects top-level duplicate keys", () => {
    const r = parseJsonRejectingDuplicateKeys('{"a":1,"a":2}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate key "a"/);
  });

  it("rejects duplicate keys in nested objects", () => {
    const r = parseJsonRejectingDuplicateKeys('{"outer":{"k":1,"k":2}}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate key "k"/);
  });

  it("does not false-positive on duplicate-looking JSON inside a string", () => {
    const r = parseJsonRejectingDuplicateKeys('{"note":"{\\"a\\":1,\\"a\\":2}"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ note: '{"a":1,"a":2}' });
    }
  });

  it("rejects trailing content and invalid tokens", () => {
    expect(parseJsonRejectingDuplicateKeys('{"a":1} extra').ok).toBe(false);
    expect(parseJsonRejectingDuplicateKeys("{").ok).toBe(false);
    expect(parseJsonRejectingDuplicateKeys("undefined").ok).toBe(false);
  });

  it("parses unicode escapes, fractions, and exponents", () => {
    const r = parseJsonRejectingDuplicateKeys('{"u":"\\u0041","n":-1.5e2}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ u: "A", n: -150 });
  });

  it("rejects invalid strings, numbers, and literals", () => {
    expect(parseJsonRejectingDuplicateKeys('{"a":"\\uZZZZ"}').ok).toBe(false);
    expect(parseJsonRejectingDuplicateKeys('{"a":"\\q"}').ok).toBe(false);
    expect(parseJsonRejectingDuplicateKeys('{"a":"unterminated').ok).toBe(false);
    expect(parseJsonRejectingDuplicateKeys('{"a":.}').ok).toBe(false);
    expect(parseJsonRejectingDuplicateKeys("[1,]").ok).toBe(false);
    expect(parseJsonRejectingDuplicateKeys("{,}").ok).toBe(false);
    expect(parseJsonRejectingDuplicateKeys("nul").ok).toBe(false);
  });
});
