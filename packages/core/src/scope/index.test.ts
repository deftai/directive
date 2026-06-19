import { describe, expect, it } from "vitest";
import * as scope from "./index.js";

describe("scope index barrel", () => {
  it("re-exports public surface", () => {
    expect(scope.runTransition).toBeTypeOf("function");
    expect(scope.demoteOne).toBeTypeOf("function");
    expect(scope.undoOne).toBeTypeOf("function");
    expect(scope.lifecycleMain).toBeTypeOf("function");
    expect(scope.append).toBeTypeOf("function");
    expect(scope.LIFECYCLE_FOLDERS.length).toBeGreaterThan(0);
  });
});
