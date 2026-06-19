import { describe, expect, it } from "vitest";
import * as session from "./index.js";

describe("session barrel", () => {
  it("re-exports core session symbols", () => {
    expect(typeof session.verifySessionRitual).toBe("function");
    expect(typeof session.runSessionStart).toBe("function");
    expect(typeof session.parse).toBe("function");
    expect(typeof session.readSentinel).toBe("function");
    expect(session.ENV_SKIP).toBe("DEFT_SESSION_RITUAL_SKIP");
  });
});
