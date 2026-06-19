import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "./types.js";

vi.mock("./build.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./build.js")>();
  return {
    ...actual,
    createScopeVbrief: (...args: Parameters<typeof actual.createScopeVbrief>) => {
      const scope = actual.createScopeVbrief(...args);
      const plan = scope.plan as JsonObject;
      plan.metadata = {
        legacyKey: "preserved",
        "x-migrator": {},
      };
      delete plan.narratives;
      if (args[2] === "completed") {
        scope.vBRIEFInfo = [];
      }
      return scope;
    },
  };
});

import { buildScopeVbriefFromReconciled } from "./routing.js";

describe("buildScopeVbriefFromReconciled metadata cleanup", () => {
  it("retains non-migrator metadata when migrator block is empty", () => {
    const scope = buildScopeVbriefFromReconciled({ title: "T", folder: "pending" });
    const meta = (scope.plan as JsonObject).metadata as JsonObject;
    expect(meta.legacyKey).toBe("preserved");
    expect(meta["x-migrator"]).toBeUndefined();
  });

  it("creates narratives map when absent on scope plan", () => {
    const scope = buildScopeVbriefFromReconciled({
      title: "T",
      folder: "pending",
      source_section: "From roadmap",
    });
    expect((scope.plan as JsonObject).narratives).toEqual({ SourceSection: "From roadmap" });
  });

  it("skips updated stamp when vBRIEFInfo envelope is not a plain object", () => {
    const scope = buildScopeVbriefFromReconciled({
      title: "Done",
      status: "completed",
      folder: "completed",
    });
    expect(scope.vBRIEFInfo).toEqual([]);
  });
});
