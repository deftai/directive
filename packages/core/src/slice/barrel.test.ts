import { describe, expect, it } from "vitest";
import * as slice from "./index.js";

describe("slice barrel", () => {
  it("re-exports core symbols", () => {
    expect(typeof slice.main).toBe("function");
    expect(typeof slice.readAll).toBe("function");
    expect(typeof slice.runRecordExisting).toBe("function");
    expect(slice.DEFAULT_ACTOR).toBe("manual:operator");
  });
});
