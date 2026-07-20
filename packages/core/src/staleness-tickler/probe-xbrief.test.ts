import { describe, expect, it } from "vitest";
import { classifyXbriefSchemaDistance } from "./probe-xbrief.js";

describe("classifyXbriefSchemaDistance", () => {
  it("marks current when declared matches target", () => {
    expect(classifyXbriefSchemaDistance("0.8", "0.8")).toBe("current");
  });

  it("marks behind-minor within the same major", () => {
    expect(classifyXbriefSchemaDistance("0.7", "0.8")).toBe("behind-minor");
  });

  it("marks behind-major for legacy schema", () => {
    expect(classifyXbriefSchemaDistance("0.6", "0.8")).toBe("behind-major");
  });
});
