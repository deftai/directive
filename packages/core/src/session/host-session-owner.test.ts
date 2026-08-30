import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ambientHostSessionOwner, canonicalHostSessionId } from "./host-session-owner.js";
import {
  applyWorktreeOccupancy,
  formatOccupancyRemediation,
  readOccupancy,
  resolveOccupancySessionId,
} from "./occupancy.js";

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

describe("remediation commands stay parseable (#3873)", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  function leased(sessionId: string) {
    const root = mkdtempSync(join(tmpdir(), "occ-quote-"));
    temps.push(root);
    applyWorktreeOccupancy(root, { sessionId, intent: "mutation" });
    return readOccupancy(root) as NonNullable<ReturnType<typeof readOccupancy>>;
  }

  it("inlines a bare-token id into the printed grant and steal commands", () => {
    const message = formatOccupancyRemediation(leased("owner-1"), new Date(), GROK_OWNER);

    expect(message).toContain(`occupancy:grant --child-session-id=${GROK_OWNER}`);
    expect(message).toContain(`--occupant owner-1 --session-id=${GROK_OWNER}`);
  });

  it("keeps the placeholder when an id would not survive a shell", () => {
    // A remediation the reader copies must not mis-parse: an id carrying
    // whitespace or shell syntax stays named in prose and out of the command.
    const message = formatOccupancyRemediation(
      leased("owner; rm -rf /"),
      new Date(),
      "actor with spaces",
    );

    expect(message).toContain("This process presented session actor with spaces");
    expect(message).toContain("occupancy:grant --child-session-id=<your-session-id>");
    expect(message).toContain("--occupant <reported-session-id> --session-id=<your-session-id>");
    expect(message).not.toContain("--child-session-id=actor with spaces");
    expect(message).not.toContain("--occupant owner; rm -rf /");
  });

  it("keeps the placeholder in the empty-actor release remediation", () => {
    const message = formatOccupancyRemediation(leased("owner; rm -rf /"), new Date(), "");

    expect(message).toContain("occupancy:release --session-id=<reported-session-id>");
  });
});
