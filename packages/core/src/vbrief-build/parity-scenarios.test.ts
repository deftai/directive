import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOLDER_TO_STATUSES, STATUS_TO_FOLDER } from "./constants.js";
import { PARITY_SCENARIO_NAMES, runParityScenario } from "./parity-scenarios.js";
import { folderForStatus, planStatusMatchesFolder } from "./routing.js";

describe("parity scenarios", () => {
  it("runs every named scenario successfully", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "vb-all-scenarios-"));
    for (const name of PARITY_SCENARIO_NAMES) {
      const result = runParityScenario(name, { fixtureRoot });
      expect(result.ok, name).toBe(true);
    }
  });

  it("exercises lifecycle tables", () => {
    for (const [status, folder] of Object.entries(STATUS_TO_FOLDER)) {
      expect(folderForStatus(status)).toBe(folder);
      expect(planStatusMatchesFolder(status, folder)).toBe(true);
    }
    for (const folder of Object.keys(FOLDER_TO_STATUSES)) {
      expect(planStatusMatchesFolder("bogus-status", folder)).toBe(false);
    }
  });
});
