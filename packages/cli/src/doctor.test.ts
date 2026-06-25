import { describe, expect, it, vi } from "vitest";

vi.mock("@deftai/directive-core/dist/doctor/main.js", () => ({
  cmdDoctor: vi.fn(() => 0),
}));

import { cmdDoctor } from "@deftai/directive-core/dist/doctor/main.js";
import { run } from "./doctor.js";

describe("doctor CLI", () => {
  it("delegates argv to cmdDoctor", () => {
    expect(run(["--full", "--json"])).toBe(0);
    expect(cmdDoctor).toHaveBeenCalledWith(["--full", "--json"]);
  });
});
