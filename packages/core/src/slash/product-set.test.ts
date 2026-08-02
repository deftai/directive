import { describe, expect, it } from "vitest";
import {
  getProductCommand,
  listProductCommands,
  logicalIdToFilename,
  logicalIdToFilenameStem,
  PRODUCT_COMMAND_COUNT,
  PRODUCT_COMMANDS,
} from "./product-set.js";

/** L2 locked list from epic #55 LockedDecisions (pass-3 handoff). */
const LOCKED_LOGICAL_IDS = [
  "/deft:directive:change",
  "/deft:directive:change:apply",
  "/deft:directive:change:verify",
  "/deft:directive:change:archive",
  "/deft:directive:run:interview",
  "/deft:directive:run:yolo",
  "/deft:directive:run:map",
  "/deft:directive:run:discuss",
  "/deft:directive:run:research",
  "/deft:directive:run:speckit",
  "/deft:directive:run:probe",
  "/deft:continue",
  "/deft:checkpoint",
] as const;

describe("slash product-set (#3052 / #55 L2)", () => {
  it("freezes exactly 13 canonical product commands", () => {
    expect(PRODUCT_COMMAND_COUNT).toBe(13);
    expect(PRODUCT_COMMANDS).toHaveLength(13);
    expect(listProductCommands()).toHaveLength(PRODUCT_COMMAND_COUNT);
  });

  it("matches LockedDecisions L2 logical ids in stable order", () => {
    expect(PRODUCT_COMMANDS.map((c) => c.logicalId)).toEqual([...LOCKED_LOGICAL_IDS]);
  });

  it("maps logical ids to hyphen filename stems (L4 examples)", () => {
    expect(logicalIdToFilenameStem("/deft:directive:run:interview")).toBe(
      "deft-directive-run-interview",
    );
    expect(logicalIdToFilenameStem("/deft:directive:change:apply")).toBe(
      "deft-directive-change-apply",
    );
    expect(logicalIdToFilenameStem("/deft:continue")).toBe("deft-continue");
    expect(logicalIdToFilename("/deft:checkpoint")).toBe("deft-checkpoint.md");
  });

  it("keeps filenameStem aligned with the L4 transform for every entry", () => {
    for (const cmd of PRODUCT_COMMANDS) {
      expect(cmd.filenameStem).toBe(logicalIdToFilenameStem(cmd.logicalId));
    }
  });

  it("does not include legacy deprecation-alias logical ids (L3)", () => {
    const ids = new Set(PRODUCT_COMMANDS.map((c) => c.logicalId));
    expect(ids.has("/deft:change")).toBe(false);
    expect(ids.has("/deft:run:interview")).toBe(false);
    expect(ids.has("/deft:run:probe")).toBe(false);
  });

  it("assigns one primary dispatch path per command", () => {
    for (const cmd of PRODUCT_COMMANDS) {
      expect(cmd.dispatchPath.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
    expect(getProductCommand("/deft:directive:run:probe")?.dispatchPath).toBe(
      "skills/deft-directive-probe/SKILL.md",
    );
    expect(getProductCommand("/deft:directive:run:interview")?.dispatchKind).toBe("strategy");
    expect(getProductCommand("/missing")).toBeUndefined();
  });

  it("rejects logical ids without a leading slash", () => {
    expect(() => logicalIdToFilenameStem("deft:continue")).toThrow(/must start with/);
  });
});
