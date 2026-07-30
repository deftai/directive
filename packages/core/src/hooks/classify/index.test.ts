import { describe, expect, it } from "vitest";
import { classifyHookPayload, parseHookStdin } from "./index.js";

describe("classify barrel (#2950)", () => {
  it("re-exports pure entrypoints", () => {
    expect(typeof classifyHookPayload).toBe("function");
    expect(typeof parseHookStdin).toBe("function");
    expect(
      classifyHookPayload({ host: "cursor", payload: { tool_name: "Read" } }).writeIntent,
    ).toBe("other");
  });
});
