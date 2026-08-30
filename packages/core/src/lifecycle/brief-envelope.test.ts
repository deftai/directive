import { describe, expect, it } from "vitest";
import {
  BRIEF_ENVELOPE_KEYS,
  missingEnvelopeMessage,
  presentEnvelopeKeys,
  stampExistingEnvelopes,
} from "./brief-envelope.js";

const NOW = "2026-06-19T12:00:00Z";

describe("brief envelope policy (#3933)", () => {
  it("orders envelope keys v0.8 first", () => {
    expect([...BRIEF_ENVELOPE_KEYS]).toEqual(["xBRIEFInfo", "vBRIEFInfo"]);
  });

  it("stamps an existing v0.8 envelope and creates no legacy key", () => {
    const data: Record<string, unknown> = {
      xBRIEFInfo: { version: "0.8", updated: "2026-01-01T00:00:00Z" },
      plan: {},
    };
    expect(stampExistingEnvelopes(data, NOW)).toEqual(["xBRIEFInfo"]);
    expect(data).toEqual({ xBRIEFInfo: { version: "0.8", updated: NOW }, plan: {} });
  });

  it("stamps an existing legacy v0.6 envelope in place", () => {
    const data: Record<string, unknown> = {
      vBRIEFInfo: { version: "0.6", updated: "2026-01-01T00:00:00Z" },
      plan: {},
    };
    expect(stampExistingEnvelopes(data, NOW)).toEqual(["vBRIEFInfo"]);
    expect(data.vBRIEFInfo).toEqual({ version: "0.6", updated: NOW });
  });

  it("stamps both envelopes on a hybrid artifact", () => {
    const data: Record<string, unknown> = {
      xBRIEFInfo: { version: "0.8" },
      vBRIEFInfo: { version: "0.6" },
    };
    expect(stampExistingEnvelopes(data, NOW)).toEqual(["xBRIEFInfo", "vBRIEFInfo"]);
    expect((data.xBRIEFInfo as { updated: string }).updated).toBe(NOW);
    expect((data.vBRIEFInfo as { updated: string }).updated).toBe(NOW);
  });

  it("reports no stamped key and mutates nothing when neither envelope is present", () => {
    const data: Record<string, unknown> = { plan: { status: "pending" } };
    expect(stampExistingEnvelopes(data, NOW)).toEqual([]);
    expect(data).toEqual({ plan: { status: "pending" } });
  });

  it("ignores non-object envelope values", () => {
    expect(presentEnvelopeKeys({ xBRIEFInfo: "bad", vBRIEFInfo: null })).toEqual([]);
    expect(presentEnvelopeKeys({ vBRIEFInfo: [] })).toEqual([]);
  });

  it("names both accepted envelopes in the refusal", () => {
    const message = missingEnvelopeMessage("vBRIEF at /tmp/x.xbrief.json");
    expect(message).toContain("vBRIEF at /tmp/x.xbrief.json");
    expect(message).toContain("`xBRIEFInfo` (v0.8)");
    expect(message).toContain("`vBRIEFInfo` (v0.6)");
    expect(message).toContain("#3933");
  });
});
