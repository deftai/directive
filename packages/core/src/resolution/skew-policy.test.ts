import { describe, expect, it } from "vitest";
import { ACCEPT_ENGINE_SKEW_ENV, DEFAULT_ENGINE_SKEW_WINDOW, evaluateSkew } from "./skew-policy.js";

describe("resolution/skew-policy three-band policy (#2264 a5)", () => {
  it("engine == pin proceeds silently (trace only)", () => {
    const r = evaluateSkew("0.65.0", "0.65.0");
    expect(r.band).toBe("match");
    expect(r.decision).toBe("proceed-silent");
    expect(r.message).toBeNull();
    expect(r.requiresUpdateFirst).toBe(false);
  });

  it("engine within the pre-1.0 minor window proceeds loud + update-first", () => {
    const r = evaluateSkew("0.67.0", "0.65.0", { engineSkewWindow: DEFAULT_ENGINE_SKEW_WINDOW });
    expect(r.band).toBe("within-window");
    expect(r.decision).toBe("proceed-loud-update");
    expect(r.requiresUpdateFirst).toBe(true);
    expect(r.message).toContain("ahead of pin");
  });

  it("engine beyond the window fails closed non-interactively", () => {
    const r = evaluateSkew("0.70.0", "0.65.0", { engineSkewWindow: 3 });
    expect(r.band).toBe("beyond-window");
    expect(r.decision).toBe("fail-closed");
    expect(r.escapeHatchUsed).toBe(false);
    expect(r.message).toContain("--accept-engine-jump");
  });

  it("beyond-window is accepted via the --accept-engine-jump flag", () => {
    const r = evaluateSkew("0.70.0", "0.65.0", { engineSkewWindow: 3, acceptEngineJump: true });
    expect(r.decision).toBe("proceed-loud-update");
    expect(r.escapeHatchUsed).toBe(true);
    expect(r.requiresUpdateFirst).toBe(true);
  });

  it("beyond-window is accepted via the DEFT_ACCEPT_ENGINE_SKEW env escape", () => {
    const r = evaluateSkew("0.70.0", "0.65.0", {
      engineSkewWindow: 3,
      env: { [ACCEPT_ENGINE_SKEW_ENV]: "1" },
    });
    expect(r.decision).toBe("proceed-loud-update");
    expect(r.escapeHatchUsed).toBe(true);
  });

  it("beyond-window prompts when interactive and no escape hatch", () => {
    const r = evaluateSkew("0.70.0", "0.65.0", { engineSkewWindow: 3, interactive: true });
    expect(r.decision).toBe("prompt");
    expect(r.message).toContain("prompt the operator");
  });

  it("engine < pin rejects the global and falls through the ladder", () => {
    const r = evaluateSkew("0.63.0", "0.65.0");
    expect(r.band).toBe("engine-behind");
    expect(r.decision).toBe("reject-global");
    expect(r.message).toContain("falling through the ladder");
  });

  it("post-1.0 window collapses to same-major", () => {
    const sameMajor = evaluateSkew("1.9.0", "1.2.0");
    expect(sameMajor.band).toBe("within-window");
    const majorJump = evaluateSkew("2.0.0", "1.9.0");
    expect(majorJump.band).toBe("beyond-window");
  });

  it("a pre-1.0 engine on a post-1.0-crossing major is beyond-window", () => {
    const r = evaluateSkew("1.0.0", "0.65.0", { engineSkewWindow: 3 });
    expect(r.band).toBe("beyond-window");
  });

  it("unparseable versions fail closed", () => {
    const r = evaluateSkew(null, "0.65.0");
    expect(r.band).toBe("unknown");
    expect(r.decision).toBe("fail-closed");
    expect(r.message).toContain("unorderable");
  });

  it("a negative / non-integer window falls back to the default", () => {
    const r = evaluateSkew("0.67.0", "0.65.0", { engineSkewWindow: -1 });
    expect(r.band).toBe("within-window");
  });
});
