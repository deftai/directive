import { describe, expect, it } from "vitest";
import {
  computeDepositSha,
  DEPOSIT_SHA_MATCH_NOOP,
  depositShaMatches,
  formatDepositShaMatchLine,
  resolveDepositShaInputs,
} from "./deposit-sha.js";

describe("computeDepositSha (#3286)", () => {
  it("covers payload, templates, and engine inputs", () => {
    const a = computeDepositSha({
      inputs: {
        engineVersion: "1.0.0",
        payloadVersion: "1.0.0",
        templatesHash: "aaa",
      },
    });
    const b = computeDepositSha({
      inputs: {
        engineVersion: "1.0.0",
        payloadVersion: "1.0.0",
        templatesHash: "aaa",
      },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when engine version changes", () => {
    const base = {
      payloadVersion: "p",
      templatesHash: "t",
    };
    const a = computeDepositSha({ inputs: { ...base, engineVersion: "1.0.0" } });
    const b = computeDepositSha({ inputs: { ...base, engineVersion: "1.0.1" } });
    expect(a).not.toBe(b);
  });

  it("changes when payload version changes", () => {
    const base = {
      engineVersion: "e",
      templatesHash: "t",
    };
    const a = computeDepositSha({ inputs: { ...base, payloadVersion: "1" } });
    const b = computeDepositSha({ inputs: { ...base, payloadVersion: "2" } });
    expect(a).not.toBe(b);
  });

  it("changes when templates hash changes", () => {
    const base = {
      engineVersion: "e",
      payloadVersion: "p",
    };
    const a = computeDepositSha({ inputs: { ...base, templatesHash: "t1" } });
    const b = computeDepositSha({ inputs: { ...base, templatesHash: "t2" } });
    expect(a).not.toBe(b);
  });

  it("resolveDepositShaInputs prefers injected inputs", () => {
    const inputs = resolveDepositShaInputs({
      inputs: {
        engineVersion: "eng",
        payloadVersion: "pay",
        templatesHash: "tmpl",
      },
    });
    expect(inputs).toEqual({
      engineVersion: "eng",
      payloadVersion: "pay",
      templatesHash: "tmpl",
    });
  });

  it("formatDepositShaMatchLine uses canonical phrase", () => {
    expect(formatDepositShaMatchLine("agents:refresh")).toBe(
      `agents:refresh: ${DEPOSIT_SHA_MATCH_NOOP}`,
    );
    expect(depositShaMatches("AbC", "abc")).toBe(true);
    expect(depositShaMatches("a", "b")).toBe(false);
    expect(depositShaMatches(null, "a")).toBe(false);
  });
});
