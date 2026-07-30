import { describe, expect, it } from "vitest";
import { escalationPath, escalationsDir } from "./paths.js";

describe("escalation paths (#518)", () => {
  it("roots store under .deft/escalations", () => {
    const dir = escalationsDir("/proj");
    expect(dir.replace(/\\/g, "/")).toMatch(/\.deft\/escalations$/);
  });

  it("sanitizes path separators in id to a single basename under escalations/", () => {
    const p = escalationPath("/proj", "esc/../evil");
    const norm = p.replace(/\\/g, "/");
    expect(norm).toContain(".deft/escalations/");
    // Separators become _; file remains a single leaf under the store dir.
    expect(norm.split("/").pop()).toBe("esc_.._evil.json");
    expect(norm.endsWith(".json")).toBe(true);
  });
});
