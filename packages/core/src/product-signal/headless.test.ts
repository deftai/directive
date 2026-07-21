import { describe, expect, it } from "vitest";
import { isHeadlessSession } from "./headless.js";

describe("isHeadlessSession", () => {
  it("detects CI", () => {
    expect(isHeadlessSession({ env: { CI: "true" }, stdinIsTTY: true })).toBe(true);
  });

  it("detects DEFT_HEADLESS true string", () => {
    expect(isHeadlessSession({ env: { DEFT_HEADLESS: "true" } })).toBe(true);
  });

  it("detects non-tty stdin", () => {
    expect(isHeadlessSession({ env: {}, stdinIsTTY: false })).toBe(true);
    expect(isHeadlessSession({ env: {}, stdinIsTTY: true })).toBe(false);
  });

  it("ignores empty CI markers", () => {
    expect(isHeadlessSession({ env: { CI: "0" }, stdinIsTTY: true })).toBe(false);
    expect(isHeadlessSession({ env: { CI: "false" }, stdinIsTTY: true })).toBe(false);
  });
});
