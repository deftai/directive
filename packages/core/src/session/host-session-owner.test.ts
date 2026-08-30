import { describe, expect, it } from "vitest";
import { ambientHostSessionOwner, canonicalHostSessionId } from "./host-session-owner.js";
import { resolveOccupancySessionId } from "./occupancy.js";

const GROK_OWNER = "host:grok:v1:Z3Jvay1zZXNzaW9uLWE";

describe("ambientHostSessionOwner (#3873)", () => {
  it("canonicalizes the id the running host published to this process", () => {
    expect(ambientHostSessionOwner({ GROK_SESSION_ID: "grok-session-a" })).toBe(GROK_OWNER);
    expect(canonicalHostSessionId("grok", "grok-session-a")).toBe(GROK_OWNER);
  });

  it.each([{}, { GROK_SESSION_ID: "" }, { GROK_SESSION_ID: " padded " }, { DEFT_SESSION_ID: "x" }])(
    "resolves null when no usable host id is published (%#)",
    (environ) => {
      expect(ambientHostSessionOwner(environ)).toBeNull();
    },
  );
});

describe("resolveOccupancySessionId owner precedence (#3873)", () => {
  const mint = () => "minted-uuid";

  it("prefers an explicit owner, then the ambient one, then the host's", () => {
    expect(
      resolveOccupancySessionId({
        sessionId: "explicit",
        env: { DEFT_SESSION_ID: "ambient", GROK_SESSION_ID: "grok-session-a" },
        newSessionId: mint,
      }),
    ).toBe("explicit");
    expect(
      resolveOccupancySessionId({
        env: { DEFT_SESSION_ID: "ambient", GROK_SESSION_ID: "grok-session-a" },
        newSessionId: mint,
      }),
    ).toBe("ambient");
    expect(
      resolveOccupancySessionId({ env: { GROK_SESSION_ID: "grok-session-a" }, newSessionId: mint }),
    ).toBe(GROK_OWNER);
  });

  it("still mints when the host publishes nothing", () => {
    // The mint is the last resort, not the second one: a minted owner is
    // exactly what a later hook process cannot present.
    expect(resolveOccupancySessionId({ env: {}, newSessionId: mint })).toBe("minted-uuid");
  });
});
