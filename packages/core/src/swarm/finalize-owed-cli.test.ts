import { describe, expect, it } from "vitest";
import { parseFinalizeOwedArgv } from "./finalize-owed-cli.js";

describe("parseFinalizeOwedArgv (#4919)", () => {
  it("parses flags and rejects unknown args", () => {
    const ok = parseFinalizeOwedArgv([
      "--inventory-only",
      "--wait-through-land",
      "--repo",
      "deftai/directive",
      "--project-root=.",
      "--delivery-branch=master",
      "--dry-run",
      "--json",
    ]);
    expect(ok.error).toBeNull();
    expect(ok.inventoryOnly).toBe(true);
    expect(ok.waitThroughLand).toBe(true);
    expect(ok.repo).toBe("deftai/directive");
    expect(ok.projectRoot).toBe(".");
    expect(ok.deliveryBranch).toBe("master");
    expect(ok.dryRun).toBe(true);
    expect(ok.emitJson).toBe(true);
    expect(parseFinalizeOwedArgv(["--bogus"]).error).toMatch(/unrecognized/);
    expect(parseFinalizeOwedArgv(["--help"]).help).toBe(true);
  });
});
