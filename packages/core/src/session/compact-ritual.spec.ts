/**
 * Forward-coverage companion for new compact-ritual.ts (#3171 / #1310).
 * Hard-path #2113 cases live in compact-ritual.test.ts (pre-existing).
 */
import { describe, expect, it } from "vitest";
import {
  formatSoftAgentsRebindChecklist,
  isSoftAgentsRebindText,
  SOFT_AGENTS_REBIND_CHECKLIST,
  SOFT_AGENTS_REBIND_MARKER,
  SOFT_REBIND_HOST_MATRIX,
  softAgentsRebindForbiddenHits,
} from "./compact-ritual.js";

describe("compact-ritual soft SoT forward coverage (#3171)", () => {
  it("exports a six-item shared checklist SoT", () => {
    expect(SOFT_AGENTS_REBIND_CHECKLIST).toHaveLength(6);
    const text = formatSoftAgentsRebindChecklist();
    expect(isSoftAgentsRebindText(text)).toBe(true);
    expect(text).toContain(SOFT_AGENTS_REBIND_MARKER);
    expect(softAgentsRebindForbiddenHits(text)).toEqual([]);
  });

  it("lists five hosts with Codex gap and OpenClaw required soft", () => {
    expect(SOFT_REBIND_HOST_MATRIX).toHaveLength(5);
    expect(SOFT_REBIND_HOST_MATRIX.find((r) => r.host === "codex")?.softRebind).toBe(
      "docs-best-effort",
    );
    expect(SOFT_REBIND_HOST_MATRIX.find((r) => r.host === "openclaw")?.softRebind).toBe("required");
  });
});
