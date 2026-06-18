import { describe, expect, it } from "vitest";
import { TYPES_PACKAGE } from "./index.js";

describe("@deftai/types", () => {
  it("exports its package identity", () => {
    expect(TYPES_PACKAGE).toBe("@deftai/types");
  });
});
