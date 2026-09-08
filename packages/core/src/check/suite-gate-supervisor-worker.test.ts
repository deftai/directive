import { describe, expect, it } from "vitest";
import { isMainThread } from "node:worker_threads";
import { isSuiteGateSupervisorWorker } from "./suite-gate-supervisor-worker.js";

describe("suite-gate-supervisor-worker", () => {
  it("does not start the child when imported on the main thread", () => {
    expect(isMainThread).toBe(true);
    expect(isSuiteGateSupervisorWorker()).toBe(false);
  });
});
