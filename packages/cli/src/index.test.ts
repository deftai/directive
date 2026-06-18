import { describe, expect, it } from "vitest";
import { banner, CLI_PACKAGE } from "./index.js";

describe("@deftai/cli", () => {
  it("renders a banner spanning the full cli → core → types chain", () => {
    expect(banner()).toBe(`${CLI_PACKAGE} (engine: @deftai/core@0.0.0)`);
  });
});
