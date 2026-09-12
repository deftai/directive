import * as initDeposit from "@deftai/directive-core/init-deposit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchIo } from "../dispatch.js";
import { UPDATE_DRY_RUN_FLAGS } from "./constants.js";
import { isUpdateDryRun, runUpdate } from "./update.js";

function captureIo(): { io: DispatchIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: (text) => {
        err.push(text);
      },
    },
  };
}

describe("isUpdateDryRun (#2266)", () => {
  it("detects --dry-run", () => {
    expect(isUpdateDryRun(["--dry-run"])).toBe(true);
  });

  it("detects --plan", () => {
    expect(isUpdateDryRun(["--repo-root", ".", "--plan"])).toBe(true);
  });

  it("is false for a plain update", () => {
    expect(isUpdateDryRun(["--repo-root", "."])).toBe(false);
    expect(isUpdateDryRun([])).toBe(false);
  });

  it("UPDATE_DRY_RUN_FLAGS lists both flags", () => {
    expect([...UPDATE_DRY_RUN_FLAGS]).toEqual(["--dry-run", "--plan"]);
  });
});

describe("runUpdate threads the dry-run flag (#2266)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes dryRun: true when --plan is supplied", async () => {
    const spy = vi.spyOn(initDeposit, "runRefreshDepositCli").mockResolvedValue(0);
    const { io } = captureIo();

    await runUpdate(["--plan"], io);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, upgrade: true, jsonOut: true }),
    );
  });

  it("passes dryRun: false for a normal update", async () => {
    const spy = vi.spyOn(initDeposit, "runRefreshDepositCli").mockResolvedValue(0);
    const { io } = captureIo();

    await runUpdate([], io);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
  });

  it("threads --allow-dirty-no-stage", async () => {
    const spy = vi.spyOn(initDeposit, "runRefreshDepositCli").mockResolvedValue(0);
    const { io } = captureIo();

    await runUpdate(["--allow-dirty-no-stage"], io);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ allowDirtyNoStage: true }));
  });

  it("detects slash dry-run aliases", () => {
    expect(isUpdateDryRun(["/plan"])).toBe(true);
    expect(isUpdateDryRun(["/dry-run"])).toBe(true);
  });

  it("unknown flags and --allow-dirty/--force fail parse with exit 2", async () => {
    const spy = vi.spyOn(initDeposit, "runRefreshDepositCli");
    const mystery = captureIo();
    expect(await runUpdate(["--mystery"], mystery.io)).toBe(2);
    expect(mystery.err.join("")).toMatch(/unknown flag: --mystery/);
    const dirty = captureIo();
    expect(await runUpdate(["--allow-dirty"], dirty.io)).toBe(2);
    expect(dirty.err.join("")).toMatch(/not the dirty-update escape/);
    const force = captureIo();
    expect(await runUpdate(["--force"], force.io)).toBe(2);
    expect(force.err.join("")).toMatch(/not the dirty-update escape/);
    expect(spy).not.toHaveBeenCalled();
  });
});
