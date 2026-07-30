import { describe, expect, it } from "vitest";
import * as escalation from "./index.js";

describe("escalation package exports (#518)", () => {
  it("re-exports schema and store helpers", () => {
    expect(typeof escalation.fileEscalation).toBe("function");
    expect(typeof escalation.parseEscalation).toBe("function");
    expect(typeof escalation.batchApproveEscalations).toBe("function");
    expect(escalation.ESCALATION_TYPES).toContain("cmd_approval");
    expect(escalation.ESCALATION_DIR).toBe(".deft/escalations");
  });
});
