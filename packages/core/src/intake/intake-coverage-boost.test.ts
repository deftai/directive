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
  type RunGhApiFn,
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
  attachIssueCommentThread,
  bodyControlCharacterLabels,
  buildIssueVbrief,
  composeOverviewWithComments,
  extractAcSectionItems,
  fetchIssue,
  fetchIssueComments,
  fetchSingleIssue,
  ISSUE_COMMENT_THREAD_KEY,
  ingestBulk,
  ingestOne,
  ingestSingleForAccept,
  issueCommentThread,
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
  attachCompletedStatusDrift,
  buildLifecycleReport,
  detectRepo,
  extractReferencesFromVbrief,
  fetchIssueStates,
  formatJson,
  formatMarkdown,
  IssueState,
  parseDecompositionOrigin,
  parseIssueNumber,
  parseParentIssue,
  parsePlanRef,
  reconcile,
  reconcileMain,
  reconcileWithUnlinked,
  repairCompletedStatusDrift,
  resolveLifecycleAnchor,
  scanCompletedStatusDrift,
  scanLifecycleAnchors,
  scanVbriefDir,
  stateReasonOf,
} from "./reconcile-issues.js";

function completed(stdout = "", stderr = "", returncode = 0): CompletedProcess {
  return { args: [], returncode, stdout, stderr };
}

