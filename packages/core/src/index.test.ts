import { describe, expect, it } from "vitest";
import { CORE_PACKAGE, engineInfo } from "./index.js";

describe("@deftai/core", () => {
  it("reports engine info backed by an @deftai/types shape", () => {
    expect(engineInfo()).toEqual({ name: CORE_PACKAGE, version: "0.0.0" });
  });
});
