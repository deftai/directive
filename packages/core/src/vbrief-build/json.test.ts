import { describe, expect, it } from "vitest";
import { pythonJsonPretty } from "./json.js";

describe("pythonJsonPretty", () => {
  it("appends trailing newline to pretty JSON", () => {
    expect(pythonJsonPretty({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
