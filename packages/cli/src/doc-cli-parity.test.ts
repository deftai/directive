import { describe, expect, it } from "vitest";
import {
  collectDocCliParityFailures,
  extractDocCliReferences,
  LEGACY_DOC_VERB_KEYS,
  normalizeDocCommand,
  validateDocCliCommand,
} from "./doc-cli-parity.js";

describe("normalizeDocCommand", () => {
  it("strips flags and placeholders", () => {
    expect(normalizeDocCommand("deft scope:promote -- <path>")).toBe("scope:promote");
    expect(normalizeDocCommand("deft verify:session-ritual -- --tier=gated")).toBe(
      "verify:session-ritual",
    );
    expect(normalizeDocCommand("deft packs:slice <pack> <slice> [-- <filters>]")).toBe(
      "packs:slice",
    );
  });

  it("returns null for paths, globs, and legacy installer literals", () => {
    expect(normalizeDocCommand("deft/QUICK-START.md")).toBeNull();
    expect(normalizeDocCommand("deft-directive-sync")).toBeNull();
    expect(normalizeDocCommand("deft-install --yes --upgrade")).toBeNull();
    expect(normalizeDocCommand("deftai/directive")).toBeNull();
  });
});

describe("doc ↔ CLI parity gate (#1996)", () => {
  it("extracts npm/directive/deft references from UPGRADING and agents-entry", () => {
    const refs = extractDocCliReferences();
    expect(refs.some((r) => r.source === "content/UPGRADING.md" && r.normalized === "doctor")).toBe(
      true,
    );
    expect(
      refs.some((r) => r.source === "content/UPGRADING.md" && r.normalized === "agents:refresh"),
    ).toBe(true);
    expect(
      refs.some(
        (r) => r.source === "content/templates/agents-entry.md" && r.normalized === "triage:queue",
      ),
    ).toBe(true);
  });

  it("validates every extracted command against registeredVerbs + router", () => {
    const failures = collectDocCliParityFailures();
    expect(
      failures,
      failures.map((f) => `${f.source}: \`${f.raw}\` -> ${f.reason}`).join("\n"),
    ).toEqual([]);
  });

  it("fails loudly when a doc verb is not registered", () => {
    expect(validateDocCliCommand("totally-fake-verb")).toMatch(/unregistered handler/);
  });

  it("allowlists documented legacy back-compat verbs", () => {
    for (const key of LEGACY_DOC_VERB_KEYS) {
      expect(validateDocCliCommand(key)).toBeNull();
    }
  });

  it("does not allowlist colon-verbs whose stem matches a legacy key", () => {
    const reason = validateDocCliCommand("core:upgrade");
    expect(reason).not.toBeNull();
    expect(reason).toContain("unregistered handler");
  });

  it("accepts npm top-level init/update/migrate invocations", () => {
    expect(validateDocCliCommand("init")).toBeNull();
    expect(validateDocCliCommand("update")).toBeNull();
  });
});
