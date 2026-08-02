import { describe, expect, it } from "vitest";
import {
  applyExperimentalRulesState,
  EXPERIMENTAL_META_ENTRIES,
  type ExperimentalRulesState,
  parseExperimentalRulesState,
  setExperimentalRule,
} from "./experimental-rules.js";

const SAMPLE_USER_MD = `# User Preferences

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**deft_version**: 0.20.0

## Personal (always wins)

Settings in this section have HIGHEST precedence — override all other deft rules,
including PROJECT-DEFINITION.xbrief.json.

**Name**: Address the user as: **Alex**

**Custom Rules**:
- ! Always use tabs
- ~ Prefer short commits

## Defaults (fallback)

Settings in this section are fallback defaults. PROJECT-DEFINITION.xbrief.json overrides these
for project-scoped settings (strategy, coverage).

**Default Strategy**: interview

**Coverage**: ! ≥90% test coverage

---

**Note**: Edit this file anytime to update your preferences.
**See**: main.md for framework defaults.
`;

const ALL_ON: ExperimentalRulesState = {
  soul: true,
  morals: true,
  "code-field": true,
};

const ALL_OFF: ExperimentalRulesState = {
  soul: false,
  morals: false,
  "code-field": false,
};

/** Personal section for non-clobber asserts (heading through next H2). */
function personalSlice(text: string): string {
  const start = text.indexOf("## Personal (always wins)");
  if (start < 0) {
    throw new Error("Personal section missing");
  }
  const after = text.slice(start);
  const next = after.search(/\n## /);
  return next >= 0 ? after.slice(0, next) : after;
}

/**
 * Defaults core body only (heading through first trailing blank after content),
 * stopping before Experimental Rules or the Note rule — so insert/remove of
 * Experimental Rules does not false-fail non-clobber checks.
 */
function defaultsCore(text: string): string {
  const start = text.indexOf("## Defaults (fallback)");
  if (start < 0) {
    throw new Error("Defaults section missing");
  }
  const after = text.slice(start);
  const enders = [
    after.search(/\n## Experimental Rules\b/),
    after.search(/\n---[ \t]*\r?\n/),
  ].filter((i) => i >= 0);
  const end = enders.length > 0 ? Math.min(...enders) : after.length;
  return after.slice(0, end);
}

function hasExperimentalSection(text: string): boolean {
  return /^## Experimental Rules\b/m.test(text);
}

describe("parseExperimentalRulesState", () => {
  it("reports all off when section absent", () => {
    expect(parseExperimentalRulesState(SAMPLE_USER_MD)).toEqual(ALL_OFF);
    expect(hasExperimentalSection(SAMPLE_USER_MD)).toBe(false);
  });

  it("detects each path independently", () => {
    const text = applyExperimentalRulesState(SAMPLE_USER_MD, {
      soul: true,
      morals: false,
      "code-field": true,
    });
    expect(parseExperimentalRulesState(text)).toEqual({
      soul: true,
      morals: false,
      "code-field": true,
    });
    expect(hasExperimentalSection(text)).toBe(true);
  });

  it("treats custom wording with the same path as on", () => {
    const withCustom = SAMPLE_USER_MD.replace(
      "---\n",
      `## Experimental Rules\n\n- ~ I like meta/SOUL.md a lot\n\n---\n`,
    );
    expect(parseExperimentalRulesState(withCustom).soul).toBe(true);
  });

  it("ignores meta path mentions outside Experimental Rules", () => {
    const withProse = SAMPLE_USER_MD.replace(
      "- ~ Prefer short commits",
      "- ~ Prefer short commits\n- ! See meta/SOUL.md docs for inspiration only",
    );
    expect(parseExperimentalRulesState(withProse).soul).toBe(false);

    // Enabling only morals must not invent SOUL from Personal prose.
    const next = applyExperimentalRulesState(withProse, {
      soul: false,
      morals: true,
      "code-field": false,
    });
    expect(parseExperimentalRulesState(next)).toEqual({
      soul: false,
      morals: true,
      "code-field": false,
    });
    expect(next).toContain("meta/morals.md");
    // Personal prose mention of SOUL remains; section still lacks SOUL bullet.
    expect(personalSlice(next)).toContain("meta/SOUL.md");
    const sectionMatch = next.match(/## Experimental Rules[\s\S]*?(?=\n---|\n## |$)/);
    expect(sectionMatch?.[0] ?? "").not.toContain("meta/SOUL.md");
  });
});

describe("applyExperimentalRulesState", () => {
  it("enables all three without clobbering Personal or Defaults", () => {
    const beforePersonal = personalSlice(SAMPLE_USER_MD);
    const beforeDefaults = defaultsCore(SAMPLE_USER_MD);

    const next = applyExperimentalRulesState(SAMPLE_USER_MD, ALL_ON);

    expect(personalSlice(next)).toBe(beforePersonal);
    expect(defaultsCore(next)).toBe(beforeDefaults);
    expect(parseExperimentalRulesState(next)).toEqual(ALL_ON);
    for (const entry of EXPERIMENTAL_META_ENTRIES) {
      expect(next).toContain(entry.line);
    }
    expect(next).toContain("## Experimental Rules");
    // Section sits before the trailing Note rule, not after it.
    expect(next.indexOf("## Experimental Rules")).toBeLessThan(next.indexOf("**Note**"));
    expect(next).toContain("**Name**: Address the user as: **Alex**");
    expect(next).toContain("- ! Always use tabs");
    expect(next).toContain("**Coverage**: ! ≥90% test coverage");
  });

  it("disables a single entry and leaves others", () => {
    const allOn = applyExperimentalRulesState(SAMPLE_USER_MD, ALL_ON);
    const next = setExperimentalRule(allOn, "morals", false);
    expect(parseExperimentalRulesState(next)).toEqual({
      soul: true,
      morals: false,
      "code-field": true,
    });
    expect(next).not.toContain("meta/morals.md");
    expect(next).toContain("meta/SOUL.md");
    expect(personalSlice(next)).toBe(personalSlice(allOn));
    expect(defaultsCore(next)).toBe(defaultsCore(allOn));
  });

  it("removes the section when all three are off", () => {
    const allOn = applyExperimentalRulesState(SAMPLE_USER_MD, ALL_ON);
    const next = applyExperimentalRulesState(allOn, ALL_OFF);
    expect(hasExperimentalSection(next)).toBe(false);
    expect(next).not.toContain("meta/SOUL.md");
    expect(personalSlice(next)).toBe(personalSlice(SAMPLE_USER_MD));
    expect(defaultsCore(next)).toBe(defaultsCore(SAMPLE_USER_MD));
  });

  it("preserves custom non-meta bullets under Experimental Rules", () => {
    const withCustom = applyExperimentalRulesState(SAMPLE_USER_MD, {
      soul: true,
      morals: false,
      "code-field": false,
    }).replace(
      "- ! Use meta/SOUL.md for strategic context and purpose-driven guidance",
      "- ! Use meta/SOUL.md for strategic context and purpose-driven guidance\n- ! Keep my custom experimental note",
    );

    const next = applyExperimentalRulesState(withCustom, {
      soul: false,
      morals: true,
      "code-field": false,
    });

    expect(next).toContain("- ! Keep my custom experimental note");
    expect(next).toContain("meta/morals.md");
    expect(next).not.toContain("meta/SOUL.md");
    expect(personalSlice(next)).toBe(personalSlice(SAMPLE_USER_MD));
    expect(defaultsCore(next)).toBe(defaultsCore(SAMPLE_USER_MD));
  });

  it("is idempotent when desired state already matches", () => {
    const once = applyExperimentalRulesState(SAMPLE_USER_MD, ALL_ON);
    const twice = applyExperimentalRulesState(once, ALL_ON);
    expect(twice).toBe(once);
  });

  it("preserves CRLF newlines when present", () => {
    const crlf = SAMPLE_USER_MD.replace(/\n/g, "\r\n");
    const next = applyExperimentalRulesState(crlf, {
      soul: true,
      morals: false,
      "code-field": false,
    });
    expect(next).toContain("\r\n");
    expect(next).toContain("## Experimental Rules\r\n");
    expect(personalSlice(next)).toBe(personalSlice(crlf));
  });

  it("no-ops when turning everything off on a file without the section", () => {
    expect(applyExperimentalRulesState(SAMPLE_USER_MD, ALL_OFF)).toBe(SAMPLE_USER_MD);
  });
});
