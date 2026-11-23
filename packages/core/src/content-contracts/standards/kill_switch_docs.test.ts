/** Content contract for the kill record docs and agents-entry line (#6740). */
import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

const DOC = "docs/deft-directive-disable.md";
const AGENTS_ENTRY = "templates/agents-entry.md";

describe("kill record docs (#6740)", () => {
  it("names the record, the verbs, the warning and the honest limits", () => {
    const text = readText(DOC);
    for (const token of [
      ".deft/authz/kill-switch.disable",
      "schema=deft.kill-switch.v1",
      "git rev-parse --absolute-git-dir",
      "deft kill-switch:on --confirm",
      "deft kill-switch:off --confirm",
      "turns nothing off",
      "Presence alone means nothing",
      "--kill-switch-reader v1",
      "# directive-kill-switch-reader: v1",
      "Honest limits",
      "as strong as the grant store and the kept mint, no stronger",
      "#6292",
      "WSL",
      "#6136",
    ]) {
      expect(text, `kill-switch doc missing ${token}`).toContain(token);
    }
  });

  it("drops the create-the-file step", () => {
    const text = readText(DOC);
    expect(text).not.toMatch(/touch \.deft-directive-disable/);
    expect(text).not.toMatch(/rm \.deft-directive-disable/);
    expect(text).not.toMatch(/Presence is the flag/);
  });

  it("the agents-entry line names the record and the off verb", () => {
    const text = readText(AGENTS_ENTRY);
    expect(text).toContain(".deft/authz/kill-switch.disable");
    expect(text).toContain("deft kill-switch:off --confirm");
    expect(text).toContain("turns nothing off");
    expect(text).not.toContain("presence = flag");
  });
});
