import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import * as scm from "../scm/call.js";
import { append, findByIssue, latestDecision, newDecisionId, readAll } from "./candidates-log.js";
import {
  FAILURE_INVALID_MODE,
  githubAuthModesMain,
  validateGithubAuth,
} from "./github-auth-modes.js";
import { mainEntry as authCliMain } from "./github-auth-modes-cli.js";
import { createIssue, githubBodyMain } from "./github-body.js";
import { mainEntry as bodyCliMain } from "./github-body-cli.js";
import {
  emitUmbrella,
  existingGithubIssueRef,
  issueEmitMain,
  loadVbrief,
  renderUmbrellaBody,
  writeVbrief,
} from "./issue-emit.js";
import { mainEntry as emitCliMain } from "./issue-emit-cli.js";
import {
  buildIssueVbrief,
  fetchIssue,
  ingestOne,
  ingestSingleForAccept,
  issueIngestMain,
} from "./issue-ingest.js";
import { mainEntry as ingestCliMain } from "./issue-ingest-cli.js";
import { parseCheckboxItems, parseListItems } from "./markdown-scanners.js";
import {
  fetchAllOpenIssues,
  fetchIssueStates,
  fetchOpenIssues,
  reconcileMain,
} from "./reconcile-issues.js";
import { mainEntry as reconcileCliMain } from "./reconcile-issues-cli.js";

function completed(stdout = "", stderr = "", returncode = 0): CompletedProcess {
  return { args: [], returncode, stdout, stderr };
}

function mkVbriefTree(root: string, specs: { folder: string; name: string; data: object }[]): void {
  for (const spec of specs) {
    const dir = join(root, "vbrief", spec.folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, spec.name), `${JSON.stringify(spec.data, null, 2)}\n`, "utf8");
  }
}

