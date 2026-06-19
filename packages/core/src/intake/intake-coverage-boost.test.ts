import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompletedProcess } from "../scm/call.js";
import * as scm from "../scm/call.js";
import {
  append,
  CandidatesLogError,
  newDecisionId,
  readAll,
  validateCandidatesEntry,
} from "./candidates-log.js";
import {
  FAILURE_API_UNREACHABLE,
  FAILURE_GH_AUTH,
  FAILURE_MISSING_INJECTED_TOKEN,
  FAILURE_REPO_ACCESS,
  githubAuthModesMain,
  inferGithubAuthMode,
  resultToDict,
  validateGithubAuthForWorker,
  validateHostGhMode,
  validateInjectedTokenMode,
} from "./github-auth-modes.js";
import {
  createIssueComment,
  editIssueBody,
  editIssueCommentBody,
  editPrBody,
  GitHubBodyError,
  githubBodyMain,
  readBody,
} from "./github-body.js";
import {
  displayPath,
  emitPerVbrief,
  emitSingle,
  emitUmbrella,
  expandPatterns,
  fileIssue,
  IssueEmitError,
  isNoNetwork,
  issueEmitMain,
  renderIssueBody,
  writeVbrief,
} from "./issue-emit.js";
import {
  bodyControlCharacterLabels,
  buildIssueVbrief,
  extractAcSectionItems,
  fetchSingleIssue,
  ingestBulk,
  ingestOne,
  ingestSingleForAccept,
  issueIngestMain,
  provenanceIssueNumber,
  resolveRepoUrl,
  scanProvenanceRefs,
  targetFilename,
  warnBodyControlCharacters,
} from "./issue-ingest.js";
import {
  findAcHeading,
  parseCheckboxItems,
  parseListItems,
  sliceAcSection,
  stripCodeBlocks,
} from "./markdown-scanners.js";
import {
  probeRuntimeCapabilities,
  RUNTIME_MODE_CLOUD_HEADLESS,
  RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
  RUNTIME_MODE_LOCAL_UNSANDBOXED,
} from "./platform-capabilities.js";
import {
  applyLifecycleFixes,
  buildLifecycleReport,
  detectRepo,
  fetchIssueStates,
  formatJson,
  formatMarkdown,
  IssueState,
  parseDecompositionOrigin,
  parseParentIssue,
  parsePlanRef,
  reconcile,
  reconcileMain,
  reconcileWithUnlinked,
  resolveLifecycleAnchor,
  scanLifecycleAnchors,
  scanVbriefDir,
  stateReasonOf,
} from "./reconcile-issues.js";

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

function ghRunner(responses: Record<string, CompletedProcess>) {
  return (args: readonly string[], _env: NodeJS.ProcessEnv): CompletedProcess => {
    const key = args.join("|");
    if (responses[key]) {
      return responses[key];
    }
    if (args[0] === "auth" && args[1] === "status") {
      return responses.auth ?? completed();
    }
    if (args[0] === "api" && args[1] === "user") {
      return responses.user ?? completed('"octo"');
    }
    if (args[0] === "api" && args[1]?.startsWith("repos/")) {
      return responses.repo ?? completed("{}");
    }
    return completed("", `unexpected: ${key}`, 1);
  };
}

