import { describe, expect, it } from "vitest";
import * as lifecycle from "./index.js";

describe("lifecycle index exports", () => {
  it("re-exports lifecycle modules", () => {
    expect(typeof lifecycle.lifecycleHygiene.detectLifecycleNudges).toBe("function");
    expect(typeof lifecycle.eventDetect.emit).toBe("function");
    expect(typeof lifecycle.events.emit).toBe("function");
  });
});
