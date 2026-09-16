import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyPreflightObservableMintDemand,
  classifyVerifyObservableMintDemand,
  OBSERVABLE_MINT_FAIL_CLOSED_SITE,
  OBSERVABLE_MINT_OPEN_PREDECESSOR,
  OBSERVABLE_MINT_PARKING_IS_WHEN,
  OBSERVABLE_MINT_WHEN_HINT,
} from "./demand.js";
import { evaluateObservableMintPreflight } from "./mint.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("observable-scope mint demand predicate (#4588)", () => {
  it("names verify demand as merge-base policy AND matched markup", () => {
    expect(
      classifyVerifyObservableMintDemand({
        policyPresent: true,
        uiChanged: true,
        matchedCount: 1,
        matchedMarkupCount: 1,
      }),
    ).toEqual({
      site: "verify",
      failClosed: true,
      demand: true,
      reason: "demand-policy-and-matched-markup",
    });
  });

  it("treats greenfield without policy as N/A, not an ask", () => {
    expect(
      classifyVerifyObservableMintDemand({
        policyPresent: false,
        uiChanged: false,
        matchedCount: 0,
        matchedMarkupCount: 0,
      }),
    ).toMatchObject({ demand: false, reason: "na-no-policy" });
  });

  it("warns, and does not demand, when policy is unset and UI files change", () => {
    expect(
      classifyVerifyObservableMintDemand({
        policyPresent: false,
        uiChanged: true,
        matchedCount: 0,
        matchedMarkupCount: 0,
      }),
    ).toMatchObject({ demand: false, reason: "warn-unset-policy-ui" });
  });

  it("does not demand when policy surfaces do not match or have no markup", () => {
    expect(
      classifyVerifyObservableMintDemand({
        policyPresent: true,
        uiChanged: false,
        matchedCount: 0,
        matchedMarkupCount: 0,
      }),
    ).toMatchObject({ demand: false, reason: "na-unmatched" });
    expect(
      classifyVerifyObservableMintDemand({
        policyPresent: true,
        uiChanged: false,
        matchedCount: 1,
        matchedMarkupCount: 0,
      }),
    ).toMatchObject({ demand: false, reason: "na-no-markup" });
  });

  it("preflight demands only markup in intended_placement.files", () => {
    expect(classifyPreflightObservableMintDemand(["src/App.tsx"])).toEqual({
      site: "preflight",
      failClosed: false,
      demand: true,
      reason: "intended-placement-markup",
    });
    expect(classifyPreflightObservableMintDemand([])).toMatchObject({
      demand: false,
      failClosed: false,
      reason: "no-markup-in-intended-placement",
    });
    expect(classifyPreflightObservableMintDemand(["src/app.ts"])).toMatchObject({
      demand: false,
    });
  });

  it("does not demand mint when a setup-created brief parks without markup placement", () => {
    expect(OBSERVABLE_MINT_PARKING_IS_WHEN).toBe(false);
    const parked = evaluateObservableMintPreflight(
      {
        plan: {
          id: "setup-story",
          status: "pending",
          metadata: { intended_placement: { files: [] } },
        },
      },
      "/tmp/setup-park",
    );
    expect(parked.ok).toBe(true);
    expect(
      evaluateObservableMintPreflight({ plan: { id: "setup-story", status: "pending" } }, "/tmp/x")
        .ok,
    ).toBe(true);
  });

  it("picks verify merge-base as the fail-closed when and records #4383 as predecessor", () => {
    expect(OBSERVABLE_MINT_FAIL_CLOSED_SITE).toBe("verify-merge-base");
    expect(OBSERVABLE_MINT_OPEN_PREDECESSOR).toBe("#4383");
    expect(OBSERVABLE_MINT_WHEN_HINT).toMatch(/verify merge-base/);
    expect(OBSERVABLE_MINT_WHEN_HINT).toMatch(/x-directive\/observableChange/);
    expect(OBSERVABLE_MINT_WHEN_HINT).toMatch(/#4383/);
    expect(OBSERVABLE_MINT_WHEN_HINT).toMatch(/Parking is not this when/);
  });

  it("docs name the predicate, fail-closed site, and parking-is-not-when (#4588)", () => {
    const docs = readFileSync(join(repoRoot, "content/docs/observable-scope.md"), "utf8");
    expect(docs).toMatch(/merge-base surfaces policy/);
    expect(docs).toMatch(/intended_placement\.files/);
    expect(docs).toMatch(/#4383/);
    expect(docs).toMatch(/Parking is not this when/);
    expect(docs).not.toMatch(/Missing mint is a preflight \/ dispatch refusal/);
    expect(docs).toMatch(/Do not .fix when. by tightening working-tree/);
  });
});
