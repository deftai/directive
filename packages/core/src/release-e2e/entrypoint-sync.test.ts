import { describe, expect, it } from "vitest";
import { ENTRYPOINT_TIMEOUT_EXIT_CODE } from "./constants.js";
import { runEntrypointWorkerSync } from "./entrypoint.js";

/**
 * Regression coverage for #1864: the synchronous worker-backed runner used to
 * deadlock because it blocked the main event loop with `Atomics.wait` while
 * waiting on a Promise whose resolution depended on that same blocked event
 * loop. The fix wakes the waiter via a cross-thread `Atomics.notify` from the
 * worker, so these run synchronously without hanging.
 */
describe("runEntrypointWorkerSync (#1864 deadlock fix)", () => {
  it("wakes synchronously and returns the worker result (no deadlock)", () => {
    const start = Date.now();
    const result = runEntrypointWorkerSync("test", [], process.cwd(), 30_000, "ok");
    const elapsedMs = Date.now() - start;

    expect(result.code).toBe(0);
    // The pre-fix bug blocked forever; a clean cross-thread wake returns fast.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 60_000);

  it("honors the timeout instead of hanging when the worker does not settle", () => {
    // testBehavior "hang" sleeps ~5s in the worker before notifying; a 200ms
    // wait must time out (the pre-fix timeout could never fire on a blocked
    // event loop, which is exactly what hung the release rehearsal).
    const start = Date.now();
    const result = runEntrypointWorkerSync("test", [], process.cwd(), 200, "hang");
    const elapsedMs = Date.now() - start;

    expect(result.code).toBe(ENTRYPOINT_TIMEOUT_EXIT_CODE);
    expect(result.stderr).toContain("timed out");
    expect(elapsedMs).toBeLessThan(10_000);
  }, 60_000);

  it("surfaces a worker-thrown error as a non-zero exit (no deadlock)", () => {
    const result = runEntrypointWorkerSync("test", [], process.cwd(), 30_000, "throw");
    expect(result.code).not.toBe(0);
  }, 60_000);
});
