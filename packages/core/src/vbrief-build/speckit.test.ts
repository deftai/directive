import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonJsonPretty } from "./json.js";
import {
  createSpeckitScopeVbrief,
  dependenciesForItem,
  edgeNodes,
  migrateSpeckitPlan,
  speckitIpIndex,
  speckitIpSlug,
} from "./speckit.js";

describe("speckit helpers", () => {
  it("reads bilingual edges and dependency lists", () => {
    expect(edgeNodes({ from: "a", to: "b" })).toEqual(["a", "b"]);
    expect(edgeNodes({ source: "x", target: "y" })).toEqual(["x", "y"]);
    expect(dependenciesForItem("ip-2", [{ type: "blocks", from: "ip-1", to: "ip-2" }])).toEqual([
      "ip-1",
    ]);
  });

  it("derives slug and index", () => {
    expect(speckitIpSlug("IP-1: Widget phase", "ip-1")).toBe("widget-phase");
    expect(speckitIpIndex({ id: "phase-ip-3", title: "IP 3: Build" }, 9)).toBe(3);
    expect(speckitIpIndex({ id: "", title: "IP 7: Build" }, 9)).toBe(7);
  });

  it("handles long all-digit ids and trailing whitespace/newlines", () => {
    expect(speckitIpIndex({ id: "12345678901234" }, 1)).toBe(12345678901234);
    expect(speckitIpIndex({ id: "ip-7   " }, 1)).toBe(7);
    expect(speckitIpIndex({ id: "ip-8\n" }, 1)).toBe(8);
    expect(speckitIpIndex({ id: "phase-x", title: "no ip" }, 5)).toBe(5);
  });
});

describe("createSpeckitScopeVbrief", () => {
  it("builds narratives and internal plan reference", () => {
    const scope = createSpeckitScopeVbrief(
      {
        title: "IP-1: Foundation",
        narrative: {
          Description: "Build the foundation.",
          Acceptance: "Tests pass.",
          Traces: "REQ-1",
        },
      },
      { ipIndex: 1, dependencies: ["ip-0"], specRef: "../specification.vbrief.json" },
    );
    const refs = (scope.plan as Record<string, unknown>).references as Record<string, unknown>[];
    expect(refs[0]?.TrustLevel).toBe("internal");
    expect((scope.plan as Record<string, unknown>).metadata).toEqual({
      kind: "phase",
      dependencies: ["ip-0"],
    });
  });
});

describe("migrateSpeckitPlan", () => {
  it("creates pending scope and rewrites plan scaffold", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-speckit-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    const planPath = join(vbrief, "plan.vbrief.json");
    writeFileSync(
      planPath,
      pythonJsonPretty({
        vBRIEFInfo: { version: "0.5", description: "Speckit plan" },
        plan: {
          title: "Session",
          items: [
            { id: "ip-1", title: "IP-1: Foundation", narrative: { Description: "Build it." } },
          ],
          edges: [],
        },
      }),
      "utf8",
    );
    const [ok, actions] = migrateSpeckitPlan(planPath, {
      pendingDir: join(vbrief, "pending"),
      today: "2026-04-23",
    });
    expect(ok).toBe(true);
    expect(actions.some((a) => a.startsWith("CREATE pending/"))).toBe(true);
    const pending = JSON.parse(
      readFileSync(join(vbrief, "pending", "2026-04-23-ip001-foundation.vbrief.json"), "utf8"),
    );
    expect(pending.plan.title).toBe("IP-1: Foundation");
    rmSync(root, { recursive: true, force: true });
  });
});
