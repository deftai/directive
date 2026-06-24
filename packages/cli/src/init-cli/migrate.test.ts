import * as initDeposit from "@deftai/directive-core/init-deposit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { routeAndDispatch } from "../cli-router/index.js";
import type { DispatchIo } from "../dispatch.js";
import { CANONICAL_MIGRATE_ARGV } from "./constants.js";
import { runMigrate } from "./migrate.js";

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CANONICAL_MIGRATE_ARGV", () => {
  it("defaults to the current repo root without forcing --json or --yes", () => {
    expect(CANONICAL_MIGRATE_ARGV).toEqual(["--repo-root", "."]);
  });
});

describe("runMigrate handler", () => {
  it("parses argv and delegates to the core runMigrateCli orchestrator", () => {
    const spy = vi.spyOn(initDeposit, "runMigrateCli").mockReturnValue(0);
    const { io } = captureIo();

    const code = runMigrate(["--repo-root", "/tmp/custom-deposit"], io);

    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]?.[0];
    expect(call?.projectDir).toBe("/tmp/custom-deposit");
    expect(call?.jsonOut).toBe(false);
  });

  it("propagates --json into the core orchestrator options", () => {
    const spy = vi.spyOn(initDeposit, "runMigrateCli").mockReturnValue(0);
    const { io } = captureIo();

    runMigrate(["--json"], io);

    expect(spy.mock.calls[0]?.[0]?.jsonOut).toBe(true);
  });

  it("propagates the orchestrator exit code (needs-action -> 1)", () => {
    vi.spyOn(initDeposit, "runMigrateCli").mockReturnValue(1);
    const { io } = captureIo();
    expect(runMigrate([], io)).toBe(1);
  });

  it("acknowledges --yes as a no-op rather than silently swallowing it", () => {
    vi.spyOn(initDeposit, "runMigrateCli").mockReturnValue(0);
    const { io, err } = captureIo();

    runMigrate(["--yes"], io);

    expect(err.join("")).toContain("--yes/--non-interactive has no effect");
  });

  it("emits no no-op note when neither confirmation flag is passed", () => {
    vi.spyOn(initDeposit, "runMigrateCli").mockReturnValue(0);
    const { io, err } = captureIo();

    runMigrate(["--repo-root", "."], io);

    expect(err.join("")).toBe("");
  });
});

describe("migrate routing parity (directive / deft)", () => {
  it("routes `migrate` through the dedicated runMigrate handler", async () => {
    const spy = vi.spyOn(initDeposit, "runMigrateCli").mockReturnValue(0);
    const { io } = captureIo();

    const code = await routeAndDispatch(["migrate", "--json"], io);

    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
    // `deft migrate` and `directive migrate` resolve through the identical path.
    expect(spy.mock.calls[0]?.[0]?.jsonOut).toBe(true);
  });
});
