import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { isolatedConsentEnv } from "./consent-env.test.js";
import {
  isProductSignalConsentEligible,
  maybeFormatProductSignalConsentPrompt,
  PRODUCT_SIGNAL_CONSENT_PROMPT,
} from "./consent-prompt.js";

const temps: string[] = [];
const consentHomes: string[] = [];
afterEach(() => {
  for (const h of consentHomes.splice(0)) {
    rmSync(h, { recursive: true, force: true });
  }
});
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

function makeRepo(enabled: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "deft-ps-consent-prompt-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: {
        title: "T",
        status: "running",
        items: [],
        policy: { productSignal: { enabled } },
      },
    }),
    "utf8",
  );
  return root;
}

describe("product-signal consent prompt (#2822 D17)", () => {
  it("surfaces prompt when enabled and consent missing in interactive session", () => {
    const root = makeRepo(true);
    // Isolate HOME/APPDATA so a real operator grant on the host cannot leak (#2897).
    const env = isolatedConsentEnv(consentHomes, false);
    expect(
      isProductSignalConsentEligible({
        projectRoot: root,
        env,
        stdinIsTTY: true,
      }),
    ).toBe(true);
    const text = maybeFormatProductSignalConsentPrompt({
      projectRoot: root,
      env,
      stdinIsTTY: true,
    });
    expect(text).toContain(PRODUCT_SIGNAL_CONSENT_PROMPT.slice(0, 40));
    expect(text).toContain("product-signal:consent");
  });

  it("stays silent in headless sessions (fail-open)", () => {
    const root = makeRepo(true);
    const env = { ...isolatedConsentEnv(consentHomes, false), CI: "true" };
    expect(
      isProductSignalConsentEligible({
        projectRoot: root,
        env,
        stdinIsTTY: false,
      }),
    ).toBe(false);
    expect(
      maybeFormatProductSignalConsentPrompt({
        projectRoot: root,
        env,
        stdinIsTTY: false,
      }),
    ).toBe("");
  });

  it("does not prompt when product signal disabled", () => {
    const root = makeRepo(false);
    const env = isolatedConsentEnv(consentHomes, false);
    expect(
      isProductSignalConsentEligible({
        projectRoot: root,
        env,
        stdinIsTTY: true,
      }),
    ).toBe(false);
  });

  it("does not prompt when isolated env already has consent", () => {
    const root = makeRepo(true);
    const env = isolatedConsentEnv(consentHomes, true);
    expect(
      isProductSignalConsentEligible({
        projectRoot: root,
        env,
        stdinIsTTY: true,
      }),
    ).toBe(false);
  });
});
