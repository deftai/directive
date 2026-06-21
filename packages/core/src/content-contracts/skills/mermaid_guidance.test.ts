import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_mermaid_guidance.py (#1838 #1530) */

const _MERMAID_MD = "languages/mermaid.md";

function _read_mermaid_rules() {
  return readRepoFile("languages/mermaid.md");
}

describe("test_mermaid_guidance", () => {
  it("github_gist_sequence_rules_present", () => {
    const text = _read_mermaid_rules();
    const required_phrases = [
      "For `sequenceDiagram` readability on GitHub/Gist renderers, do not rely on `init.background` or `themeCSS` alone",
      "For `sequenceDiagram` readability on GitHub/Gist renderers, place participant declarations inside a grey `box ... end` block",
      "When using `box` in `sequenceDiagram`, place only participant declarations inside the block; message lines and notes must remain outside",
      "Treat renderer quirks as diagram-type-specific; `sequenceDiagram` workarounds SHOULD NOT be generalized to other Mermaid diagram types without testing",
    ];
    for (const phrase of required_phrases) {
      expect(text).toContain(phrase);
    }
  });
  it("github_gist_safe_example_uses_participants_only_inside_box", () => {
    const text = _read_mermaid_rules();
    const pattern =
      /sequenceDiagram\s+box rgb\(192, 192, 192\) Participants\s+participant A as Alice\s+participant B as Bob\s+end\s+A->>B: Hello\s+B->>A: Hi back\s+Note over A,B: Example/ms;
    expect(pattern.test(text)).toBe(true);
  });
});
