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

  it("pythonJsonStringify preserves colons and commas inside string values", () => {
    expect(pythonJsonStringify({ title: "fix: bug", body: "foo, bar" })).toBe(
      '{"title": "fix: bug", "body": "foo, bar"}',
    );
  });

  it("pythonJsonStringify preserves URLs containing colons", () => {
    expect(pythonJsonStringify({ url: "https://example.com:443/a,b" })).toBe(
      '{"url": "https://example.com:443/a,b"}',
    );
  });

  it("pythonJsonStringify preserves escaped quotes inside strings", () => {
    expect(pythonJsonStringify({ q: 'a "b: c, d" e' })).toBe('{"q": "a \\"b: c, d\\" e"}');
  });
});
