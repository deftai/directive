import { describe, expect, it } from "vitest";
import { CORE_PACKAGE, engineInfo } from "./index.js";

describe("@deftai/directive-core", () => {
  it("reports engine info backed by an @deftai/directive-types shape", () => {
    expect(engineInfo()).toEqual({ name: CORE_PACKAGE, version: "0.0.0" });
  });
});