function mkVbriefTree(root: string, specs: { folder: string; name: string; data: object }[]): void {
  for (const spec of specs) {
    const dir = join(root, "xbrief", spec.folder);
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

    it("folds comment thread into overview so corrections supersede body-only fetch (#2143)", () => {
      const bodyFix = "Use `pnpm -r run build` / `--filter @deftai/directive build`.";
      const commentFix =
        "Do NOT use pnpm -r run build for vendored deposits. Route through `:engine:_ts-build` + `:engine:invoke` instead.";
      const issue = attachIssueCommentThread(
        { number: 2126, title: "Vendored build", body: bodyFix, labels: [] },
        [{ user: { login: "maintainer" }, body: commentFix, created_at: "2026-07-01T12:00:00Z" }],
      );
      const [vbrief] = buildIssueVbrief(issue, "proposed", "https://github.com/deftai/directive");
      const overview = String(
        (vbrief.plan as Record<string, unknown>).narratives &&
          ((vbrief.plan as Record<string, unknown>).narratives as Record<string, string>).Overview,
      );
      expect(overview).toContain(bodyFix);
      expect(overview).toContain("Issue comment thread");
      expect(overview).toContain(":engine:_ts-build");
      expect(overview).toContain(commentFix);
      expect(issueCommentThread(issue)).toHaveLength(1);
      expect(composeOverviewWithComments("", [{ body: "only comment" }])).toContain("only comment");
    });

    it("fetchIssue attaches comment thread from scm", () => {
      const scmCall = vi.fn((_source: string, _verb: string, args: readonly string[]) => {
        if (args[0] === "repos/o/r/issues/99/comments") {
          return completed(
            JSON.stringify([
              {
                body: "Correct fix Y",
                user: { login: "bot" },
                created_at: "2026-07-01T00:00:00Z",
              },
            ]),
          );
        }
        if (args[0] === "repos/o/r/issues/1/comments") {
          return completed("[]");
        }
        return completed(
          JSON.stringify({
            number: 99,
            title: "Issue",
            body: "Wrong fix X",
            html_url: "https://github.com/o/r/issues/99",
          }),
        );
      });
      expect(fetchIssueComments("o/r", 1, { scmCall })).toEqual([]);
      const enriched = fetchIssue("o/r", 99, { scmCall });
      expect(enriched?.[ISSUE_COMMENT_THREAD_KEY]).toHaveLength(1);
      expect(String(enriched?.body ?? "")).toContain("Wrong fix X");
    });

    it("ingestOne handles duplicate and dry-run", () => {
      const dir = mkdtempSync(join(tmpdir(), "ingest-"));
      const refs = new Map<number, string[]>([[5, ["proposed/existing.xbrief.json"]]]);
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
      expect(summary.notices).toEqual([]);
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
          name: "a.xbrief.json",
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
      const refs = scanProvenanceRefs(join(root, "xbrief"));
      expect(refs.get(10)).toEqual(["proposed/a.xbrief.json"]);
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
      mkdirSync(join(root, "xbrief"), { recursive: true });
      writeFileSync(join(root, "xbrief", "seed.xbrief.json"), "{}", { encoding: "utf8" });
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
    it("fetchIssueStates handles REST success and not-found", () => {
      const states = fetchIssueStates("o/r", new Set([1, 2]), {
        scmCall: (_src, verb, args) => {
          expect(verb).toBe("api");
          const path = args?.[0];
          if (path === "repos/o/r/issues/1") {
            return completed(JSON.stringify({ state: "open", state_reason: null }), "", 0);
          }
          if (path === "repos/o/r/issues/2") {
            return completed("", "gh: Not Found (HTTP 404)", 1);
          }
          throw new Error(`unexpected REST path: ${String(path)}`);
        },
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
        [1, ["active/a.xbrief.json"]],
        [2, ["active/b.xbrief.json"]],
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
          name: "child.xbrief.json",
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

      const anchors = scanLifecycleAnchors(join(root, "xbrief"));
      expect(anchors).toHaveLength(1);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const applyReport = buildLifecycleReport(
        anchors,
        new Map([[55, new IssueState("CLOSED", "NOT_PLANNED")]]),
      );
      const [moved, skipped, failures] = applyLifecycleFixes(
        join(root, "xbrief"),
        applyReport,
        root,
      );
      expect(moved).toBe(1);
      expect(skipped).toBe(0);
      expect(failures).toHaveLength(0);
      expect(existsSync(join(root, "xbrief", "cancelled", "child.xbrief.json"))).toBe(true);
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    });

    it("formatMarkdown renders populated and empty sections", () => {
      const populated = formatMarkdown({
        linked: [{ issue_number: 1, title: "Linked", vbrief_files: ["active/a.xbrief.json"] }],
        no_open_issue: [
          {
            issue_number: 2,
            vbrief_files: ["proposed/b.xbrief.json"],
            note: "closed",
            state_reason: "COMPLETED",
          },
        ],
        unlinked: [{ issue_number: 3, title: "Orphan" }],
        completed_status_drift: [
          { rel_path: "completed/bad.xbrief.json", status: "running\nline" },
        ],
        summary: {
          linked_count: 1,
          vbriefs_no_open_issue_count: 1,
          total_open_issues: 5,
          unlinked_count: 1,
        },
      });
      expect(populated).toContain("Open issues");
      expect(populated).toContain("Unlinked");
      expect(populated).toContain("#1 Linked");
      expect(populated).toContain("#3 Orphan");
      expect(populated).toContain("D2 drift");
      expect(populated).toContain("running line");

      const empty = formatMarkdown({
        linked: [],
        no_open_issue: [],
        unlinked: [],
        summary: {
          linked_count: 0,
          vbriefs_no_open_issue_count: 0,
          total_open_issues: 0,
          unlinked_count: 0,
        },
      });
      expect(empty.match(/None\./g)?.length).toBeGreaterThanOrEqual(3);
    });

    it("scanCompletedStatusDrift and repairCompletedStatusDrift branches", () => {
      const root = mkdtempSync(join(tmpdir(), "reconcile-drift-"));
      mkVbriefTree(root, [
        {
          folder: "completed",
          name: "drift.xbrief.json",
          data: { plan: { status: "running" } },
        },
        {
          folder: "completed",
          name: "ok.xbrief.json",
          data: { plan: { status: "completed" } },
        },
      ]);
      writeFileSync(join(root, "xbrief", "completed", "bad-json.xbrief.json"), "{", "utf8");
      const vbriefDir = join(root, "xbrief");
      const drift = scanCompletedStatusDrift(vbriefDir);
      expect(drift.some((d) => d.rel_path === "completed/drift.xbrief.json")).toBe(true);
      const report = attachCompletedStatusDrift(
        {
          linked: [],
          no_open_issue: [],
          summary: { linked_count: 0, vbriefs_no_open_issue_count: 0 },
        },
        drift,
      );
      expect(report.summary.completed_status_drift_count).toBe(drift.length);
      expect(formatMarkdown(report)).toContain("D2 drift");

      const [repaired, skipped, failures] = repairCompletedStatusDrift(vbriefDir, [
        ...drift,
        { rel_path: "completed/ok.xbrief.json", status: "completed" },
      ]);
      expect(repaired).toBeGreaterThanOrEqual(1);
      expect(skipped).toBeGreaterThanOrEqual(1);
      expect(failures).toHaveLength(0);

      const [, , shapeFailures] = repairCompletedStatusDrift(vbriefDir, [
        { rel_path: "orphan.xbrief.json", status: "running" },
      ]);
      expect(shapeFailures.some((f) => f.includes("unexpected vBRIEF path shape"))).toBe(true);

      rmSync(root, { recursive: true, force: true });
    });

    it("applyLifecycleFixes covers skip and failure branches", () => {
      const root = mkdtempSync(join(tmpdir(), "reconcile-branches-"));
      mkVbriefTree(root, [
        {
          folder: "active",
          name: "bad.xbrief.json",
          data: { plan: { status: "running", references: [] } },
        },
        {
          folder: "completed",
          name: "terminal.xbrief.json",
          data: { plan: { status: "completed", references: [] } },
        },
      ]);
      writeFileSync(join(root, "xbrief", "active", "invalid.xbrief.json"), "not-json", "utf8");
      const vbriefDir = join(root, "xbrief");
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const baseReport = {
        linked: [],
        summary: { linked_count: 0, vbriefs_no_open_issue_count: 0 },
        no_open_issue: [] as {
          issue_number: number;
          vbrief_files: string[];
          state_reason?: string;
          note?: string;
        }[],
      };

      let [, skipped, failures] = applyLifecycleFixes(
        vbriefDir,
        {
          ...baseReport,
          no_open_issue: [
            {
              issue_number: 1,
              vbrief_files: ["orphan.xbrief.json"],
              state_reason: "COMPLETED",
              note: "n",
            },
          ],
        },
        root,
      );
      expect(failures.some((f) => f.includes("unexpected vBRIEF path shape"))).toBe(true);

      [, skipped, failures] = applyLifecycleFixes(
        vbriefDir,
        {
          ...baseReport,
          no_open_issue: [
            {
              issue_number: 2,
              vbrief_files: ["completed/terminal.xbrief.json"],
              state_reason: "COMPLETED",
              note: "n",
            },
          ],
        },
        root,
      );
      expect(skipped).toBeGreaterThanOrEqual(1);

      [, , failures] = applyLifecycleFixes(
        vbriefDir,
        {
          ...baseReport,
          no_open_issue: [
            {
              issue_number: 3,
              vbrief_files: ["active/missing.xbrief.json"],
              state_reason: "COMPLETED",
              note: "n",
            },
          ],
        },
        root,
      );
      expect(failures.some((f) => f.includes("missing"))).toBe(true);

      [, , failures] = applyLifecycleFixes(
        vbriefDir,
        {
          ...baseReport,
          no_open_issue: [
            {
              issue_number: 4,
              vbrief_files: ["active/invalid.xbrief.json"],
              state_reason: "COMPLETED",
              note: "n",
            },
          ],
        },
        root,
      );
      expect(failures.some((f) => f.includes("failed to parse"))).toBe(true);

      writeFileSync(join(vbriefDir, "completed", "bad.xbrief.json"), "{}\n", "utf8");
      [, skipped] = applyLifecycleFixes(
        vbriefDir,
        {
          ...baseReport,
          no_open_issue: [
            {
              issue_number: 5,
              vbrief_files: ["active/bad.xbrief.json"],
              state_reason: "COMPLETED",
              note: "n",
            },
          ],
        },
        root,
      );
      expect(skipped).toBe(1);
      expect(stderr.mock.calls.some((c) => String(c[0]).includes("left source in place"))).toBe(
        true,
      );

      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    });

    it("applyLifecycleFixes skips when completed already has basename (#2622)", () => {
      const root = mkdtempSync(join(tmpdir(), "reconcile-dup-"));
      const name = "dup.xbrief.json";
      mkVbriefTree(root, [
        {
          folder: "proposed",
          name,
          data: {
            plan: {
              status: "proposed",
              references: [
                { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/77" },
              ],
            },
          },
        },
      ]);
      mkdirSync(join(root, "xbrief", "completed"), { recursive: true });
      writeFileSync(join(root, "xbrief", "completed", name), "{}\n", "utf8");
      const anchors = scanLifecycleAnchors(join(root, "xbrief"));
      const applyReport = buildLifecycleReport(
        anchors,
        new Map([[77, new IssueState("CLOSED", "COMPLETED")]]),
      );
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const [moved, skipped, failures] = applyLifecycleFixes(
        join(root, "xbrief"),
        applyReport,
        root,
      );
      expect(moved).toBe(0);
      expect(skipped).toBe(1);
      expect(failures).toHaveLength(0);
      expect(existsSync(join(root, "xbrief", "proposed", name))).toBe(true);
      expect(existsSync(join(root, "xbrief", "completed", name))).toBe(true);
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    });

    it("scanVbriefDir indexes references", () => {
      const root = mkdtempSync(join(tmpdir(), "scan-vbrief-"));
      mkVbriefTree(root, [
        {
          folder: "proposed",
          name: "x.xbrief.json",
          data: {
            plan: {
              references: [
                { type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/42" },
              ],
            },
          },
        },
      ]);
      const map = scanVbriefDir(join(root, "xbrief"));
      expect(map.get(42)).toEqual(["proposed/x.xbrief.json"]);
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

    it("parseIssueNumber and extractReferencesFromVbrief edge cases", () => {
      expect(parseIssueNumber({ type: "x", url: "https://github.com/o/r/issues/88" })).toBe(88);
      expect(parseIssueNumber({ type: "github-issue", id: "#99" })).toBe(99);
      expect(parseIssueNumber({ type: "x" })).toBeNull();
      expect(extractReferencesFromVbrief({ plan: { items: "not-array" } })).toEqual([]);
      expect(
        extractReferencesFromVbrief({
          plan: {
            references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/5" }],
            items: [{ references: [{ type: "x-vbrief/github-issue", id: "#6" }] }],
          },
        }),
      ).toHaveLength(2);
    });
  });

  describe("issue-emit", () => {
    it("renderIssueBody fallback and emit paths", () => {
      expect(renderIssueBody({})).toContain("Scope vBRIEF");
      const dir = mkdtempSync(join(tmpdir(), "emit-"));
      const path = join(dir, "one.xbrief.json");
      writeVbrief(
        path,
        {
          plan: {
            title: "Emit me",
            references: [{ type: "x-vbrief/github-issue", uri: "https://github.com/o/r/issues/1" }],
          },
        },
        dir,
      );
      const skipped = emitSingle(path, { repo: "o/r", noNetwork: false, projectRoot: dir });
      expect(skipped.result).toBe("skipped");
      writeVbrief(join(dir, "two.xbrief.json"), { plan: { title: "Dry" } }, dir);
      const dry = emitSingle(join(dir, "two.xbrief.json"), {
        repo: "o/r",
        noNetwork: true,
        projectRoot: dir,
      });
      expect(dry.result).toBe("dryrun");
      const umbrella = emitUmbrella([join(dir, "two.xbrief.json")], {
        repo: "o/r",
        noNetwork: true,
        displayPaths: ["two.xbrief.json"],
        projectRoot: dir,
      });
      expect(umbrella.result).toBe("dryrun");
      rmSync(dir, { recursive: true, force: true });
    });

    it("fileIssue and emitPerVbrief with stub scm", () => {
      const dir = mkdtempSync(join(tmpdir(), "emit-file-"));
      const path = join(dir, "fresh.xbrief.json");
      writeVbrief(path, { plan: { title: "Fresh" } }, dir);
      const scmCall = () => completed("https://github.com/o/r/issues/42\n", "", 0);
      const created = emitSingle(path, { repo: "o/r", scmCall, projectRoot: dir });
      expect(created.result).toBe("created");
      expect(created.url).toContain("/issues/42");
      const actions = emitPerVbrief([path], { repo: "o/r", scmCall, projectRoot: dir });
      expect(actions[0]?.result).toBe("skipped");
      expect(() => fileIssue("o/r", "t", "b", () => completed("", "fail", 1))).toThrow(
        IssueEmitError,
      );
      rmSync(dir, { recursive: true, force: true });
    });

    it("expandPatterns displayPath isNoNetwork issueEmitMain", () => {
      const dir = mkdtempSync(join(tmpdir(), "emit-cli-"));
      const vpath = join(dir, "solo.xbrief.json");
      writeVbrief(vpath, { plan: { title: "Solo" } }, dir);
      const matches = expandPatterns([vpath], dir);
      expect(matches).toHaveLength(1);
      expect(displayPath(vpath, dir)).toBe("solo.xbrief.json");
      const prev = process.env.DEFT_NO_NETWORK;
      process.env.DEFT_NO_NETWORK = "1";
      expect(isNoNetwork(false)).toBe(true);
      process.env.DEFT_NO_NETWORK = prev;
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      expect(issueEmitMain({ patterns: [], projectRoot: dir })).toBe(2);
      writeVbrief(join(dir, "other.xbrief.json"), { plan: { title: "Other" } }, dir);
      expect(
        issueEmitMain({
          patterns: [join(dir, "*.xbrief.json")],
          projectRoot: dir,
          dryRun: true,
        }),
      ).toBe(2);
      stderr.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("github-body", () => {
    it("mutations round-trip via runFn seam", () => {
      let lastBody = "";
      const runFn: RunGhApiFn = (args, options) => {
        if (args.includes("--method")) {
          if (options?.inputText) {
            const parsed = JSON.parse(options.inputText) as { body?: string };
            if (typeof parsed.body === "string") lastBody = parsed.body;
          }
          return { number: 7, id: 99 };
        }
        return { number: 7, body: lastBody, id: 99 };
      };
      expect(editIssueBody("o/r", 7, { body: "b", runFn, binary: "gh" }).body).toBe("b");
      expect(createIssueComment("o/r", 7, { body: "c", runFn, binary: "gh" }).id).toBe(99);
      expect(editIssueCommentBody("o/r", 99, { body: "d", runFn, binary: "gh" }).id).toBe(99);
      expect(editPrBody("o/r", 3, { body: "e", runFn, binary: "gh" }).body).toBe("e");
    });

    it("readBody and githubBodyMain", () => {
      const dir = mkdtempSync(join(tmpdir(), "gh-body-"));
      const bodyPath = join(dir, "body.md");
      writeFileSync(bodyPath, "hello", "utf8");
      expect(readBody(bodyPath)).toBe("hello");
      expect(readBody("-", "stdin")).toBe("stdin");
      let lastBody = "";
      const callSpy = vi.spyOn(scm, "call").mockImplementation((_domain, _verb, args, opts) => {
        if (args.includes("--method")) {
          const input = opts?.input;
          if (typeof input === "string") {
            const parsed = JSON.parse(input) as { body?: string };
            if (typeof parsed.body === "string") lastBody = parsed.body;
          }
          return completed(JSON.stringify({ number: 1, id: 99 }), "", 0);
        }
        return completed(JSON.stringify({ number: 1, body: lastBody, id: 99 }), "", 0);
      });
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
      expect(
        validateInjectedTokenMode({ GH_TOKEN: "x" }, { repo: "owner/name", runGh: runner2 })
          .failureKind,
      ).toBe(FAILURE_API_UNREACHABLE);
      const runner3 = ghRunner({
        auth: completed(),
        user: completed('"bot"'),
        repo: completed("", "denied", 403),
      });
      expect(
        validateInjectedTokenMode({ GH_TOKEN: "x" }, { repo: "owner/name", runGh: runner3 })
          .failureKind,
      ).toBe(FAILURE_REPO_ACCESS);
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
          repo: "owner/name",
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
      const runner = ghRunner({
        auth: completed(),
        user: completed('"octo"'),
        repo: completed("{}"),
      });
      const result = validateGithubAuthForWorker("host-gh", {
        repo: "owner/name",
        runGh: runner,
        runtimeReport: { runtimeMode: RUNTIME_MODE_LOCAL_UNSANDBOXED },
      });
      expect(resultToDict(result).ok).toBe(true);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      expect(
        githubAuthModesMain({
          githubAuthMode: "host-gh",
          repo: "owner/name",
          json: true,
          runGh: runner,
        }),
      ).toBe(0);
      expect(
        githubAuthModesMain({
          githubAuthMode: "host-gh",
          repo: "owner/name",
          json: false,
          runGh: runner,
        }),
      ).toBe(0);
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