describe("intake cli and branch coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("cli mainEntry wrappers", () => {
    it("issue-ingest-cli parses all flags", () => {
      const dir = mkdtempSync(join(tmpdir(), "ingest-cli-"));
      const callSpy = vi.spyOn(scm, "call").mockImplementation((_s, verb) => {
        if (verb === "issue") {
          return completed('[{"number":2,"title":"Bulk","labels":[{"name":"x"}]}]', "", 0);
        }
        return completed("{}", "", 0);
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        ingestCliMain([
          "--all",
          "--dry-run",
          "--label",
          "x",
          "--status",
          "pending",
          "--vbrief-dir",
          dir,
          "--repo",
          "o/r",
          "--project-root",
          dir,
        ]),
      ).toBe(0);
      callSpy.mockRestore();
      stdout.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });

    it("reconcile-issues-cli parses flags", () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(reconcileCliMain(["--vbrief-dir", "/missing"])).toBe(1);
      stderr.mockRestore();
    });

    it("issue-emit-cli parses umbrella and per-vbrief flags", () => {
      const dir = mkdtempSync(join(tmpdir(), "emit-cli-flags-"));
      const path = join(dir, "solo.vbrief.json");
      writeVbrief(path, { plan: { title: "Solo" } });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        emitCliMain([
          path,
          "--umbrella",
          "--dry-run",
          "--json",
          "--title",
          "Umbrella title",
          "--repo",
          "o/r",
          "--project-root",
          dir,
        ]),
      ).toBe(0);
      expect(emitCliMain([path, "--per-vbrief", "--dry-run", "--project-root", dir])).toBe(0);
      stdout.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });

    it("github-body-cli parses flags", () => {
      expect(bodyCliMain(["nope", "--body-file", "-"])).toBe(1);
    });

    it("github-auth-modes-cli parses json flag", () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const code = authCliMain(["--json", "--github-auth-mode", "bogus"]);
      expect(code).toBe(1);
      stdout.mockRestore();
    });
  });

  describe("issue-ingest created path", () => {
    it("ingestOne writes file and issueIngestMain succeeds", () => {
      const dir = mkdtempSync(join(tmpdir(), "ingest-create-"));
      const issue = {
        number: 12,
        title: "Ship it",
        html_url: "https://github.com/o/r/issues/12",
        body: "## Acceptance Criteria\n1. done",
        labels: [{ name: "bug" }],
      };
      const [result, path] = ingestOne(issue, {
        vbriefDir: dir,
        status: "proposed",
        repoUrl: "https://github.com/o/r",
      });
      expect(result).toBe("created");
      expect(path).not.toBeNull();
      expect(readFileSync(path as string, "utf8")).toContain("Ship it");

      const callSpy = vi
        .spyOn(scm, "call")
        .mockImplementation(() => completed(JSON.stringify(issue), "", 0));
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        issueIngestMain({
          number: 12,
          vbriefDir: dir,
          repo: "o/r",
          projectRoot: dir,
        }),
      ).toBe(1);
      callSpy.mockRestore();
      stdout.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });

    it("buildIssueVbrief with body cross-refs", () => {
      const [vbrief] = buildIssueVbrief(
        {
          number: 3,
          title: "Cross",
          url: "https://github.com/o/r/issues/3",
          body: "See #4 and https://github.com/o/r/issues/5",
          labels: ["a"],
        },
        "pending",
        "https://github.com/o/r",
      );
      const refs = (vbrief.plan as Record<string, unknown>).references as unknown[];
      expect(refs.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(vbrief)).toContain("issues/3");
    });

    it("ingestSingleForAccept succeeds with stubbed fetch", () => {
      const root = mkdtempSync(join(tmpdir(), "accept-ok-"));
      mkdirSync(join(root, "vbrief"), { recursive: true });
      const callSpy = vi.spyOn(scm, "call").mockImplementation(() =>
        completed(
          JSON.stringify({
            number: 15,
            title: "Accept me",
            html_url: "https://github.com/o/r/issues/15",
            body: "",
            labels: [],
          }),
          "",
          0,
        ),
      );
      const [result, path] = ingestSingleForAccept(15, "o/r", { projectRoot: root });
      expect(result).toBe("created");
      expect(path).toContain("vbrief");
      callSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    });

    it("issueIngestMain --all dry-run bulk path", () => {
      const dir = mkdtempSync(join(tmpdir(), "ingest-all-"));
      const callSpy = vi.spyOn(scm, "call").mockImplementation((_s, verb) => {
        if (verb === "issue") {
          return completed('[{"number":8,"title":"Eight","labels":[]}]', "", 0);
        }
        return completed("{}", "", 0);
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        issueIngestMain({
          all: true,
          vbriefDir: dir,
          repo: "o/r",
          projectRoot: dir,
          dryRun: true,
        }),
      ).toBe(0);
      callSpy.mockRestore();
      stdout.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });

    it("fetchIssue uses scm when cache misses", () => {
      const callSpy = vi
        .spyOn(scm, "call")
        .mockImplementation(() =>
          completed(
            JSON.stringify({ number: 1, html_url: "https://github.com/o/r/issues/1" }),
            "",
            0,
          ),
        );
      const issue = fetchIssue("o/r", 1, { cacheRoot: "/nonexistent-cache-root" });
      expect(issue?.number).toBe(1);
      callSpy.mockRestore();
    });
  });

  describe("issue-emit modes", () => {
    it("emitUmbrella creates umbrella issue and updates children", () => {
      const dir = mkdtempSync(join(tmpdir(), "umbrella-"));
      const a = join(dir, "a.vbrief.json");
      const b = join(dir, "b.vbrief.json");
      writeVbrief(a, { plan: { title: "Child A" } });
      writeVbrief(b, { plan: { title: "Child B" } });
      const scmCall = () => completed("https://github.com/o/r/issues/100\n", "", 0);
      const action = emitUmbrella([a, b], { repo: "o/r", scmCall, displayPaths: ["a", "b"] });
      expect(action.result).toBe("created");
      expect(existingGithubIssueRef(loadVbrief(a))).toBeTruthy();
      expect(renderUmbrellaBody([["a", loadVbrief(a)]])).toContain("Child A");

      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        issueEmitMain({
          patterns: [a, b],
          projectRoot: dir,
          umbrella: true,
          dryRun: true,
        }),
      ).toBe(0);
      stdout.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });

    it("issueEmitMain per-vbrief and title guard", () => {
      const dir = mkdtempSync(join(tmpdir(), "per-vb-"));
      const path = join(dir, "one.vbrief.json");
      writeVbrief(path, { plan: { title: "One" } });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(issueEmitMain({ patterns: [path], projectRoot: dir, title: "Bad" })).toBe(2);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        issueEmitMain({
          patterns: [path],
          projectRoot: dir,
          perVbrief: true,
          dryRun: true,
        }),
      ).toBe(0);
      stdout.mockRestore();
      stderr.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("reconcile main paths", () => {
    it("reconcileMain markdown output with stubbed gh", () => {
      const root = mkdtempSync(join(tmpdir(), "reconcile-main-"));
      mkVbriefTree(root, [
        {
          folder: "active",
          name: "linked.vbrief.json",
          data: {
            plan: {
              references: [
                { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/7" },
              ],
            },
          },
        },
      ]);
      const callSpy = vi.spyOn(scm, "call").mockImplementation((_src, _verb, args) => {
        if (args[0] === "graphql") {
          return completed(
            JSON.stringify({
              data: { repository: { i7: { state: "OPEN", stateReason: null } } },
            }),
            "",
            0,
          );
        }
        return completed("[]", "", 0);
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        reconcileMain({
          vbriefDir: join(root, "vbrief"),
          repo: "o/r",
          projectRoot: root,
          format: "json",
        }),
      ).toBe(0);
      callSpy.mockRestore();
      stdout.mockRestore();
      rmSync(root, { recursive: true, force: true });
    });

    it("fetchOpenIssues and fetchAllOpenIssues parse list output", () => {
      const list = JSON.stringify([{ number: 1, title: "Open", url: "u" }]);
      const issues = fetchOpenIssues("o/r", {
        scmCall: () => completed(list, "", 0),
      });
      expect(issues).toHaveLength(1);
      const all = fetchAllOpenIssues("o/r", {
        scmCall: () => completed(list, "", 0),
      });
      expect(all?.[0]?.number).toBe(1);
    });

    it("fetchIssueStates handles graphql partial errors", () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const states = fetchIssueStates("o/r", new Set([9]), {
        scmCall: () =>
          completed(
            JSON.stringify({
              data: { repository: { i9: { state: "CLOSED", stateReason: "COMPLETED" } } },
            }),
            "partial error line",
            1,
          ),
      });
      expect(states?.get(9)?.value).toBe("CLOSED");
      stderr.mockRestore();
    });

    it("reconcileCliMain report-unlinked path", () => {
      const root = mkdtempSync(join(tmpdir(), "reconcile-cli-"));
      mkdirSync(join(root, "vbrief", "proposed"), { recursive: true });
      const callSpy = vi.spyOn(scm, "call").mockImplementation((_src, verb, args) => {
        if (verb === "issue") {
          return completed("[]", "", 0);
        }
        if (args[0] === "graphql") {
          return completed(JSON.stringify({ data: { repository: {} } }), "", 0);
        }
        return completed("{}", "", 0);
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        reconcileCliMain([
          "--vbrief-dir",
          join(root, "vbrief"),
          "--repo",
          "o/r",
          "--project-root",
          root,
          "--report-unlinked",
        ]),
      ).toBe(0);
      callSpy.mockRestore();
      stdout.mockRestore();
      rmSync(root, { recursive: true, force: true });
    });

    it("reconcileCliMain apply-lifecycle-fixes fails when target exists", () => {
      const root = mkdtempSync(join(tmpdir(), "reconcile-fail-"));
      const name = "child.vbrief.json";
      const data = {
        plan: {
          planRef: "#55",
          status: "running",
          items: [],
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/55" }],
        },
      };
      mkVbriefTree(root, [{ folder: "active", name, data }]);
      mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
      writeFileSync(join(root, "vbrief", "completed", name), "{}", "utf8");

      const callSpy = vi.spyOn(scm, "call").mockImplementation((_src, _verb, args) => {
        if (args[0] === "graphql") {
          return completed(
            JSON.stringify({
              data: {
                repository: {
                  i55: { state: "CLOSED", stateReason: "COMPLETED" },
                },
              },
            }),
            "",
            0,
          );
        }
        return completed("[]", "", 0);
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        reconcileCliMain([
          "--vbrief-dir",
          join(root, "vbrief"),
          "--repo",
          "o/r",
          "--project-root",
          root,
          "--apply-lifecycle-fixes",
        ]),
      ).toBe(1);
      callSpy.mockRestore();
      stderr.mockRestore();
      stdout.mockRestore();
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("github-auth and github-body branches", () => {
    it("validateGithubAuth rejects unknown mode", () => {
      const result = validateGithubAuth("not-a-mode");
      expect(result.failureKind).toBe(FAILURE_INVALID_MODE);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(githubAuthModesMain({ githubAuthMode: "not-a-mode" })).toBe(1);
      stdout.mockRestore();
      stderr.mockRestore();
    });

    it("githubBodyMain issue-create and createIssue readback", () => {
      const callSpy = vi
        .spyOn(scm, "call")
        .mockImplementation(() => completed(JSON.stringify({ number: 9, body: "created" }), "", 0));
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        githubBodyMain({
          command: "issue-create",
          repo: "o/r",
          title: "New",
          bodyFile: "-",
        }),
      ).toBe(0);
      const runFn = (args: readonly string[]) =>
        args.includes("--method") ? { number: 11 } : { number: 11, body: "b" };
      expect(createIssue("o/r", { title: "t", body: "b", runFn, binary: "gh" }).number).toBe(11);
      callSpy.mockRestore();
      stdout.mockRestore();
    });
  });

  describe("candidates-log read paths", () => {
    it("readAll skips malformed lines and findByIssue works", () => {
      const dir = mkdtempSync(join(tmpdir(), "cand-read-"));
      const log = join(dir, "candidates.jsonl");
      writeFileSync(log, "not-json\n[]\n", "utf8");
      const warnings: string[] = [];
      expect(
        readAll("deftai/directive", { path: log, warn: (m) => warnings.push(m) }),
      ).toHaveLength(0);
      expect(warnings.length).toBeGreaterThan(0);

      const entry = {
        decision_id: newDecisionId(),
        timestamp: "2026-05-03T16:32:54Z",
        repo: "deftai/directive",
        issue_number: 42,
        decision: "accept",
        actor: "tester",
      };
      append(entry, { path: log });
      expect(findByIssue(42, "deftai/directive", { path: log })).toHaveLength(1);
      expect(latestDecision(42, "deftai/directive", { path: log })?.decision).toBe("accept");
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("markdown-scanners edge branches", () => {
    it("ignores invalid checkbox markers and plus-list items", () => {
      expect(parseCheckboxItems("* [?] bad\n")).toEqual([]);
      expect(parseListItems("+ item\n")).toEqual([{ title: "item", status: "proposed" }]);
    });
  });
});
