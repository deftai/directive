import { describe, expect, it } from "vitest";
import { changelog as rootNamespace } from "../index.js";
import * as barrel from "./index.js";

describe("changelog barrel (#6314)", () => {
  it("re-exports the path test, fragment reader and effective view", () => {
    expect(typeof barrel.isChangelogEntryPath).toBe("function");
    expect(typeof barrel.isChangelogFragmentPath).toBe("function");
    expect(typeof barrel.parseFragmentText).toBe("function");
    expect(typeof barrel.readChangelogFragments).toBe("function");
    expect(typeof barrel.readEffectiveUnreleased).toBe("function");
    expect(typeof barrel.effectiveChangelogText).toBe("function");
    expect(barrel.CHANGELOG_FILE_REL).toBe("CHANGELOG.md");
    expect(barrel.CHANGELOG_FRAGMENT_DIR).toBe("changelog.d");
  });

  it("is the root `changelog` namespace", () => {
    expect(rootNamespace.isChangelogEntryPath).toBe(barrel.isChangelogEntryPath);
    expect(rootNamespace.effectiveChangelogText).toBe(barrel.effectiveChangelogText);
  });
});
