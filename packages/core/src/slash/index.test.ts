import { describe, expect, it } from "vitest";
import * as slash from "./index.js";

describe("slash public surface (#3052)", () => {
  it("re-exports product table and generator APIs for emitters", () => {
    expect(slash.PRODUCT_COMMAND_COUNT).toBe(13);
    expect(slash.listProductCommands()).toHaveLength(13);
    expect(slash.generateThinWrappers()).toHaveLength(13);
    expect(slash.measureTokenBudget().ok).toBe(true);
    expect(slash.logicalIdToFilenameStem("/deft:continue")).toBe("deft-continue");
    expect(typeof slash.renderThinWrapperFile).toBe("function");
    expect(typeof slash.isThinWrapperMarkdown).toBe("function");
  });
});
