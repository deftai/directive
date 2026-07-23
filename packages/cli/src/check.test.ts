import { describe, expect, it, vi } from "vitest";

vi.mock("@deftai/directive-core/check", () => ({
  dispatchTaskCheck: vi.fn(() => 0),
}));

import { parseArgs } from "./check.js";

describe("check CLI", () => {
  it("parses --no-cache", () => {
    expect(parseArgs(["--framework-root", "/fw", "--project-root", "/proj", "--no-cache"])).toEqual(
      {
        frameworkRoot: "/fw",
        projectRoot: "/proj",
        noCache: true,
      },
    );
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--wat"]).error).toMatch(/unrecognized argument/);
  });
});
