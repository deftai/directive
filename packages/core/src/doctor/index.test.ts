import { describe, expect, it } from "vitest";
import * as doctor from "./index.js";

describe("doctor barrel", () => {
  it("re-exports cmdDoctor", () => {
    expect(typeof doctor.cmdDoctor).toBe("function");
    expect(typeof doctor.runChecks).toBe("function");
    expect(doctor.CANONICAL_UPGRADE_COMMAND).toBe("npm i -g @deftai/directive@latest");
  });
});
