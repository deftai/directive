import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DesignCritiqueIngestBlockedError,
  evaluateCompletedArcRecord,
  type ThreadComment,
} from "../design-critique/completed-arc-record.js";
import {
  extractChipCommandArgv,
  formatStaleIngestReadyDiagnostic,
  INGEST_READY_CHIP,
  mechanismShapedChipCommand,
  PAIN_COVERAGE_REQUIREMENT,
} from "../design-critique/stale-ingest-ready-diagnostic.js";
import { ISSUE_COMMENT_THREAD_KEY, ingestOne } from "../intake/issue-ingest.js";
import type { LabelClient } from "../vbrief-reconcile/types.js";
import type { CompletedProcess } from "./call.js";
import { runDesignCritiqueChip } from "./design-critique-chip.js";
import {
  parseDesignCritiqueStaleReadyArgs,
  runDesignCritiqueStaleReady,
  scanStaleIngestReady,
} from "./design-critique-stale-ready.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../design-critique/fixtures/issue-4290-through-5656093589.json",
);

const ORIGIN_A = "example/origin-a";
const SCANNED_B = "deftai/directive";
const STANDING = ["bug", "agent-experience", INGEST_READY_CHIP];

type FrozenFixture = {
  readonly repo: string;
  readonly number: number;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly ThreadComment[];
};

function loadFrozen4290(): FrozenFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as FrozenFixture;
}

const LEAN_ID = 5442939496;
const TABLE_ID = 5443106967;
const SYNTHESIS_ID = 5443114746;

const completeComments: ThreadComment[] = [
  { id: LEAN_ID, body: "**Lean:** operator amend of 5442883752. Chips stay convenience.\n" },
  { id: TABLE_ID, body: "## Verified-claims table\n\n| Verified claim | Result |\n" },
  {
    id: SYNTHESIS_ID,
    body:
      "model: grok-4.6\nrole: parent\n\n" +
      "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
      `Bound contract: successor lean ${LEAN_ID}, confirmed by operator, verified-claims table ${TABLE_ID}.\n`,
  },
];

function completed(stdout: string, stderr: string, returncode: number): CompletedProcess {
  return { stdout, stderr, returncode };
}

class MapLabelClient implements LabelClient {
  readonly state = new Map<string, string[]>();
  applyCalls: Array<{
    repo: string;
    issue: number;
    add: readonly string[];
    remove: readonly string[];
  }> = [];

  key(repo: string, issue: number): string {
    return `${repo}#${String(issue)}`;
  }

  seed(repo: string, issue: number, labels: readonly string[]): void {
    this.state.set(this.key(repo, issue), [...labels]);
  }

  fetchLabels(repo: string, issueNumber: number): string[] {
    return [...(this.state.get(this.key(repo, issueNumber)) ?? [])];
  }

  apply(
    repo: string,
    issueNumber: number,
    add: readonly string[],
    remove: readonly string[],
  ): void {
    this.applyCalls.push({ repo, issue: issueNumber, add: [...add], remove: [...remove] });
    const next = new Set(this.fetchLabels(repo, issueNumber));
    for (const name of remove) next.delete(name);
    for (const name of add) next.add(name);
    this.state.set(this.key(repo, issueNumber), [...next]);
  }
}

