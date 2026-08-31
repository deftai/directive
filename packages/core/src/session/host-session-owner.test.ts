import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ambientHostSessionOwner,
  canonicalHostSessionId,
  claimsHostSessionIdShape,
  HOST_ENV_IDENTITY_VARIABLES,
  parseCanonicalHostSessionId,
} from "./host-session-owner.js";
import {
  applyWorktreeOccupancy,
  formatOccupancyRemediation,
  formatPresentedIdentityDisagreement,
  readOccupancy,
  resolveOccupancySessionId,
  resolvePresentedIdentity,
} from "./occupancy.js";

const GROK_OWNER = "host:grok:v1:Z3Jvay1zZXNzaW9uLWE";

describe("ambientHostSessionOwner (#3873)", () => {
  it("canonicalizes the id the running host published to this process", () => {
    expect(ambientHostSessionOwner({ GROK_SESSION_ID: "grok-session-a" })).toBe(GROK_OWNER);
    expect(canonicalHostSessionId("grok", "grok-session-a")).toBe(GROK_OWNER);
  });

  it.each([
    {},
    { GROK_SESSION_ID: "" },
    { GROK_SESSION_ID: " padded " },
    { DEFT_SESSION_ID: "x" },
  ])("resolves null when no usable host id is published (%#)", (environ) => {
    expect(ambientHostSessionOwner(environ)).toBeNull();
  });
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

describe("shared actor-resolution chain (#3954 item 1)", () => {
  it("shares the lookup order with the claim path and reports its source", () => {
    const host = { GROK_SESSION_ID: "grok-session-a" };
    expect(resolvePresentedIdentity({ sessionId: "explicit", env: host }).source).toBe("explicit");
    expect(
      resolvePresentedIdentity({ env: { ...host, DEFT_SESSION_ID: "ambient" } }),
    ).toMatchObject({ sessionId: "ambient", source: "environment" });
    expect(resolvePresentedIdentity({ env: host })).toMatchObject({
      sessionId: GROK_OWNER,
      source: "host",
    });
  });

  it("terminates at the empty string so a prove-surface never mints", () => {
    // The whole point of the split: claim mints, the surfaces that prove an
    // identity keep the state their "you presented nothing" diagnosis is
    // written for, on every host that publishes no owner.
    expect(resolvePresentedIdentity({ env: {} })).toMatchObject({ sessionId: "", source: "none" });
    expect(resolveOccupancySessionId({ env: {}, newSessionId: () => "minted-uuid" })).toBe(
      "minted-uuid",
    );
  });

  it("reports a claimer-versus-presenter split rather than resolving it", () => {
    const split = resolvePresentedIdentity({
      env: { DEFT_SESSION_ID: "host:claude:v1:c2Vzc2lvbi1h", GROK_SESSION_ID: "grok-session-a" },
    });

    // The order stands -- DEFT_SESSION_ID still wins -- but the disagreement is
    // carried out so a refusal can name it. This is the deployed shape: a stale
    // inherited id from another host's session ahead of this host's own owner.
    expect(split.sessionId).toBe("host:claude:v1:c2Vzc2lvbi1h");
    expect(split.disagreeingHostOwner).toBe(GROK_OWNER);
    const note = formatPresentedIdentityDisagreement(split);
    expect(note).toContain("DEFT_SESSION_ID names session host:claude:v1:c2Vzc2lvbi1h");
    expect(note).toContain(`--session-id=${GROK_OWNER}`);
  });

  it("reports no split when the sources agree or only one resolves", () => {
    expect(
      resolvePresentedIdentity({ sessionId: GROK_OWNER, env: { GROK_SESSION_ID: "grok-session-a" } })
        .disagreeingHostOwner,
    ).toBeNull();
    expect(
      resolvePresentedIdentity({ env: { DEFT_SESSION_ID: "ambient" } }).disagreeingHostOwner,
    ).toBeNull();
    expect(formatPresentedIdentityDisagreement(resolvePresentedIdentity({ env: {} }))).toBe("");
  });
});

describe("canonical owner shape (#3954 item 3)", () => {
  it("names the host-published variables so a test can scrub all of them", () => {
    expect(HOST_ENV_IDENTITY_VARIABLES).toEqual(["GROK_SESSION_ID"]);
  });

  it("parses a well-formed owner back to its provider and raw id", () => {
    expect(parseCanonicalHostSessionId(GROK_OWNER)).toEqual({
      provider: "grok",
      rawSessionId: "grok-session-a",
    });
  });

  it.each([
    "host:nosuchhost:v9:zzzz",
    "host:grok:v1:!!!not-base64url!!!",
    "host:grok:v2:Z3Jvay1zZXNzaW9uLWE",
    "host:grok:v1:",
    // Decodes to the same raw id as GROK_OWNER but is a different string, so
    // accepting it would give one session two canonical names.
    "host:grok:v1:Z3Jvay1zZXNzaW9uLWF",
    // Decodes to nothing, and to a control character.
    "host:grok:v1:A",
    "host:grok:v1:Z3Jvay1zZXNzaW9uLWEA",
    "not-a-host-id-at-all",
  ])("refuses %s as a canonical owner", (value) => {
    expect(parseCanonicalHostSessionId(value)).toBeNull();
  });

  it("separates claiming the host shape from being a valid one", () => {
    expect(claimsHostSessionIdShape("host:nosuchhost:v9:zzzz")).toBe(true);
    expect(claimsHostSessionIdShape("not-a-host-id-at-all")).toBe(false);
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

  it("keeps the placeholder for an option-shaped id the CLI would reject", () => {
    // The shell would pass `--weird-owner` through intact; the CLI parser reads
    // it as another option, so the printed command still has to be fillable.
    const message = formatOccupancyRemediation(
      leased("--weird-owner"),
      new Date(),
      "--weird-actor",
    );

    expect(message).toContain("occupancy:grant --child-session-id=<your-session-id>");
    expect(message).toContain("--occupant <reported-session-id> --session-id=<your-session-id>");
    expect(message).not.toContain("--child-session-id=--weird-actor");
    expect(message).not.toContain("--occupant --weird-owner");
  });

  it("keeps the placeholder in the empty-actor release remediation", () => {
    const message = formatOccupancyRemediation(leased("owner; rm -rf /"), new Date(), "");

    expect(message).toContain("occupancy:release --session-id=<reported-session-id>");
  });
});
