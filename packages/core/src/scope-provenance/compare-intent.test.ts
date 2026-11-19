import { describe, expect, it } from "vitest";
import { compareExtractedIntent } from "./compare-intent.js";
import { extractIntentFromPayload } from "./extract-intent.js";

describe("compareExtractedIntent file (#3385)", () => {
  it("returns ok when preimages match", () => {
    const payload = {
      plan: { id: "a", title: "T", narratives: { Description: "d" } },
    };
    const a = extractIntentFromPayload(payload);
    const b = extractIntentFromPayload(payload);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(compareExtractedIntent(a.preimage, b.preimage).ok).toBe(true);
  });

  it("ignores a new acceptance.confessions entry but keeps acceptance.commands pinned (#6643)", () => {
    const mk = (acceptance: Record<string, unknown>) =>
      extractIntentFromPayload({ plan: { id: "a", title: "T", acceptance } });
    const base = mk({ commands: ["task a"], sentences: ["s1"] });
    const confessed = mk({
      commands: ["task a"],
      sentences: ["s1"],
      confessions: ["s1 is not met"],
    });
    const changed = mk({ commands: ["task b"], sentences: ["s1"], confessions: ["x"] });
    expect(base.ok && confessed.ok && changed.ok).toBe(true);
    if (!base.ok || !confessed.ok || !changed.ok) return;
    expect(compareExtractedIntent(base.preimage, confessed.preimage).ok).toBe(true);
    const drift = compareExtractedIntent(base.preimage, changed.preimage);
    expect(drift.ok).toBe(false);
    expect(drift.findings.some((f) => f.kind === "intent-drift" && f.path === "acceptance")).toBe(
      true,
    );
  });
});
