import { engineInfo } from "@deftai/directive-core";
import { describe, expect, it } from "vitest";
import { banner, CLI_PACKAGE } from "./index.js";

describe("@deftai/directive", () => {
  it("renders a banner spanning the full cli → core → types chain", () => {
    const { version } = engineInfo();
    expect(banner()).toBe(`${CLI_PACKAGE} (engine: @deftai/directive-core@${version})`);
  });
});
