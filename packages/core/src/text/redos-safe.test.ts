import { describe, expect, it } from "vitest";
import {
  expandPythonJsonSeparators,
  findLastReviewedCommitSha,
  findSkillPathsInText,
  parseGitHubRemoteRepo,
  parseGitHubRepoSlug,
  parseManifestKeyValueLine,
  parseMarkdownHeading,
  stripEdgeQuotes,
  stripTrailingPathSeparators,
} from "./redos-safe.js";

describe("ReDoS-safe shared helpers", () => {
  it("stripTrailingPathSeparators matches /[\\/]+$/", () => {
    expect(stripTrailingPathSeparators("a/b/")).toBe("a/b");
    expect(stripTrailingPathSeparators("a\\b\\\\")).toBe("a\\b");
    expect(stripTrailingPathSeparators("///")).toBe("");
    expect(stripTrailingPathSeparators("abc")).toBe("abc");
  });

  it("stripEdgeQuotes matches /^['\"]|['\"]$/g", () => {
    expect(stripEdgeQuotes(`'hello'`)).toBe("hello");
    expect(stripEdgeQuotes(`"x"`)).toBe("x");
    expect(stripEdgeQuotes("plain")).toBe("plain");
  });

  it("expandPythonJsonSeparators preserves in-string colons and commas", () => {
    const compact = '{"title":"fix: bug","body":"a,b"}';
    expect(expandPythonJsonSeparators(compact)).toBe('{"title": "fix: bug", "body": "a,b"}');
    expect(expandPythonJsonSeparators('{"q":"a \\"b: c\\" d"}')).toBe('{"q": "a \\"b: c\\" d"}');
  });

  it("expandPythonJsonSeparators stays linear on long repeated-prefix input", () => {
    const payload = `{"k":"${"a".repeat(50_000)}:`;
    const start = performance.now();
    const out = expandPythonJsonSeparators(payload);
    expect(performance.now() - start).toBeLessThan(500);
    expect(out).toContain('"k": "');
  });

  it("parseMarkdownHeading mirrors HEADING_RE", () => {
    expect(parseMarkdownHeading("## Title")?.text.trim()).toBe("Title");
    expect(parseMarkdownHeading("##   ")).toBeNull();
    expect(parseMarkdownHeading("not a heading")).toBeNull();
  });

  it("findSkillPathsInText finds referenced skill paths", () => {
    const text =
      "see .deft/core/skills/deft-directive-build/SKILL.md and deft/skills/deft/SKILL.md";
    expect(findSkillPathsInText(text).sort()).toEqual(
      [".deft/core/skills/deft-directive-build/SKILL.md", "deft/skills/deft/SKILL.md"].sort(),
    );
  });

  it("findLastReviewedCommitSha returns the last SHA", () => {
    const body =
      "Last reviewed commit: [a](https://github.com/o/r/commit/aaaaaaa)\n" +
      "Last reviewed commit: [b](https://github.com/o/r/commit/deadbeef1234567)\n";
    expect(findLastReviewedCommitSha(body)).toBe("deadbeef1234567");
  });

  it("parseManifestKeyValueLine parses manifest rows", () => {
    expect(parseManifestKeyValueLine("  tag: 'v1.2.3' ")).toEqual({
      key: "tag",
      value: "v1.2.3",
    });
    expect(parseManifestKeyValueLine("# comment")).toBeNull();
  });

  it("parseGitHubRepoSlug rejects substring host spoofing", () => {
    expect(parseGitHubRepoSlug("owner/repo")).toBe("owner/repo");
    expect(parseGitHubRepoSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGitHubRepoSlug("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(parseGitHubRepoSlug("https://evil-github.com.attacker.com/o/r")).toBeNull();
  });

  it("parseGitHubRemoteRepo infers repo from remotes", () => {
    expect(parseGitHubRemoteRepo("https://github.com/deftai/directive.git/")).toBe(
      "deftai/directive",
    );
    expect(parseGitHubRemoteRepo("git@github.com:deftai/statusreport.git")).toBe(
      "deftai/statusreport",
    );
    expect(parseGitHubRemoteRepo("https://gitlab.com/org/repo.git")).toBeNull();
  });
});
