import * as initDeposit from "@deftai/directive-core/init-deposit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeAndDispatch } from "../cli-router/index.js";
import type { DispatchIo } from "../dispatch.js";
import { argvWantsHelp, printInitHelp, printMigrateHelp, printUpdateHelp } from "./help.js";
import { runInit } from "./init.js";
import { runMigrate } from "./migrate.js";
import { runUpdate } from "./update.js";

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

describe("argvWantsHelp (#2828)", () => {
  it("detects --help and -h", () => {
    expect(argvWantsHelp(["--help"])).toBe(true);
    expect(argvWantsHelp(["-h"])).toBe(true);
    expect(argvWantsHelp(["--repo-root", ".", "--help"])).toBe(true);
  });

  it("is false for normal argv", () => {
    expect(argvWantsHelp([])).toBe(false);
    expect(argvWantsHelp(["--repo-root", "."])).toBe(false);
    expect(argvWantsHelp(["--dry-run"])).toBe(false);
  });
});

describe("init-cli --help is non-mutating (#2828)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("update --help prints usage and does not call runRefreshDepositCli", async () => {
    const refresh = vi.spyOn(initDeposit, "runRefreshDepositCli");
    const { io, out } = captureIo();

    const code = await runUpdate(["--help"], io);

    expect(code).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(out.join("")).toContain("Usage: directive update");
    expect(out.join("")).toContain("--dry-run, --plan");
  });

  it("update -h prints usage and does not call runRefreshDepositCli", async () => {
    const refresh = vi.spyOn(initDeposit, "runRefreshDepositCli");
    const { io } = captureIo();

    expect(await runUpdate(["-h"], io)).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("init --help prints usage and does not dispatch", async () => {
    const dispatch = vi.spyOn(initDeposit, "runInitDispatchCli");
    const headless = vi.spyOn(initDeposit, "runInitHeadlessCli");
    const { io, out } = captureIo();

    const code = await runInit(["--help"], io);

    expect(code).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(headless).not.toHaveBeenCalled();
    expect(out.join("")).toContain("Usage: directive init");
    expect(out.join("")).toContain("--headless");
  });

  it("init --help wins over --headless (no manifest emit)", async () => {
    const headless = vi.spyOn(initDeposit, "runInitHeadlessCli");
    const { io } = captureIo();

    expect(await runInit(["--headless", "--help"], io)).toBe(0);
    expect(headless).not.toHaveBeenCalled();
  });

  it("migrate --help prints usage and does not call runMigrateCli", () => {
    const migrate = vi.spyOn(initDeposit, "runMigrateCli");
    const untrack = vi.spyOn(initDeposit, "runUntrackCoreCli");
    const { io, out } = captureIo();

    const code = runMigrate(["--help"], io);

    expect(code).toBe(0);
    expect(migrate).not.toHaveBeenCalled();
    expect(untrack).not.toHaveBeenCalled();
    expect(out.join("")).toContain("Usage: directive migrate");
    expect(out.join("")).toContain("--untrack-core");
  });

  it("routeAndDispatch update --help exits 0 without refresh", async () => {
    const refresh = vi.spyOn(initDeposit, "runRefreshDepositCli");
    const { io, out } = captureIo();

    const code = await routeAndDispatch(["update", "--help"], io);

    expect(code).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(out.join("")).toContain("directive update");
  });
});

describe("init-cli help printers", () => {
  it("printUpdateHelp mentions deft alias", () => {
    const { io, out } = captureIo();
    printUpdateHelp(io);
    expect(out.join("")).toContain("deft update");
  });

  it("printInitHelp mentions headless mode", () => {
    const { io, out } = captureIo();
    printInitHelp(io);
    expect(out.join("")).toContain("--headless");
  });

  it("printMigrateHelp mentions untrack-core", () => {
    const { io, out } = captureIo();
    printMigrateHelp(io);
    expect(out.join("")).toContain("--untrack-core");
  });
});
