import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleMain } from "./main.js";
import {
  completedPathForScopeMove,
  findOpenUmbrellaReferences,
  renderOpenUmbrellaWarning,
} from "./open-umbrella-warning.js";
import { formatBriefJson } from "./vbrief-json.js";

const REPO = "deftai/directive";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "scope-umbrella-"));
  for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
    mkdirSync(join(root, "xbrief", folder), { recursive: true });
  }
  return root;
}

function writeScope(
  root: string,
  folder: string,
  name: string,
  plan: Record<string, unknown>,
): string {
  const path = join(root, "xbrief", folder, name);
  writeFileSync(
    path,
    formatBriefJson({
      xBRIEFInfo: { version: "0.8" },
      plan: { items: [], ...plan },
    }),
    "utf8",
  );
  return path;
}

function writeCachedIssue(
  root: string,
  number: number,
  payload: {
    readonly repo?: string;
    readonly title: string;
    readonly state?: string;
    readonly body?: string;
    readonly labels?: readonly string[];
    readonly rawLabels?: unknown;
    readonly subIssuesTotal?: number;
    readonly contentMarkdown?: string;
  },
): void {
  const [owner, repoName] = (payload.repo ?? REPO).split("/", 2);
  const issueDir = join(root, ".deft-cache", "github-issue", owner, repoName, String(number));
  mkdirSync(issueDir, { recursive: true });
  writeFileSync(
    join(issueDir, "raw.json"),
    `${JSON.stringify(
      {
        number,
        title: payload.title,
        state: payload.state ?? "open",
        body: payload.body ?? "",
        labels: payload.rawLabels ?? (payload.labels ?? []).map((name) => ({ name })),
        sub_issues_summary: { total: payload.subIssuesTotal ?? 0 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (payload.contentMarkdown !== undefined) {
    writeFileSync(join(issueDir, "content.md"), payload.contentMarkdown, "utf8");
  }
}

describe("scope complete open umbrella warning", () => {
  let root = "";

  afterEach(() => {
    vi.restoreAllMocks();
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("finds open xBRIEF parent references and renders a reconcile hint", () => {
    root = makeRepo();
    writeScope(root, "active", "umbrella.xbrief.json", {
      title: "Umbrella tracker",
      status: "running",
      metadata: { kind: "epic" },
      references: [
        { type: "x-xbrief/plan", uri: "completed/child.xbrief.json" },
        { type: "x-xbrief/github-issue", uri: `https://github.com/${REPO}/issues/1119` },
      ],
    });
    const child = writeScope(root, "completed", "child.xbrief.json", {
      title: "Completed child",
      status: "completed",
      planRef: "active/umbrella.xbrief.json",
      references: [
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/2322` },
      ],
    });
    writeCachedIssue(root, 1119, { title: "Umbrella tracker", labels: ["epic"] });

    const refs = findOpenUmbrellaReferences(root, child);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      repo: REPO,
      issueNumber: 1119,
      title: "Umbrella tracker",
    });
    expect(refs[0]?.sources).toEqual(
      expect.arrayContaining(["plan.references", "completed planRef"]),
    );
    const warning = renderOpenUmbrellaWarning(refs);
    expect(warning).toContain("#1119");
    expect(warning).toContain("task vbrief:reconcile:umbrellas");
  });

  it("detects direct stale active-scope links after the child moves to completed", () => {
    root = makeRepo();
    writeScope(root, "active", "umbrella.xbrief.json", {
      title: "Umbrella tracker",
      status: "running",
      planRef: "active/child.xbrief.json",
      references: [
        { type: "x-xbrief/plan", uri: "active/child.xbrief.json" },
        { type: "x-xbrief/github-issue", uri: `https://github.com/${REPO}/issues/1119` },
      ],
    });
    const child = writeScope(root, "completed", "child.xbrief.json", {
      title: "Completed child",
      status: "completed",
      references: [
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/2322` },
      ],
    });
    writeCachedIssue(root, 1119, { title: "Umbrella tracker", labels: ["epic"] });

    const refs = findOpenUmbrellaReferences(root, child);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.sources).toEqual(expect.arrayContaining(["plan.references", "planRef"]));
  });

  it("suppresses a local parent reference when the cached issue is closed", () => {
    root = makeRepo();
    writeScope(root, "active", "umbrella.xbrief.json", {
      title: "Closed umbrella",
      status: "running",
      metadata: { kind: "epic" },
      references: [
        { type: "x-xbrief/plan", uri: "completed/child.xbrief.json" },
        { type: "x-xbrief/github-issue", uri: `https://github.com/${REPO}/issues/1119` },
      ],
    });
    const child = writeScope(root, "completed", "child.xbrief.json", {
      title: "Completed child",
      status: "completed",
    });
    writeCachedIssue(root, 1119, { title: "Closed umbrella", state: "closed", labels: ["epic"] });

    expect(findOpenUmbrellaReferences(root, child)).toEqual([]);
  });

  it("detects cached open tracker bodies that mention the completed scope issue", () => {
    root = makeRepo();
    const child = writeScope(root, "completed", "child.xbrief.json", {
      title: "Completed child",
      status: "completed",
      references: [
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/2322` },
      ],
    });
    writeCachedIssue(root, 1119, {
      title: "Umbrella tracker",
      labels: ["meta"],
      body: "Current shape still lists #2322 as in flight.",
    });
    writeCachedIssue(root, 1200, {
      title: "Ordinary bug",
      labels: ["bug"],
      body: "Mentions #2322 but is not an umbrella/tracker.",
    });

    const refs = findOpenUmbrellaReferences(root, child);

    expect(refs.map((ref) => ref.issueNumber)).toEqual([1119]);
    expect(refs[0]?.sources).toContain("cached issue body");
  });

  it("scans cross-repo cached markdown URL mentions for qualified completed issue refs", () => {
    root = makeRepo();
    const child = writeScope(root, "completed", "child.xbrief.json", {
      title: "Completed child",
      status: "completed",
      references: [
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/2322` },
      ],
    });
    writeCachedIssue(root, 1119, {
      repo: "deftai/other",
      title: "Other repo umbrella",
      labels: ["bug"],
      contentMarkdown: "Current shape links https://github.com/deftai/directive/issues/2322.",
    });
    writeCachedIssue(root, 1200, {
      repo: "deftai/other",
      title: "Other repo tracker",
      labels: ["meta"],
      body: "This near miss references #23220 only.",
    });

    const refs = findOpenUmbrellaReferences(root, child);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      repo: "deftai/other",
      issueNumber: 1119,
      title: "Other repo umbrella",
    });
  });

  it("uses string labels and sub-issue totals to classify cached trackers", () => {
    root = makeRepo();
    const child = writeScope(root, "completed", "child.xbrief.json", {
      title: "Completed child",
      status: "completed",
      references: [
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/2322` },
      ],
    });
    writeCachedIssue(root, 1119, {
      title: "Label tracker",
      rawLabels: ["umbrella"],
      body: "Current shape still lists #2322.",
    });
    writeCachedIssue(root, 1120, {
      title: "Sub-issue parent",
      subIssuesTotal: 2,
      body: "Current shape still lists #2322.",
    });

    const refs = findOpenUmbrellaReferences(root, child);

    expect(refs.map((ref) => ref.issueNumber)).toEqual([1119, 1120]);
  });

  it("keeps unknown local parent references while ignoring malformed scopes", () => {
    root = makeRepo();
    writeFileSync(join(root, "xbrief", "active", "broken.xbrief.json"), "{", "utf8");
    writeScope(root, "active", "loose-parent.xbrief.json", {
      title: "Loose parent",
      status: "running",
      references: [{ type: "x-xbrief/plan", uri: "completed/child.xbrief.json" }],
    });
    const child = writeScope(root, "completed", "child.xbrief.json", {
      title: "Completed child",
      status: "completed",
    });

    const refs = findOpenUmbrellaReferences(root, child);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      issueNumber: null,
      path: "xbrief/active/loose-parent.xbrief.json",
      title: "Loose parent",
    });
  });

  it("deduplicates local issue refs and preserves unknown local parents", () => {
    root = makeRepo();
    const child = writeScope(root, "completed", "child.xbrief.json", {
      title: "Completed child",
      status: "completed",
    });
    writeScope(root, "active", "a-parent.xbrief.json", {
      status: "running",
      references: [
        { type: "x-xbrief/plan", uri: "completed/child.xbrief.json" },
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/1119` },
      ],
    });
    writeScope(root, "active", "b-parent.xbrief.json", {
      title: "Named umbrella",
      status: "running",
      references: [
        { type: "x-xbrief/plan", uri: "completed/child.xbrief.json" },
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/1119` },
      ],
    });
    writeScope(root, "active", "c-parent.xbrief.json", {
      status: "running",
      planRef: "completed/child.xbrief.json",
    });
    writeScope(root, "active", "d-parent.xbrief.json", {
      title: "Number-only parent",
      status: "running",
      references: [
        { type: "x-xbrief/plan", uri: "completed/child.xbrief.json" },
        { type: "x-vbrief/github-issue", uri: "1118" },
        { type: "x-vbrief/github-issue", uri: "1119" },
      ],
    });

    const refs = findOpenUmbrellaReferences(root, child);

    expect(refs).toHaveLength(3);
    expect(refs.find((ref) => ref.issueNumber === 1119 && ref.repo === REPO)).toMatchObject({
      title: "Named umbrella",
      path: "xbrief/active/a-parent.xbrief.json",
    });
    expect(refs.find((ref) => ref.issueNumber === 1118 && ref.repo === null)).toMatchObject({
      title: "Number-only parent",
    });
    expect(refs.find((ref) => ref.path === "xbrief/active/c-parent.xbrief.json")).toMatchObject({
      title: "open scope",
    });

    const warning = renderOpenUmbrellaWarning([
      { repo: null, issueNumber: null, title: "Manual tracker", path: null, sources: [] },
      ...refs,
    ]);
    expect(warning).toContain("Manual tracker: Manual tracker");
    expect(warning).toContain("#1118");
  });

  it("handles malformed references and cache-directory edge cases", () => {
    root = makeRepo();
    rmSync(join(root, "xbrief", "proposed"), { recursive: true, force: true });
    const child = writeScope(root, "completed", "child.xbrief.json", {
      title: "Completed child",
      status: "completed",
      references: [
        null,
        [],
        { type: "note", uri: "https://github.com/deftai/directive/issues/2322" },
        { type: "x-vbrief/github-issue", uri: "not-an-issue" },
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/2322` },
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/2322` },
      ],
    });
    writeScope(root, "active", "noise.xbrief.json", {
      title: "Noise",
      status: "running",
      references: [
        null,
        [],
        { type: "note", uri: "completed/child.xbrief.json" },
        { type: "x-xbrief/plan", uri: "https://github.com/deftai/directive/issues/2322" },
      ],
    });
    const cacheRoot = join(root, ".deft-cache", "github-issue");
    mkdirSync(join(cacheRoot, "deftai", "directive", "not-a-number"), { recursive: true });
    writeFileSync(join(cacheRoot, "not-owner"), "not a directory", "utf8");
    writeFileSync(join(cacheRoot, "deftai", "not-repo"), "not a directory", "utf8");
    writeFileSync(join(cacheRoot, "deftai", "directive", "readme.txt"), "not a directory", "utf8");
    mkdirSync(join(cacheRoot, "deftai", "directive", "1200"), { recursive: true });
    writeCachedIssue(root, 1119, {
      title: "Omnibus tracker",
      labels: ["bug"],
      body: "Current shape still lists #2322.",
      rawLabels: [{ name: 42 }, []],
    });
    writeCachedIssue(root, 1120, {
      title: "Closed tracker",
      state: "closed",
      labels: ["meta"],
      body: "Current shape still lists #2322.",
    });
    writeCachedIssue(root, 1300, {
      repo: "deftai/other",
      title: "Other repo tracker",
      labels: ["meta"],
      body: "Current shape still lists #2322.",
    });

    const refs = findOpenUmbrellaReferences(root, child);

    expect(refs.map((ref) => ref.issueNumber)).toEqual([1119]);
    expect(refs[0]?.title).toBe("Omnibus tracker");
  });

  it("returns empty results for invalid completed payloads, missing cache, and issue zero", () => {
    root = makeRepo();
    const invalid = join(root, "xbrief", "completed", "invalid.xbrief.json");
    writeFileSync(invalid, "[]\n", "utf8");
    expect(findOpenUmbrellaReferences(root, invalid)).toEqual([]);

    const childWithoutCache = writeScope(root, "completed", "without-cache.xbrief.json", {
      title: "Completed child",
      status: "completed",
      references: [
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/2322` },
      ],
    });
    expect(findOpenUmbrellaReferences(root, childWithoutCache)).toEqual([]);

    const childBare = writeScope(root, "completed", "bare.xbrief.json", {
      title: "Completed child",
      status: "completed",
      references: [{ type: "x-vbrief/github-issue", uri: "2322" }],
    });
    writeCachedIssue(root, 1200, {
      repo: "deftai/other",
      title: "Bare ref near miss",
      labels: ["meta"],
      body: "Current shape still lists #2322.",
    });
    expect(findOpenUmbrellaReferences(root, childBare)).toEqual([]);

    const childZero = writeScope(root, "completed", "zero.xbrief.json", {
      title: "Completed child",
      status: "completed",
      references: [{ type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/0` }],
    });
    writeCachedIssue(root, 1119, {
      title: "Zero tracker",
      labels: ["meta"],
      body: "Current shape still lists #0.",
    });
    expect(findOpenUmbrellaReferences(root, childZero)).toEqual([]);
    expect(completedPathForScopeMove(join(root, "xbrief", "active", "story.xbrief.json"))).toBe(
      join(root, "xbrief", "completed", "story.xbrief.json"),
    );
  });

  it("returns an empty warning for no open references", () => {
    expect(renderOpenUmbrellaWarning([])).toBe("");
  });

  it("prints a non-blocking warning after scope:complete succeeds", () => {
    root = makeRepo();
    writeScope(root, "active", "umbrella.xbrief.json", {
      title: "Umbrella tracker",
      status: "running",
      metadata: { kind: "epic" },
      references: [
        { type: "x-xbrief/plan", uri: "active/child.xbrief.json" },
        { type: "x-xbrief/github-issue", uri: `https://github.com/${REPO}/issues/1119` },
      ],
    });
    const child = writeScope(root, "active", "child.xbrief.json", {
      title: "Completed child",
      status: "running",
      planRef: "active/umbrella.xbrief.json",
      references: [
        { type: "x-vbrief/github-issue", uri: `https://github.com/${REPO}/issues/2322` },
      ],
    });
    writeCachedIssue(root, 1119, { title: "Umbrella tracker", labels: ["epic"] });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Code-bearing (github issue ref) needs explicit non-delivery or delivery evidence (#3041).
    expect(
      lifecycleMain([
        "complete",
        child,
        "--project-root",
        root,
        "--non-delivery",
        "accepted_not_delivered",
      ]),
    ).toBe(0);

    const out = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    const err = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(out).toContain("Completed child.xbrief.json");
    expect(err).toContain("Warning: scope:complete found open umbrella/tracker reference");
    expect(err).toContain("#1119");
  });
});
