import { describe, expect, it, vi } from "vitest";
import {
  FINALIZE_OWED_COMMAND,
  FINALIZE_OWED_USAGE,
  finalizeOwedMain,
  parseFinalizeOwedArgv,
} from "./finalize-owed-cli.js";

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

describe("FINALIZE_OWED_USAGE command name (#6409 / #5914 part 1)", () => {
  it("names the runnable deft form, not the missing Taskfile task", () => {
    expect(FINALIZE_OWED_COMMAND).toBe("deft swarm:finalize-owed");
    expect(FINALIZE_OWED_USAGE.startsWith(`Usage: ${FINALIZE_OWED_COMMAND} [options]`)).toBe(true);
    expect(FINALIZE_OWED_USAGE).not.toContain("task swarm:finalize-owed");
  });

  it("--help prints usage and exits 0", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(finalizeOwedMain(["--help"])).toBe(0);
      expect(spy).toHaveBeenCalledWith(FINALIZE_OWED_USAGE);
    } finally {
      spy.mockRestore();
    }
  });
});
