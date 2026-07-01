import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cachePut } from "../cache/operations.js";
import { FixedClock } from "../cache/test-helpers.js";
import type { CompletedProcess } from "../scm/call.js";
import {
  buildIssueVbrief,
  extractCrossRefs,
  extractPlanItems,
  fetchIssue,
  ingestOne,
  provenanceIssueNumber,
} from "./issue-ingest.js";

function completed(stdout: string, stderr: string, returncode: number): CompletedProcess {
  return { stdout, stderr, returncode };
}

describe("buildIssueVbrief", () => {
  it("maps checkbox body to plan items", () => {
    const body = "## Acceptance Criteria\n- [ ] Widget renders\n- [x] Spec updated\n";
    const [vbrief] = buildIssueVbrief(
      {
        number: 500,
        title: "Widget support",
        url: "https://github.com/owner/repo/issues/500",
        body,
        labels: [],
      },
      "proposed",
      "https://github.com/owner/repo",
    );
    const plan = vbrief.plan as Record<string, unknown>;
    expect(plan.items).toEqual([
      { title: "Widget renders", status: "proposed" },
      { title: "Spec updated", status: "completed" },
    ]);
    expect((plan.narratives as Record<string, string>).Overview).toContain("Acceptance Criteria");
  });
});

describe("extractCrossRefs", () => {
  it("extracts closes/refs/blocks outside code spans", () => {
    const body = "Closes #10\nRefs #11\nBlocked by #12\n```\nCloses #99\n```";
    const refs = extractCrossRefs(body, "https://github.com/o/r", new Set());
    expect(refs.map((r) => r.type)).toEqual([
      "x-xbrief/closes",
      "x-xbrief/blocks",
      "x-xbrief/refs",
    ]);
  });
});

describe("extractPlanItems", () => {
  it("returns empty for body without structure", () => {
    expect(extractPlanItems("Just prose, no checklist.")).toEqual([]);
  });

  it("preserves inline code in acceptance-criteria checkbox titles (#1269 shape)", () => {
    const body = [
      "## Acceptance criteria",
      "",
      "- [ ] `.deft/` added to `.gitignore`",
      "- [ ] Sentinel reader + writer module (e.g. `scripts/ritual_sentinel.py`) with `read()` / `write()` / `compute_delta()` functions",
      "- [ ] `task check` passes",
    ].join("\n");
    expect(extractPlanItems(body)).toEqual([
      { title: "`.deft/` added to `.gitignore`", status: "proposed" },
      {
        title:
          "Sentinel reader + writer module (e.g. `scripts/ritual_sentinel.py`) with `read()` / `write()` / `compute_delta()` functions",
        status: "proposed",
      },
      { title: "`task check` passes", status: "proposed" },
    ]);
  });

  it("preserves inline code in acceptance-criteria checkbox titles (#1270 shape)", () => {
    const body = [
      "## Acceptance criteria",
      "",
      '- [ ] `scripts/triage_summary.py` `in-flight` count reads `len(glob("vbrief/active/*.vbrief.json"))` filtered by `plan.status == "running"` (filesystem-truth)',
      "- [ ] When `filesystem_count != cache_scoped_count`, append `[triage:scope] N in-flight outside plan.policy.triageScope[] (uncounted in queue ranking)` (loud discrepancy line)",
      "- [ ] `task check` passes",
    ].join("\n");
    expect(extractPlanItems(body)).toEqual([
      {
        title:
          '`scripts/triage_summary.py` `in-flight` count reads `len(glob("vbrief/active/*.vbrief.json"))` filtered by `plan.status == "running"` (filesystem-truth)',
        status: "proposed",
      },
      {
        title:
          "When `filesystem_count != cache_scoped_count`, append `[triage:scope] N in-flight outside plan.policy.triageScope[] (uncounted in queue ranking)` (loud discrepancy line)",
        status: "proposed",
      },
      { title: "`task check` passes", status: "proposed" },
    ]);
  });
});

describe("provenanceIssueNumber", () => {
  it("reads issue number from Origin URL", () => {
    expect(
      provenanceIssueNumber({
        plan: { narratives: { Origin: "Ingested from https://github.com/o/r/issues/42" } },
      }),
    ).toBe(42);
  });
});

describe("fetchIssue", () => {
  it("prefers live fetch over a fresh-but-stale cache entry", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "deft-ingest-cache-"));
    const clock = new FixedClock(new Date("2026-06-20T12:00:00Z"));
    try {
      cachePut(
        "github-issue",
        "o/r/1714",
        {
          number: 1714,
          title: "Stale cached title",
          body: "Stale cached body",
          html_url: "https://github.com/o/r/issues/1714",
          updated_at: "2026-06-19T10:00:00Z",
        },
        { cacheRoot, clock, fetchedAt: clock.now() },
      );

      const scmCall = vi.fn(() =>
        completed(
          JSON.stringify({
            number: 1714,
            title: "Live rewritten title",
            body: "Live rewritten body",
            html_url: "https://github.com/o/r/issues/1714",
            updated_at: "2026-06-29T10:00:00Z",
          }),
          "",
          0,
        ),
      );

      const issue = fetchIssue("o/r", 1714, { cacheRoot, scmCall });
      expect(issue?.title).toBe("Live rewritten title");
      expect(issue?.body).toBe("Live rewritten body");
      expect(scmCall).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("falls back to cache when live fetch fails", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "deft-ingest-cache-"));
    try {
      cachePut(
        "github-issue",
        "o/r/99",
        {
          number: 99,
          title: "Cached fallback title",
          body: "Cached fallback body",
          html_url: "https://github.com/o/r/issues/99",
        },
        { cacheRoot },
      );

      const scmCall = vi.fn(() => completed("", "network error", 1));
      const issue = fetchIssue("o/r", 99, { cacheRoot, scmCall });
      expect(issue?.title).toBe("Cached fallback title");
      expect(scmCall).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe("ingestOne with fetchIssue", () => {
  it("writes vBRIEF from live payload when cache is stale", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-ingest-root-"));
    const cacheRoot = join(root, ".deft-cache");
    const vbriefDir = join(root, "vbrief");
    const clock = new FixedClock(new Date("2026-06-20T12:00:00Z"));
    try {
      cachePut(
        "github-issue",
        "o/r/500",
        {
          number: 500,
          title: "Stale title",
          body: "Stale body",
          html_url: "https://github.com/o/r/issues/500",
        },
        { cacheRoot, clock, fetchedAt: clock.now() },
      );

      const liveIssue = {
        number: 500,
        title: "Fresh live title",
        body: "Fresh live body",
        html_url: "https://github.com/o/r/issues/500",
      };
      const issue = fetchIssue("o/r", 500, {
        cacheRoot,
        scmCall: () => completed(JSON.stringify(liveIssue), "", 0),
      });
      expect(issue).not.toBeNull();

      const [result, path] = ingestOne(issue as Record<string, unknown>, {
        vbriefDir,
        status: "proposed",
        repoUrl: "https://github.com/o/r",
      });
      expect(result).toBe("created");
      expect(path).not.toBeNull();
      const written = JSON.parse(readFileSync(path as string, "utf8")) as Record<string, unknown>;
      const plan = written.plan as Record<string, unknown>;
      expect(plan.title).toBe("Fresh live title");
      expect((plan.narratives as Record<string, string>).Overview).toBe("Fresh live body");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
