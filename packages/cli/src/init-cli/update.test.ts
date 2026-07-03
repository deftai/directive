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
});