describe("parseDesignCritiqueStaleReadyArgs", () => {
  it("parses optional --repo and --json", () => {
    const parsed = parseDesignCritiqueStaleReadyArgs(["--repo", SCANNED_B, "--json"]);
    expect(parsed).toEqual({ ok: true, args: { repo: SCANNED_B, json: true } });
  });

  it("prints usage on --help", () => {
    const parsed = parseDesignCritiqueStaleReadyArgs(["--help"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toContain("design-critique-stale-ready");
  });
});

describe("scanStaleIngestReady", () => {
  it("reports frozen missing-pain, complete control, and does not write", () => {
    const frozen = loadFrozen4290();
    const client = new MapLabelClient();
    client.seed(SCANNED_B, 4290, frozen.labels);
    const result = scanStaleIngestReady(SCANNED_B, {
      listOpenIngestReady: () => [
        { number: 4290, body: frozen.body, labels: frozen.labels },
        { number: 12, body: "ok", labels: STANDING },
      ],
      fetchIssue: (_repo, n) =>
        n === 4290
          ? { number: 4290, body: frozen.body, labels: frozen.labels }
          : { number: 12, body: "ok", labels: STANDING },
      fetchComments: (_repo, n) => (n === 4290 ? frozen.comments : completeComments),
    });
    expect(result.complete).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.mismatch).toBe(1);
    expect(result.unknown).toBe(0);
    expect(result.reports).toHaveLength(1);
    const diagnostic = result.reports[0]?.diagnostic;
    expect(diagnostic?.reason).toBe("missing-pain");
    expect(diagnostic?.text).toContain(mechanismShapedChipCommand(SCANNED_B, 4290));
    expect(client.applyCalls).toHaveLength(0);
  });

  it("marks candidate fetch failure unknown and list failure incomplete", () => {
    const unknownScan = scanStaleIngestReady(SCANNED_B, {
      listOpenIngestReady: () => [{ number: 7, body: "", labels: STANDING }],
      fetchIssue: () => {
        throw new Error("issue view failed");
      },
      fetchComments: () => [],
    });
    expect(unknownScan.complete).toBe(true);
    expect(unknownScan.unknown).toBe(1);
    expect(unknownScan.reports[0]?.diagnostic.reason).toBe("unknown");
    expect(unknownScan.reports[0]?.diagnostic.text).toContain("unknown");
    expect(unknownScan.reports[0]?.diagnostic.text).not.toContain("stale-target");

    const incomplete = scanStaleIngestReady(SCANNED_B, {
      listOpenIngestReady: () => {
        throw new Error("page 2 non-JSON");
      },
    });
    expect(incomplete.complete).toBe(false);
    expect(incomplete.error).toMatch(/page 2 non-JSON/);
  });

  it("uses implicit origin resolution as the command repository", () => {
    const frozen = loadFrozen4290();
    const result = runDesignCritiqueStaleReady([], {
      resolveDefaultRepo: () => SCANNED_B,
      listOpenIngestReady: () => [{ number: 4290, body: frozen.body, labels: frozen.labels }],
      fetchIssue: () => ({ number: 4290, body: frozen.body, labels: frozen.labels }),
      fetchComments: () => frozen.comments,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(mechanismShapedChipCommand(SCANNED_B, 4290));
    expect(extractChipCommandArgv(result.stdout)).toEqual([
      "--repo",
      SCANNED_B,
      "--issue",
      "4290",
      "--chip",
      "mechanism-shaped",
    ]);
  });

  it("skips evaluation when the refreshed REST issue is no longer open", () => {
    const frozen = loadFrozen4290();
    const result = scanStaleIngestReady(SCANNED_B, {
      listOpenIngestReady: () => [{ number: 4290, body: frozen.body, labels: frozen.labels }],
      fetchIssue: () => ({
        number: 4290,
        body: frozen.body,
        labels: frozen.labels,
        state: "closed",
      }),
      fetchComments: () => {
        throw new Error("comments must not be fetched for a closed issue");
      },
    });
    expect(result.complete).toBe(true);
    expect(result.checked).toBe(1);
    expect(result.mismatch).toBe(0);
    expect(result.unknown).toBe(0);
    expect(result.reports).toHaveLength(0);
  });

  it("preserves restIssueView state and does not mismatch a close between list and refresh", () => {
    const frozen = loadFrozen4290();
    const listed = {
      number: 4290,
      body: frozen.body,
      labels: frozen.labels.map((name) => ({ name })),
      state: "open",
    };
    const viewed = { ...listed, state: "closed" };
    const result = scanStaleIngestReady(SCANNED_B, {
      ghRest: {
        runGhApiFn: (args) => {
          const path = args[0] ?? "";
          if (/\/issues\/\d+$/.test(path)) {
            return { returncode: 0, stdout: JSON.stringify(viewed), stderr: "" };
          }
          if (path.endsWith("/issues")) {
            return { returncode: 0, stdout: JSON.stringify([listed]), stderr: "" };
          }
          return { returncode: 1, stdout: "", stderr: `unexpected ${path}` };
        },
      },
      fetchComments: () => {
        throw new Error("comments must not be fetched for a closed issue");
      },
    });
    expect(result.complete).toBe(true);
    expect(result.checked).toBe(1);
    expect(result.mismatch).toBe(0);
    expect(result.reports).toHaveLength(0);
  });
});

describe("callers emit the shared mapping", () => {
  it("includes mapping text on ingest refuse without writing a scope file", () => {
    const frozen = loadFrozen4290();
    const root = mkdtempSync(join(tmpdir(), "stale-ready-ingest-"));
    const xbriefDir = join(root, "xbrief");
    mkdirSync(xbriefDir, { recursive: true });
    const diagnostic = formatStaleIngestReadyDiagnostic({
      repo: SCANNED_B,
      issueNumber: 4290,
      labels: frozen.labels,
      verdict: evaluateCompletedArcRecord({
        comments: frozen.comments,
        issueNumber: 4290,
      }),
    });
    try {
      expect(() =>
        ingestOne(
          {
            number: 4290,
            title: "historical missing pain",
            html_url: `https://github.com/${SCANNED_B}/issues/4290`,
            body: frozen.body,
            labels: frozen.labels.map((name) => ({ name })),
            [ISSUE_COMMENT_THREAD_KEY]: frozen.comments,
          },
          {
            vbriefDir: xbriefDir,
            status: "proposed",
            repoUrl: `https://github.com/${SCANNED_B}`,
            cwd: root,
            scmCall: () => completed("[]", "", 0),
          },
        ),
      ).toThrow(DesignCritiqueIngestBlockedError);
      try {
        ingestOne(
          {
            number: 4290,
            title: "historical missing pain",
            html_url: `https://github.com/${SCANNED_B}/issues/4290`,
            body: frozen.body,
            labels: frozen.labels.map((name) => ({ name })),
            [ISSUE_COMMENT_THREAD_KEY]: frozen.comments,
          },
          {
            vbriefDir: xbriefDir,
            status: "proposed",
            repoUrl: `https://github.com/${SCANNED_B}`,
            cwd: root,
            scmCall: () => completed("[]", "", 0),
          },
        );
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DesignCritiqueIngestBlockedError);
        expect((err as Error).message).toContain(diagnostic.text);
        expect((err as Error).message).toContain(mechanismShapedChipCommand(SCANNED_B, 4290));
      }
      expect(readdirSafe(xbriefDir)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overlays mapping on standing ingest-ready proof-fail and skips it for a fresh write", () => {
    const frozen = loadFrozen4290();
    // Unpinned live body: Target-digest admission must not hit live GH in unit tests (#4995).
    const fetchIssueBody = (): string => frozen.body;
    const standing = new MapLabelClient();
    standing.seed(SCANNED_B, 4290, STANDING);
    const standingResult = runDesignCritiqueChip(
      ["--issue", "4290", "--chip", "ingest-ready", "--repo", SCANNED_B],
      { client: standing, fetchComments: () => frozen.comments, fetchIssueBody },
    );
    expect(standingResult.exitCode).toBe(1);
    expect(standing.applyCalls).toHaveLength(0);
    expect(standingResult.stderr).toContain(PAIN_COVERAGE_REQUIREMENT);
    expect(standingResult.stderr).toContain(mechanismShapedChipCommand(SCANNED_B, 4290));

    const fresh = new MapLabelClient();
    fresh.seed(SCANNED_B, 4290, ["bug"]);
    const freshResult = runDesignCritiqueChip(
      ["--issue", "4290", "--chip", "ingest-ready", "--repo", SCANNED_B],
      { client: fresh, fetchComments: () => frozen.comments, fetchIssueBody },
    );
    expect(freshResult.exitCode).toBe(1);
    expect(fresh.applyCalls).toHaveLength(0);
    expect(freshResult.stderr).not.toContain(mechanismShapedChipCommand(SCANNED_B, 4290));
    expect(freshResult.stderr).toContain("remaining-set refused");
  });
});

describe("emitted recovery command from a different-origin checkout", () => {
  it("changes only the scanned repository and keeps unrelated labels", () => {
    const frozen = loadFrozen4290();
    const scan = runDesignCritiqueStaleReady(["--repo", SCANNED_B], {
      resolveDefaultRepo: () => {
        throw new Error("default origin must not be consulted");
      },
      listOpenIngestReady: () => [{ number: 4290, body: frozen.body, labels: STANDING }],
      fetchIssue: () => ({ number: 4290, body: frozen.body, labels: STANDING }),
      fetchComments: () => frozen.comments,
    });
    expect(scan.exitCode).toBe(1);
    const argv = extractChipCommandArgv(scan.stdout);
    expect(argv).toEqual(["--repo", SCANNED_B, "--issue", "4290", "--chip", "mechanism-shaped"]);

    const client = new MapLabelClient();
    client.seed(ORIGIN_A, 4290, STANDING);
    client.seed(SCANNED_B, 4290, STANDING);
    const result = runDesignCritiqueChip(argv ?? [], {
      client,
      resolveDefaultRepo: () => {
        throw new Error("default origin must not be consulted");
      },
    });
    expect(result.exitCode).toBe(0);
    expect(client.fetchLabels(SCANNED_B, 4290)).toEqual([
      "bug",
      "agent-experience",
      "design-critique:mechanism-shaped",
    ]);
    expect(client.fetchLabels(ORIGIN_A, 4290)).toEqual(STANDING);
    expect(client.applyCalls).toEqual([
      {
        repo: SCANNED_B,
        issue: 4290,
        add: ["design-critique:mechanism-shaped"],
        remove: [INGEST_READY_CHIP],
      },
    ]);
  });
});

function readdirSafe(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}
