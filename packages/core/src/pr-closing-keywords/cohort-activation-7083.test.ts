/**
 * Cohort activation (#7083): one brief-only PR activates several briefs with one
 * `deft-story-part: N` line per brief, offline and live.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { evaluatePathBActivationAcDisposition } from "../verify-ac/evaluate.js";
import { evaluateFullStoryMarkAdmission, evaluatePathBActivationAdmit, run } from "./main.js";
import type { RunGhFn } from "./types.js";

const REPO = "deftai/directive";
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function cohortRoot(issues: readonly number[]): {
  root: string;
  files: { status: string; path: string }[];
} {
  const root = mkdtempSync(join(tmpdir(), "deft-cohort-activation-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief", "active"), { recursive: true });
  const files: { status: string; path: string }[] = [];
  for (const issue of issues) {
    const rel = `xbrief/active/story-${String(issue)}.xbrief.json`;
    writeFileSync(
      join(root, rel),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: `story ${String(issue)}`,
          status: "running",
          references: [
            {
              uri: `https://github.com/${REPO}/issues/${String(issue)}`,
              type: "x-xbrief/github-issue",
            },
          ],
        },
      }),
      "utf8",
    );
    files.push({ status: "added", path: rel });
  }
  return { root, files };
}

const PART_BODY =
  "Refs #701\nRefs #702\nRefs #703\n\ndeft-story-part: 701\ndeft-story-part: 702\ndeft-story-part: 703\n";

describe("cohort activation with part lines (#7083)", () => {
  it("admits a several-brief activation with one part line per brief, offline and live", () => {
    const { root, files } = cohortRoot([701, 702, 703]);
    for (const prNumber of [null, 4242]) {
      const witness = evaluatePathBActivationAdmit({
        bodyText: PART_BODY,
        prNumber,
        projectRoot: root,
        repo: REPO,
        files,
      });
      expect(witness.ok, witness.detail).toBe(true);
      const admission = evaluateFullStoryMarkAdmission({
        bodyText: PART_BODY,
        prNumber,
        projectRoot: root,
        repo: REPO,
        files,
      });
      expect(admission.ok, admission.messages.join("\n")).toBe(true);
    }
    const disposition = evaluatePathBActivationAcDisposition({
      projectRoot: root,
      bodyText: PART_BODY,
      prNumber: null,
      repo: REPO,
      files,
    });
    expect(disposition.apply).toBe(true);
  });

  it("refuses when one brief lacks its part line, or a line names no changed brief", () => {
    const { root, files } = cohortRoot([711, 712]);
    const missing = evaluatePathBActivationAdmit({
      bodyText: "deft-story-part: 711\n",
      prNumber: null,
      projectRoot: root,
      repo: REPO,
      files,
    });
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("issue #712 is not covered");
    const stray = evaluatePathBActivationAdmit({
      bodyText: "deft-story-part: 711\ndeft-story-part: 712\ndeft-story-part: 799\n",
      prNumber: null,
      projectRoot: root,
      repo: REPO,
      files,
    });
    expect(stray.ok).toBe(false);
    expect(stray.detail).toContain("799 has no matching changed nonterminal brief");
    const empty = evaluatePathBActivationAdmit({
      bodyText: "Refs #711\n",
      prNumber: 9,
      projectRoot: root,
      repo: REPO,
      files,
    });
    expect(empty.ok).toBe(false);
    expect(empty.detail).toMatch(/missing deft-story marks or deft-story-part lines/);
  });

  it("passes the live CLI check for a cohort activation PR with part lines", () => {
    const { root, files } = cohortRoot([721, 722]);
    const body = "Refs #721\nRefs #722\n\ndeft-story-part: 721\ndeft-story-part: 722\n";
    const runGh: RunGhFn = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("/files")) {
        return {
          returncode: 0,
          stdout: JSON.stringify(files.map((f) => ({ filename: f.path, status: f.status }))),
          stderr: "",
        };
      }
      if (cmd.includes("body"))
        return { returncode: 0, stdout: JSON.stringify({ body }), stderr: "" };
      if (cmd.includes("commits")) {
        return { returncode: 0, stdout: JSON.stringify({ commits: [] }), stderr: "" };
      }
      return { returncode: 1, stdout: "", stderr: "unexpected" };
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = run(["--pr", "88", "--mode", "fp", "--repo", REPO, "--project-root", root], {
      runGh,
    });
    const err = stderr.mock.calls.join("");
    stderr.mockRestore();
    expect(code, err).toBe(0);
  });
});
