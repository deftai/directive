import { describe, expect, it } from "vitest";
import { withAppendLock } from "./lock.js";

describe("withAppendLock", () => {
  it("rejects reentrant acquisition", () => {
    expect(() =>
      withAppendLock("/tmp/deft-slice-lock-test.jsonl", () => {
        withAppendLock("/tmp/deft-slice-lock-test.jsonl", () => undefined);
      }),
    ).toThrow(/not reentrant/);
  });

  it("times out when lock cannot be acquired", () => {
    let now = 0;
    expect(() =>
      withAppendLock(
        "/tmp/deft-slice-lock-timeout.jsonl",
        () => {
          withAppendLock("/tmp/deft-slice-lock-timeout.jsonl", () => undefined, {
            now: () => now,
            sleepMs: () => {
              now += 1000;
            },
          });
        },
        {
          now: () => now,
          sleepMs: () => {
            now += 1000;
          },
        },
      ),
    ).toThrow();
  });

  it("lets a different lock nest and frees the path after an error (#6422)", () => {
    const seen = withAppendLock("/tmp/deft-slice-lock-outer-6422.jsonl", () =>
      withAppendLock("/tmp/deft-slice-lock-inner-6422.jsonl", () => "nested"),
    );
    expect(seen).toBe("nested");
    expect(() =>
      withAppendLock("/tmp/deft-slice-lock-outer-6422.jsonl", () => {
        throw new Error("body failed");
      }),
    ).toThrow("body failed");
    expect(withAppendLock("/tmp/deft-slice-lock-outer-6422.jsonl", () => "again")).toBe("again");
  });
});
