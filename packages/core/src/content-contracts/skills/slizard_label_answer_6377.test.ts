import { describe, expect, it } from "vitest";
import { readSkill } from "./helpers.js";

/**
 * #6377 -- record an answered SLizard finding with the bot's label command.
 * Bound remedy on #6377 (lean 6908155861): label rule after the classify step,
 * evidence rules unchanged, free-text note, clearing sequence, limits.
 */

const SKILL = "skills/deft-directive-review-cycle/SKILL.md";
const SECTION = "Policy-anchored review-response (#3452)";

function policySection(): string {
  const text = readSkill(SKILL);
  const start = text.indexOf(SECTION);
  expect(start).not.toBe(-1);
  const dual = text.indexOf("### Dual stop", start);
  expect(dual).toBeGreaterThan(start);
  return text.slice(start, dual);
}

function ruleBlock(heading: string): string {
  const section = policySection();
  const start = section.indexOf(heading);
  expect(start).not.toBe(-1);
  const next = section.indexOf("\n! **", start + heading.length);
  return section.slice(start, next === -1 ? undefined : next);
}

describe("slizard_label_answer_6377", () => {
  it("names the bot's label command as the way to record an answered finding", () => {
    const block = ruleBlock("Record SLizard answers by label (#6377)");
    expect(block).toContain("@slizard label");
    expect(block).toMatch(/one top-level pull-request comment per review round/);
  });

  it("places the label rule after the classify step", () => {
    const section = policySection();
    const classify = section.indexOf("Classify-then-act");
    const label = section.indexOf("Record SLizard answers by label");
    expect(classify).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(classify);
  });

  it("limits fp to the head-blob check with head SHA and path in the reason", () => {
    const block = ruleBlock("Record SLizard answers by label (#6377)");
    expect(block).toMatch(/`fp` only for a finding disproved by the head-blob check/);
    expect(block).toMatch(/cites the head SHA and the path/);
  });

  it("limits risk to the HEAD-policy rule with that anchor in the reason", () => {
    const block = ruleBlock("Record SLizard answers by label (#6377)");
    expect(block).toMatch(
      /`risk` only for a finding accepted out-of-model under the HEAD-policy rule/,
    );
    expect(block).toMatch(/cites that anchor/);
  });

  it("says an in-model defect is fixed and not labelled", () => {
    const block = ruleBlock("Record SLizard answers by label (#6377)");
    expect(block).toMatch(/in-model defect is fixed in the round batch and is not labelled/);
    expect(policySection()).toMatch(/⊗ Offer `fp` and `risk` as interchangeable ways/);
  });

  it("says a free-text reply alone does not stop a finding from returning", () => {
    const block = ruleBlock("Record SLizard answers by label (#6377)");
    expect(block).toMatch(/free-text reply alone does not stop a finding from returning/);
  });

  it("rewords the head-blob sentence: the falsification line is the label reason", () => {
    const head = ruleBlock("Head-blob check (slizard#2694)");
    expect(head).not.toContain("A one-line falsification reply citing slizard#2694 is enough");
    expect(head).toMatch(/is the reason text of the SLizard `fp` label/);
  });

  it("names the one clearing sequence: label, acknowledgement, re-review, pr:merge-ready", () => {
    const block = ruleBlock("SLizard clearing sequence (#6377)");
    const label = block.indexOf("(1) label");
    const ack = block.indexOf("(2) read the bot's acknowledgement");
    const review = block.indexOf("(3) when no further push follows, request a re-review");
    const ready = block.indexOf("(4) run `pr:merge-ready` again");
    expect(label).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(label);
    expect(review).toBeGreaterThan(ack);
    expect(ready).toBeGreaterThan(review);
    expect(block).toContain("@slizard review");
    expect(block).toMatch(/gate reads only the bot's verdict/);
  });

  it("writes the limits next to the rule and names slizard#3847", () => {
    const block = ruleBlock("Label limits (#6377)");
    expect(block).toMatch(/finding identities the bot recognises/);
    expect(block).toMatch(/returns under a new fingerprint is labelled again/);
    expect(block).toMatch(/returns although it was labelled is a bot defect/);
    expect(block).toContain("slizard#3847");
  });

  it("keeps --skip-slizard an explicit override in the SLizard section", () => {
    const text = readSkill(SKILL);
    expect(text).toMatch(
      /the label record and clearing sequence \(Policy-anchored review-response, #6377\)/,
    );
    expect(text).toMatch(/`--skip-slizard` is explicit override only/);
  });
});
