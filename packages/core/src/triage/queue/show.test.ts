import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  extractAcceptanceCriteria,
  extractBodySummary,
  loadCachedIssueDetail,
  renderOperatorBrief,
  renderShow,
  type ShowAuditRow,
} from "./show.js";

const temps: string[] = [];

afterAll(() => {
  for (const temp of temps) {
    rmSync(temp, { recursive: true, force: true });
  }
});

function seedIssue(
  root: string,
  repo: string,
  number: number,
  fields: {
    title?: string;
    body?: string;
    labels?: readonly string[];
    state?: string;
    htmlUrl?: string;
  } = {},
): void {
  const [owner, name] = repo.split("/", 2) as [string, string];
  const dir = join(root, ".deft-cache", "github-issue", owner, name, String(number));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "raw.json"),
    `${JSON.stringify({
      number,
      title: fields.title ?? `Issue ${number}`,
      state: fields.state ?? "open",
      labels: (fields.labels ?? []).map((label) => ({ name: label })),
      body: fields.body ?? "",
      updated_at: "2026-07-28T12:00:00Z",
      html_url: fields.htmlUrl ?? `https://github.com/${repo}/issues/${number}`,
    })}\n`,
    "utf8",
  );
}

describe("loadCachedIssueDetail", () => {
  it("returns null on cache miss", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-show-miss-"));
    temps.push(root);
    expect(loadCachedIssueDetail("owner/repo", 99, { projectRoot: root })).toBeNull();
  });

  it("loads title labels body and link", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-show-hit-"));
    temps.push(root);
    seedIssue(root, "owner/repo", 42, {
      title: "Fix the thing",
      labels: ["bug", "skills"],
      body: "Problem context here.\n\n## Acceptance criteria\n- [ ] does work\n",
    });
    const issue = loadCachedIssueDetail("owner/repo", 42, { projectRoot: root });
    expect(issue).not.toBeNull();
    expect(issue?.title).toBe("Fix the thing");
    expect(issue?.labels).toEqual(["bug", "skills"]);
    expect(issue?.body).toContain("Acceptance criteria");
    expect(issue?.htmlUrl).toBe("https://github.com/owner/repo/issues/42");
  });

  it("honors cacheRoot override and uses canonical issue URL", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-show-cache-root-"));
    temps.push(root);
    const cacheRoot = join(root, "custom-cache");
    const dir = join(cacheRoot, "github-issue", "owner", "repo", "7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "raw.json"),
      `${JSON.stringify({
        number: 7,
        title: "Alt",
        state: "open",
        labels: [],
        body: "x",
        // Poisoned URL must not be trusted
        html_url: "https://evil.example/github.com/owner/repo/issues/7",
        url: "https://evil.example/?q=github.com",
      })}\n`,
      "utf8",
    );
    const issue = loadCachedIssueDetail("owner/repo", 7, { projectRoot: root, cacheRoot });
    expect(issue?.title).toBe("Alt");
    expect(issue?.htmlUrl).toBe("https://github.com/owner/repo/issues/7");
  });
});

describe("extractBodySummary / extractAcceptanceCriteria", () => {
  it("returns thin-body note for empty body", () => {
    expect(extractBodySummary("")).toBe("(thin body / no summary)");
    expect(extractAcceptanceCriteria("")).toEqual([]);
  });

  it("extracts pre-heading prose as summary", () => {
    const body = [
      "Agents can ship menu-only turns without a candidate brief.",
      "",
      "That degrades triage into a verb dispatcher.",
      "",
      "## Acceptance criteria",
      "- [ ] brief before menu",
    ].join("\n");
    const summary = extractBodySummary(body);
    expect(summary).toContain("menu-only");
    expect(summary).toContain("verb dispatcher");
    expect(summary).not.toContain("brief before menu");
  });

  it("extracts AC checkboxes under Acceptance criteria heading", () => {
    const body = [
      "Overview text.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] Phase 3 requires operator brief",
      "- [x] same-turn rule",
      "",
      "## Out of scope",
      "- ignore me",
    ].join("\n");
    expect(extractAcceptanceCriteria(body)).toEqual([
      "Phase 3 requires operator brief",
      "same-turn rule",
    ]);
  });

  it("keeps nested ### subsections inside AC (issue-body shape)", () => {
    const body = [
      "Overview.",
      "",
      "## Acceptance criteria",
      "",
      "### A. Phase 3 brief",
      "- [ ] brief before menu",
      "### B. Same-turn",
      "- [ ] same message",
      "",
      "## Out of scope",
      "- [ ] not an AC",
    ].join("\n");
    expect(extractAcceptanceCriteria(body)).toEqual(["brief before menu", "same message"]);
  });
});

describe("renderShow", () => {
  it("reports cache miss with exit-path hint", () => {
    const text = renderShow({
      issue: null,
      repo: "owner/repo",
      number: 7,
      latestDecision: null,
      history: [],
      inActiveXbrief: false,
    });
    expect(text).toContain("triage:show -- owner/repo#7");
    expect(text).toContain("issue not present in local cache");
  });

  it("renders title labels decision and active flag", () => {
    const latest: ShowAuditRow = {
      decision_id: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-07-28T10:00:00Z",
      repo: "owner/repo",
      issue_number: 7,
      decision: "needs-ac",
      actor: "agent:test",
      reason: "missing AC",
    };
    const text = renderShow({
      issue: {
        number: 7,
        title: "Need AC",
        state: "open",
        labels: ["bug"],
        updatedAt: "2026-07-28T12:00:00Z",
        body: "x",
        htmlUrl: "https://github.com/owner/repo/issues/7",
      },
      repo: "owner/repo",
      number: 7,
      latestDecision: latest,
      history: [latest],
      inActiveXbrief: true,
    });
    expect(text).toContain("title:      Need AC");
    expect(text).toContain("labels:     bug");
    expect(text).toContain("active xBRIEF reference: yes");
    expect(text).toContain("latest decision: needs-ac at 2026-07-28T10:00:00Z by agent:test");
    expect(text).toContain("reason: missing AC");
    expect(text).toContain("history (1 entries");
  });
});

describe("renderOperatorBrief (#2890 / #3116)", () => {
  it("emits pasteable brief fields without inventing lean", () => {
    const text = renderOperatorBrief({
      issue: {
        number: 2890,
        title: "Phase 3 operator brief",
        state: "open",
        labels: ["bug", "skills"],
        updatedAt: "2026-07-28T12:00:00Z",
        body: [
          "Menu-only Phase 3 turns degrade triage.",
          "",
          "## Acceptance criteria",
          "- [ ] operator brief before menu",
          "- [ ] same-turn rule",
        ].join("\n"),
        htmlUrl: "https://github.com/deftai/directive/issues/2890",
      },
      repo: "deftai/directive",
      number: 2890,
      latestDecision: null,
      inActiveXbrief: true,
    });
    expect(text).toContain("triage:show --format=operator");
    expect(text).toContain("#2890  Phase 3 operator brief");
    expect(text).toContain("https://github.com/deftai/directive/issues/2890");
    expect(text).toContain("labels:  bug, skills");
    expect(text).toContain("summary:");
    expect(text).toContain("Menu-only Phase 3");
    expect(text).toContain("acceptance criteria:");
    expect(text).toContain("operator brief before menu");
    expect(text).toContain("latest decision: <none -- untriaged>");
    expect(text).toContain("active xBRIEF: yes");
    expect(text).toContain("lean: (agent-owned");
  });

  it("puts html_url first and includes agent-owned validity line (#3116)", () => {
    const text = renderOperatorBrief({
      issue: {
        number: 3116,
        title: "Validity + URL-first",
        state: "open",
        labels: ["triage"],
        updatedAt: "2026-08-04T12:00:00Z",
        body: "Residual Phase 3 brief gaps.",
        htmlUrl: "https://github.com/deftai/directive/issues/3116",
      },
      repo: "deftai/directive",
      number: 3116,
      latestDecision: null,
      inActiveXbrief: false,
    });
    const lines = text.split("\n");
    // Header line 0; first body field must be the canonical issue URL (#3116 URL-first).
    expect(lines[0]).toContain("triage:show --format=operator");
    expect(lines[1]).toBe("https://github.com/deftai/directive/issues/3116");
    expect(lines[2]).toBe("#3116  Validity + URL-first");
    const urlIdx = text.indexOf("https://github.com/deftai/directive/issues/3116");
    const titleIdx = text.indexOf("#3116  Validity + URL-first");
    const summaryIdx = text.indexOf("summary:");
    expect(urlIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(urlIdx);
    expect(summaryIdx).toBeGreaterThan(titleIdx);
    expect(text).toContain(
      "validity: (agent-owned — still-open | partial | likely-shipped | needs-re-scope + evidence)",
    );
    // Mechanical assist does not invent a verdict.
    expect(text).not.toMatch(/^validity: still-open/m);
  });

  it("notes thin body / no AC when body is empty", () => {
    const text = renderOperatorBrief({
      issue: {
        number: 1,
        title: "Empty",
        state: "open",
        labels: [],
        updatedAt: "",
        body: "",
        htmlUrl: "https://github.com/o/r/issues/1",
      },
      repo: "o/r",
      number: 1,
      latestDecision: null,
      inActiveXbrief: false,
    });
    expect(text).toContain("labels:  <none>");
    expect(text).toContain("(thin body / no summary)");
    expect(text).toContain("acceptance criteria: (thin body / no AC)");
    expect(text).toContain("active xBRIEF: no");
    expect(text.split("\n")[1]).toBe("https://github.com/o/r/issues/1");
  });
});