describe("intake coverage boost", () => {
  describe("markdown-scanners", () => {
    it("strips tilde fences and numbered lists", () => {
      const body = "~~~\nCloses #1\n~~~\n* item one\n1. numbered";
      expect(stripCodeBlocks(body)).not.toContain("Closes");
      const heading = findAcHeading("## Acceptance Criteria\n1. first\n## Next");
      expect(heading).not.toBeNull();
      if (heading) {
        const section = sliceAcSection("## Acceptance Criteria\n1. first\n## Next", heading);
        expect(parseListItems(section)).toEqual([{ title: "first", status: "proposed" }]);
      }
    });

    it("parses checkbox variants and dedupes", () => {
      const text = "* [x] done\n+ [ ] todo\n* [x] done\n";
      expect(parseCheckboxItems(text)).toEqual([
        { title: "done", status: "completed" },
        { title: "todo", status: "proposed" },
      ]);
    });
  });

  describe("issue-ingest", () => {
    it("warns on control characters and extracts AC section", () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      warnBodyControlCharacters(1, "hello\vworld");
      expect(stderr).toHaveBeenCalled();
      stderr.mockRestore();
      expect(bodyControlCharacterLabels("\v")).toContain("U+000B vertical tab");
      const items = extractAcSectionItems(
        "## Acceptance criteria\n1. latency ok\n2. [x] shipped\n",
      );
      expect(items[1]?.status).toBe("completed");
    });

    it("builds vbrief without body and resolves provenance", () => {
      const [vbrief, folder] = buildIssueVbrief(
        { number: 9, title: "T", url: "", body: "", labels: [] },
        "pending",
        "",
      );
      expect(folder).toBe("pending");
      expect(vbrief.plan).toBeDefined();
      expect(
        provenanceIssueNumber({
          vBRIEFInfo: { description: "Scope vBRIEF ingested from GitHub issue #77" },
        }),
      ).toBe(77);
    });

    it("ingestOne handles duplicate and dry-run", () => {
      const dir = mkdtempSync(join(tmpdir(), "ingest-"));
      const refs = new Map<number, string[]>([[5, ["proposed/existing.vbrief.json"]]]);
      const [dup] = ingestOne(
        { number: 5, title: "Dup", url: "https://github.com/o/r/issues/5" },
        {
          vbriefDir: dir,
          status: "proposed",
          repoUrl: "https://github.com/o/r",
          existingRefs: refs,
        },
      );
      expect(dup).toBe("duplicate");
      const [dry] = ingestOne(
        { number: 6, title: "New", url: "https://github.com/o/r/issues/6" },
        { vbriefDir: dir, status: "proposed", repoUrl: "https://github.com/o/r", dryRun: true },
      );
      expect(dry).toBe("dryrun");
      rmSync(dir, { recursive: true, force: true });
    });

    it("ingestBulk filters by label", () => {
      const dir = mkdtempSync(join(tmpdir(), "bulk-"));
      const summary = ingestBulk(
        [
          { number: 1, title: "A", labels: [{ name: "bug" }] },
          { number: 2, title: "B", labels: [{ name: "feat" }] },
        ],
        {
          vbriefDir: dir,
          status: "proposed",
          repoUrl: "https://github.com/o/r",
          label: "bug",
          dryRun: true,
        },
      );
      expect(summary.total).toBe(1);
      rmSync(dir, { recursive: true, force: true });
    });

    it("fetchSingleIssue handles scm failures", () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const bad = fetchSingleIssue("o/r", 1, {
        scmCall: () => completed("err", "", 1),
      });
      expect(bad).toBeNull();
      const parsed = fetchSingleIssue("o/r", 2, {
        scmCall: () => completed("not-json", "", 0),
      });
      expect(parsed).toBeNull();
      stderr.mockRestore();
    });

    it("scanProvenanceRefs and resolveRepoUrl", () => {
      const root = mkdtempSync(join(tmpdir(), "scan-prov-"));
      mkVbriefTree(root, [
        {
          folder: "proposed",
          name: "a.vbrief.json",
          data: {
            plan: {
              narratives: { Origin: "Ingested from https://github.com/o/r/issues/10" },
              references: [
                { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/10" },
              ],
            },
          },
        },
      ]);
      const refs = scanProvenanceRefs(join(root, "vbrief"));
      expect(refs.get(10)).toEqual(["proposed/a.vbrief.json"]);
      expect(resolveRepoUrl("o/r")).toBe("https://github.com/o/r");
      expect(resolveRepoUrl("https://github.com/o/r/")).toBe("https://github.com/o/r");
      expect(targetFilename(3, "Hello World")).toMatch(/-3-hello-world\.vbrief\.json$/);
      rmSync(root, { recursive: true, force: true });
    });

    it("issueIngestMain errors without repo", () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const dir = mkdtempSync(join(tmpdir(), "cli-ingest-"));
      const code = issueIngestMain({ vbriefDir: dir, projectRoot: dir });
      expect(code).toBe(2);
      stderr.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });

    it("ingestSingleForAccept throws on fetch failure", () => {
      const root = mkdtempSync(join(tmpdir(), "accept-"));
      mkdirSync(join(root, "vbrief"), { recursive: true });
      expect(() =>
        ingestSingleForAccept(9, "o/r", {
          projectRoot: root,
          cacheRoot: join(root, "missing-cache"),
        }),
      ).toThrow(/failed to fetch/);
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("reconcile-issues", () => {
    it("fetchIssueStates handles graphql success and not-found", () => {
      const payload = {
        data: {
          repository: {
            i1: { state: "OPEN", stateReason: null },
            i2: null,
          },
        },
      };
      const states = fetchIssueStates("o/r", new Set([1, 2]), {
        scmCall: () => completed(JSON.stringify(payload), "", 0),
      });
      expect(states?.get(1)?.value).toBe("OPEN");
      expect(states?.get(2)?.value).toBe("NOT_FOUND");
    });

    it("fetchIssueStates rejects invalid repo slug", () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(fetchIssueStates("bad", new Set([1]))).toBeNull();
      stderr.mockRestore();
    });

    it("reconcile and reconcileWithUnlinked classify issues", () => {
      const map = new Map<number, string[]>([
        [1, ["active/a.vbrief.json"]],
        [2, ["active/b.vbrief.json"]],
      ]);
      const states = new Map<number, IssueState>([
        [1, new IssueState("OPEN")],
        [2, new IssueState("CLOSED", "COMPLETED")],
      ]);
      const report = reconcile(map, states);
      expect(report.summary.linked_count).toBe(1);
      expect(report.no_open_issue[0]?.state_reason).toBe("COMPLETED");
      const legacy = reconcileWithUnlinked(map, [
        { number: 1, title: "Open", url: "u" },
        { number: 3, title: "Unlinked", url: "u2" },
      ]);
      expect(legacy.unlinked).toHaveLength(1);
      expect(formatJson(legacy)).toContain("unlinked");
      expect(formatMarkdown(legacy)).toContain("## (b)");
    });

    it("lifecycle anchors and apply fixes", () => {
      const root = mkdtempSync(join(tmpdir(), "reconcile-fix-"));
      mkVbriefTree(root, [
        {
          folder: "active",
          name: "child.vbrief.json",
          data: {
            plan: {
              planRef: "#55",
              status: "running",
              items: [
                { title: "t", status: "proposed", subItems: [{ title: "s", status: "pending" }] },
              ],
              references: [
                { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/55" },
              ],
            },
          },
        },
      ]);
      expect(parsePlanRef({ plan: { planRef: "#55" } })).toBe(55);
      expect(
        parseParentIssue({
          plan: { metadata: { "x-tracking": { parent_issue: "#77" } } },
        }),
      ).toBe(77);
      expect(
        parseDecompositionOrigin({
          plan: {
            metadata: {
              "x-tracking": { decomposition_origin: "https://github.com/o/r/issues/99" },
            },
          },
        }),
      ).toBe(99);
      const [num, axis] = resolveLifecycleAnchor({
        plan: {
          metadata: { "x-tracking": { parent_issue: "#88", decomposition_origin: "#99" } },
          references: [
            { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/99" },
            { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/88" },
          ],
        },
      });
      expect(num).toBe(88);
      expect(axis).toBe("parent_issue");

      const anchors = scanLifecycleAnchors(join(root, "vbrief"));
      expect(anchors).toHaveLength(1);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const applyReport = buildLifecycleReport(
        anchors,
        new Map([[55, new IssueState("CLOSED", "NOT_PLANNED")]]),
      );
      const [moved, skipped, failures] = applyLifecycleFixes(
        join(root, "vbrief"),
        applyReport,
        root,
      );
      expect(moved).toBe(1);
      expect(skipped).toBe(0);
      expect(failures).toHaveLength(0);
      expect(existsSync(join(root, "vbrief", "cancelled", "child.vbrief.json"))).toBe(true);
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    });

    it("scanVbriefDir indexes references", () => {
      const root = mkdtempSync(join(tmpdir(), "scan-vbrief-"));
      mkVbriefTree(root, [
        {
          folder: "proposed",
          name: "x.vbrief.json",
          data: {
            plan: {
              references: [
                { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/42" },
              ],
            },
          },
        },
      ]);
      const map = scanVbriefDir(join(root, "vbrief"));
      expect(map.get(42)).toEqual(["proposed/x.vbrief.json"]);
      rmSync(root, { recursive: true, force: true });
    });

    it("stateReasonOf and detectRepo", () => {
      expect(stateReasonOf(new IssueState("CLOSED", "DUPLICATE"))).toBe("DUPLICATE");
      expect(stateReasonOf("OPEN")).toBeNull();
      const repo = detectRepo();
      expect(repo === null || repo.includes("/")).toBe(true);
    });

    it("reconcileMain missing vbrief dir", () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(reconcileMain({ vbriefDir: "/nonexistent-vbrief-xyz" })).toBe(1);
      stderr.mockRestore();
    });
  });

  describe("issue-emit", () => {
    it("renderIssueBody fallback and emit paths", () => {
      expect(renderIssueBody({})).toContain("Scope vBRIEF");
      const dir = mkdtempSync(join(tmpdir(), "emit-"));
      const path = join(dir, "one.vbrief.json");
      writeVbrief(path, {
        plan: {
          title: "Emit me",
          references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
        },
      });
      const skipped = emitSingle(path, { repo: "o/r", noNetwork: false });
      expect(skipped.result).toBe("skipped");
      writeVbrief(join(dir, "two.vbrief.json"), { plan: { title: "Dry" } });
      const dry = emitSingle(join(dir, "two.vbrief.json"), { repo: "o/r", noNetwork: true });
      expect(dry.result).toBe("dryrun");
      const umbrella = emitUmbrella([join(dir, "two.vbrief.json")], {
        repo: "o/r",
        noNetwork: true,
        displayPaths: ["two.vbrief.json"],
      });
      expect(umbrella.result).toBe("dryrun");
      rmSync(dir, { recursive: true, force: true });
    });

    it("fileIssue and emitPerVbrief with stub scm", () => {
      const dir = mkdtempSync(join(tmpdir(), "emit-file-"));
      const path = join(dir, "fresh.vbrief.json");
      writeVbrief(path, { plan: { title: "Fresh" } });
      const scmCall = () => completed("https://github.com/o/r/issues/42\n", "", 0);
      const created = emitSingle(path, { repo: "o/r", scmCall });
      expect(created.result).toBe("created");
      expect(created.url).toContain("/issues/42");
      const actions = emitPerVbrief([path], { repo: "o/r", scmCall });
      expect(actions[0]?.result).toBe("skipped");
      expect(() => fileIssue("o/r", "t", "b", () => completed("", "fail", 1))).toThrow(
        IssueEmitError,
      );
      rmSync(dir, { recursive: true, force: true });
    });

    it("expandPatterns displayPath isNoNetwork issueEmitMain", () => {
      const dir = mkdtempSync(join(tmpdir(), "emit-cli-"));
      const vpath = join(dir, "solo.vbrief.json");
      writeVbrief(vpath, { plan: { title: "Solo" } });
      const matches = expandPatterns([vpath], dir);
      expect(matches).toHaveLength(1);
      expect(displayPath(vpath, dir)).toBe("solo.vbrief.json");
      const prev = process.env.DEFT_NO_NETWORK;
      process.env.DEFT_NO_NETWORK = "1";
      expect(isNoNetwork(false)).toBe(true);
      process.env.DEFT_NO_NETWORK = prev;
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(issueEmitMain({ patterns: [], projectRoot: dir })).toBe(2);
      writeVbrief(join(dir, "other.vbrief.json"), { plan: { title: "Other" } });
      expect(
        issueEmitMain({
          patterns: [join(dir, "*.vbrief.json")],
          projectRoot: dir,
          dryRun: true,
        }),
      ).toBe(2);
      stderr.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("github-body", () => {
    const runFn = (args: readonly string[], _input?: string) => {
      if (args.includes("--method")) {
        return { number: 7, id: 99 };
      }
      return { number: 7, body: "ok", id: 99 };
    };

    it("mutations round-trip via runFn seam", () => {
      expect(editIssueBody("o/r", 7, { body: "b", runFn, binary: "gh" }).body).toBe("ok");
      expect(createIssueComment("o/r", 7, { body: "c", runFn, binary: "gh" }).id).toBe(99);
      expect(editIssueCommentBody("o/r", 99, { body: "d", runFn, binary: "gh" }).id).toBe(99);
      expect(editPrBody("o/r", 3, { body: "e", runFn, binary: "gh" }).body).toBe("ok");
    });

    it("readBody and githubBodyMain", () => {
      const dir = mkdtempSync(join(tmpdir(), "gh-body-"));
      const bodyPath = join(dir, "body.md");
      writeFileSync(bodyPath, "hello", "utf8");
      expect(readBody(bodyPath)).toBe("hello");
      expect(readBody("-", "stdin")).toBe("stdin");
      const callSpy = vi
        .spyOn(scm, "call")
        .mockImplementation(() =>
          completed(JSON.stringify({ number: 1, body: "ok", id: 99 }), "", 0),
        );
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(
          githubBodyMain({
            command: "issue-edit",
            repo: "o/r",
            issue: 1,
            bodyFile: bodyPath,
          }),
        ).toBe(0);
        expect(
          githubBodyMain({
            command: "comment-create",
            repo: "o/r",
            issue: 1,
            bodyFile: "-",
          }),
        ).toBe(0);
        expect(githubBodyMain({ command: "nope", bodyFile: "-" })).toBe(1);
        expect(() => readBody(join(dir, "missing.md"))).toThrow();
      } finally {
        callSpy.mockRestore();
        stdout.mockRestore();
        stderr.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("splitRepo invalid repo raises", () => {
      expect(() => editIssueBody("bad", 1, { body: "x", runFn: () => ({}) })).toThrow(
        GitHubBodyError,
      );
    });
  });

  describe("github-auth-modes", () => {
    it("injected-token failure paths", () => {
      expect(
        validateInjectedTokenMode({}, { runtimeMode: RUNTIME_MODE_CLOUD_HEADLESS }).failureKind,
      ).toBe(FAILURE_MISSING_INJECTED_TOKEN);
      const runner = ghRunner({
        auth: completed("", "auth fail", 1),
        user: completed("", "", 1),
        repo: completed("", "", 1),
      });
      expect(validateInjectedTokenMode({ GH_TOKEN: "x" }, { runGh: runner }).failureKind).toBe(
        FAILURE_GH_AUTH,
      );
      const runner2 = ghRunner({
        auth: completed(),
        user: completed("", "", 1),
      });
      expect(validateInjectedTokenMode({ GH_TOKEN: "x" }, { runGh: runner2 }).failureKind).toBe(
        FAILURE_API_UNREACHABLE,
      );
      const runner3 = ghRunner({
        auth: completed(),
        user: completed('"bot"'),
        repo: completed("", "denied", 403),
      });
      expect(validateInjectedTokenMode({ GH_TOKEN: "x" }, { runGh: runner3 }).failureKind).toBe(
        FAILURE_REPO_ACCESS,
      );
    });

    it("host-gh failure and success paths", () => {
      const failAuth = validateHostGhMode(
        {},
        {
          runGh: ghRunner({ auth: completed("", "nope", 1) }),
          runtimeMode: RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
        },
      );
      expect(failAuth.failureKind).toBe(FAILURE_GH_AUTH);
      expect(failAuth.remediation).toContain("Remediation");
      const ok = validateHostGhMode(
        {},
        {
          runGh: ghRunner({
            auth: completed(),
            user: completed('"octo"'),
            repo: completed("{}"),
          }),
        },
      );
      expect(ok.ok).toBe(true);
      expect(inferGithubAuthMode({ runtimeMode: RUNTIME_MODE_LOCAL_UNSANDBOXED })).toBe("host-gh");
    });

    it("validateGithubAuthForWorker and CLI output", () => {
      const result = validateGithubAuthForWorker("host-gh", {
        runGh: ghRunner({
          auth: completed(),
          user: completed('"octo"'),
          repo: completed("{}"),
        }),
        runtimeReport: { runtimeMode: RUNTIME_MODE_LOCAL_UNSANDBOXED },
      });
      expect(resultToDict(result).ok).toBe(true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      // githubAuthModesMain shells out to the real `gh` (no injectable runner), so its
      // exit code depends on the host's auth state (0 authenticated / 1 not). Assert it
      // returns a valid exit code while exercising both the JSON and text output branches
      // so the test stays hermetic across local (authed) and CI (unauthed) environments.
      const jsonExit = githubAuthModesMain({ githubAuthMode: "host-gh", json: true });
      expect([0, 1]).toContain(jsonExit);
      const textExit = githubAuthModesMain({ githubAuthMode: "host-gh", json: false });
      expect([0, 1]).toContain(textExit);
      expect(stdout).toHaveBeenCalled();
      stdout.mockRestore();
    });
  });

  describe("candidates-log validation", () => {
    it("rejects conditional and shape violations", () => {
      const base = {
        decision_id: newDecisionId(),
        timestamp: "2026-05-03T16:32:54Z",
        repo: "deftai/directive",
        issue_number: 1,
        decision: "accept",
        actor: "a",
      };
      expect(() => validateCandidatesEntry({})).toThrow(CandidatesLogError);
      expect(() => validateCandidatesEntry({ ...base, timestamp: "bad" })).toThrow(
        CandidatesLogError,
      );
      expect(() => validateCandidatesEntry({ ...base, decision: "mark-duplicate" })).toThrow(
        CandidatesLogError,
      );
      expect(() =>
        validateCandidatesEntry({
          ...base,
          decision: "mark-duplicate",
          linked_to: 2,
          extra: "x",
        }),
      ).toThrow(CandidatesLogError);
      expect(() =>
        validateCandidatesEntry({
          ...base,
          decision: "reset",
        }),
      ).toThrow(CandidatesLogError);
      expect(() =>
        validateCandidatesEntry({
          ...base,
          decision: "accept",
          prior_decision_id: newDecisionId(),
        }),
      ).toThrow(CandidatesLogError);
      expect(() =>
        validateCandidatesEntry({
          ...base,
          decision: "resume-eligible",
          prior_decision_id: "not-uuid",
        }),
      ).toThrow(CandidatesLogError);
    });

    it("readAll filters by repo", () => {
      const dir = mkdtempSync(join(tmpdir(), "cand-repo-"));
      const log = join(dir, "candidates.jsonl");
      append(
        {
          decision_id: newDecisionId(),
          timestamp: "2026-05-03T16:32:54Z",
          repo: "other/repo",
          issue_number: 1,
          decision: "accept",
          actor: "a",
        },
        { path: log },
      );
      expect(readAll("deftai/directive", { path: log })).toHaveLength(0);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("platform-capabilities", () => {
    it("classifies runtime modes from env", () => {
      expect(probeRuntimeCapabilities({ CI: "true" }).runtimeMode).toBe(
        RUNTIME_MODE_CLOUD_HEADLESS,
      );
      expect(probeRuntimeCapabilities({ CURSOR_SANDBOX: "1" }).runtimeMode).toBe(
        RUNTIME_MODE_CURSOR_NATIVE_SANDBOX,
      );
      expect(probeRuntimeCapabilities({}).runtimeMode).toBe(RUNTIME_MODE_LOCAL_UNSANDBOXED);
    });
  });
});
