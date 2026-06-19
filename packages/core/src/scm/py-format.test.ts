import { describe, expect, it } from "vitest";
import { pyRepr, pyTuple, pythonJsonStringify } from "./py-format.js";

describe("py-format", () => {
  it("pyRepr formats strings with single quotes", () => {
    expect(pyRepr("abc")).toBe("'abc'");
  });

  it("pyRepr formats arrays", () => {
    expect(pyRepr(["--state"])).toBe("['--state']");
  });

  it("pyTuple adds trailing comma for single element", () => {
    expect(pyTuple(["issue"])).toBe("('issue',)");
  });

  it("pythonJsonStringify matches Python spacing", () => {
    expect(pythonJsonStringify({ number: 1, title: "x" })).toBe('{"number": 1, "title": "x"}');
  });
});
