import { describe, expect, it } from "vitest";
import {
  AUTO_PROMOTE_REFUSED,
  deriveBridgeAction,
  formatUnreachableTransitionHint,
  SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE,
} from "./transition-hint.js";

describe("deriveBridgeAction (#4412)", () => {
  it("names promote as the bridge from proposed/ to activate", () => {
    expect(deriveBridgeAction("activate", "proposed")).toBe("promote");
  });

  it("returns null when the action already applies", () => {
    expect(deriveBridgeAction("activate", "pending")).toBeNull();
  });

  it("returns null when no single bridge exists", () => {
    expect(deriveBridgeAction("promote", "active")).toBeNull();
    expect(deriveBridgeAction("activate", "completed")).toBeNull();
  });
});

describe("formatUnreachableTransitionHint (#4412)", () => {
  it("prints promote then activate and records auto-promote as refused", () => {
    const hint = formatUnreachableTransitionHint("activate", "proposed", "story.xbrief.json");
    expect(hint).toContain("deft scope:promote -- xbrief/proposed/story.xbrief.json");
    expect(hint).toContain("deft scope:activate -- xbrief/pending/story.xbrief.json");
    expect(hint).toContain(AUTO_PROMOTE_REFUSED);
  });

  it("returns null when there is no derived bridge", () => {
    expect(formatUnreachableTransitionHint("promote", "active", "story.xbrief.json")).toBeNull();
  });
});

describe("SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE (#4412)", () => {
  it("names both rungs and refuses auto-promote", () => {
    expect(SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE).toContain("scope:promote");
    expect(SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE).toContain("scope:activate");
    expect(SCOPE_NOT_READY_PROMOTE_THEN_ACTIVATE).toContain(AUTO_PROMOTE_REFUSED);
  });
});
