import { describe, expect, it } from "vitest";
import * as prWatch from "./index.js";

describe("pr-watch barrel exports", () => {
  it("re-exports the public runtime API", () => {
    expect(typeof prWatch.watch).toBe("function");
    expect(typeof prWatch.probeOnce).toBe("function");
    expect(typeof prWatch.cmdPrWatch).toBe("function");
    expect(typeof prWatch.runWatch).toBe("function");
    expect(typeof prWatch.parseWatchArgs).toBe("function");
    expect(typeof prWatch.watchResultToJson).toBe("function");
    expect(typeof prWatch.formatWatchStatus).toBe("function");
  });

  it("re-exports the exit-contract constants", () => {
    expect(prWatch.EXIT_CLEAN).toBe(0);
    expect(prWatch.EXIT_NEW_P0_P1).toBe(1);
    expect(prWatch.EXIT_TERMINAL_ERROR).toBe(2);
    expect(prWatch.VERDICT_CLEAN).toBe("CLEAN");
  });
});
