import { describe, expect, it } from "vitest";
import * as reconcile from "../reconcile/index.js";
import * as refresh from "../refresh/index.js";
import * as scopeDrift from "../scope-drift/index.js";
import * as welcome from "./index.js";

describe("triage module barrels", () => {
  it("exports welcome symbols", () => {
    expect(typeof welcome.runDefaultMode).toBe("function");
    expect(typeof welcome.detectPriorState).toBe("function");
  });

  it("exports refresh symbols", () => {
    expect(typeof refresh.refreshActive).toBe("function");
    expect(typeof refresh.isDrift).toBe("function");
  });

  it("exports reconcile symbols", () => {
    expect(typeof reconcile.reconcile).toBe("function");
    expect(typeof reconcile.findReconcilable).toBe("function");
  });

  it("exports scope-drift symbols", () => {
    expect(typeof scopeDrift.computeDrift).toBe("function");
    expect(typeof scopeDrift.addIgnore).toBe("function");
  });
});
