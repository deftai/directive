/**
 * #6934 Bound item 7: the story-line writer notes a `deft-story-part: N` line on a
 * product branch, whether it wrote the line now or found it in the body.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatPartLineNote, writeStoryLineToBodyFile } from "./main.js";
import type { RunGhFn } from "./types.js";

const REPO = "deftai/directive";
const ISSUE = 6934;
const BRIEF = "xbrief/active/s-6934.xbrief.json";
const PRODUCT = [BRIEF, "packages/core/src/x.ts"];
const temps: string[] = [];

afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-part-note-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  writeFileSync(
    join(root, BRIEF),
    JSON.stringify({
      plan: {
        title: "story",
        status: "running",
        references: [
          {
            uri: `https://github.com/${REPO}/issues/${String(ISSUE)}`,
            type: "x-xbrief/github-issue",
          },
        ],
      },
    }),
    "utf8",
  );
  return root;
}

function gitFor(changed: readonly string[]): RunGhFn {
  return (cmd) => {
    if (cmd[0] === "merge-base") return { returncode: 0, stdout: "abc123\n", stderr: "" };
    if (cmd[0] === "diff") {
      return { returncode: 0, stdout: changed.map((p) => `M\0${p}\0`).join(""), stderr: "" };
    }
    if (cmd.includes("rev-parse")) return { returncode: 0, stdout: "feat/x\n", stderr: "" };
    return { returncode: 1, stdout: "", stderr: "unexpected" };
  };
}

function write(root: string, body: string, part: boolean, changed: readonly string[]) {
  const bodyFile = join(root, "body.md");
  writeFileSync(bodyFile, body, "utf8");
  const result = writeStoryLineToBodyFile({
    bodyFile,
    projectRoot: root,
    repo: REPO,
    part,
    runGit: gitFor(changed),
  });
  return { result, after: readFileSync(bodyFile, "utf8") };
}

describe("story-line writer part-line note (#6934)", () => {
  const note = formatPartLineNote(ISSUE);

  it("the note says the PR does not complete the story and how to fix a whole-story PR", () => {
    expect(note).toContain("`deft-story-part: 6934` on a product PR");
    expect(note).toContain("does not complete story #6934");
    expect(note).toContain("a later PR with `deft-story: 6934` must");
    expect(note).toContain("dropping --part does not remove a line already in the body");
  });

  it("writes deft-story-part: N with --part on a product branch and prints the note", () => {
    const { result, after } = write(makeRoot(), "Refs #6934\n", true, PRODUCT);
    expect(result.code).toBe(0);
    expect(after).toBe("Refs #6934\n\ndeft-story-part: 6934\n");
    expect(result.message).toContain("wrote deft-story-part: 6934");
    expect(result.message).toContain(note);
  });

  it("leaves an existing part line unchanged without --part and prints the note", () => {
    const body = "Refs #6934\n\ndeft-story-part: 6934\n";
    const { result, after } = write(makeRoot(), body, false, PRODUCT);
    expect(result.code).toBe(0);
    expect(after).toBe(body);
    expect(result.message).toContain("unchanged");
    expect(result.message).toContain(note);
  });

  it("prints no note on a brief-only branch, with or without --part", () => {
    for (const part of [true, false]) {
      const fresh = write(makeRoot(), "Refs #6934\n", part, [BRIEF]);
      expect(fresh.result.code).toBe(0);
      expect(fresh.result.message).not.toContain("NOTE:");
      const kept = write(makeRoot(), "deft-story-part: 6934\n", part, [BRIEF]);
      expect(kept.result.message).not.toContain("NOTE:");
    }
  });

  it("prints no note for deft-story: N or when the branch has no delivery base", () => {
    const full = write(makeRoot(), "Refs #6934\n", false, PRODUCT);
    expect(full.after).toBe("Refs #6934\n\ndeft-story: 6934\n");
    expect(full.result.message).not.toContain("NOTE:");
    const root = makeRoot();
    const bodyFile = join(root, "body.md");
    writeFileSync(bodyFile, "Refs #6934\n\ndeft-story-part: 6934\n", "utf8");
    const noBase = writeStoryLineToBodyFile({
      bodyFile,
      projectRoot: root,
      repo: REPO,
      part: false,
      runGit: (cmd) =>
        cmd[0] === "merge-base" ? { returncode: 1, stdout: "", stderr: "" } : gitFor(PRODUCT)(cmd),
    });
    expect(noBase.code).toBe(0);
    expect(noBase.message).not.toContain("NOTE:");
  });
});
