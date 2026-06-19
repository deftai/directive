import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATUS_FOR_FOLDER,
  EMITTED_VBRIEF_VERSION,
  FOLDER_TO_STATUSES,
  STATUS_TO_FOLDER,
} from "./constants.js";
import { defaultStatusForFolder, folderForStatus } from "./routing.js";

describe("constants coverage", () => {
  it("exports lifecycle tables", () => {
    expect(EMITTED_VBRIEF_VERSION).toBe("0.6");
    expect(FOLDER_TO_STATUSES.active).toContain("running");
    expect(STATUS_TO_FOLDER.running).toBe("active");
    expect(DEFAULT_STATUS_FOR_FOLDER.active).toBe("running");
    expect(folderForStatus("draft")).toBe("proposed");
    expect(defaultStatusForFolder("pending")).toBe("pending");
    expect(() => defaultStatusForFolder("archive")).toThrow(/Unknown lifecycle folder/);
  });
});
