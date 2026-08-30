import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { CURRENT_SHAPE_SIDECAR, RAW_ISSUE_COMMENTS_KEY } from "../umbrella-current-shape/index.js";
import {
  cacheGet,
  cacheInvalidate,
  cachePrune,
  cachePut,
  isFresh,
  renderContent,
} from "./operations.js";
import { FixedClock } from "./test-helpers.js";
import type { PutResult } from "./types.js";

const itSymlink = it.skipIf(process.platform === "win32");

function goodRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 883,
    title: "feat(cache): test entry",
    body: "clean issue body",
    state: "open",
    ...overrides,
  };
}

describe("cachePut / cacheGet TTL", () => {
  it("returns entry until TTL expires", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-"));
    const clock = new FixedClock(new Date("2026-06-19T12:00:00Z"));
    try {
      cachePut("github-issue", "deftai/directive/100", goodRaw({ number: 100 }), {
        cacheRoot: root,
        ttlSeconds: 60,
        clock,
        fetchedAt: clock.now(),
      });
      const hit = cacheGet("github-issue", "deftai/directive/100", { cacheRoot: root, clock });
      expect(hit.stale).toBe(false);
      expect(hit.contentPath).not.toBeNull();

      clock.advanceSeconds(61);
      const stale = cacheGet("github-issue", "deftai/directive/100", {
        cacheRoot: root,
        clock,
        allowStale: true,
      });
      expect(stale.stale).toBe(true);

      expect(() =>
        cacheGet("github-issue", "deftai/directive/100", {
          cacheRoot: root,
          clock,
          allowStale: false,
        }),
      ).toThrow(/stale/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cacheInvalidate / cachePrune", () => {
  it("invalidate removes entry; prune drops expired", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-"));
    const clock = new FixedClock(new Date("2026-06-01T00:00:00Z"));
    try {
      cachePut("github-issue", "deftai/directive/200", goodRaw({ number: 200 }), {
        cacheRoot: root,
        ttlSeconds: 1,
        clock,
        fetchedAt: clock.now(),
      });
      expect(
        cacheInvalidate("github-issue", "deftai/directive/200", { cacheRoot: root, clock }),
      ).toBe(true);
      expect(existsSync(join(root, "github-issue/deftai/directive/200/meta.json"))).toBe(false);

      cachePut("github-issue", "deftai/directive/201", goodRaw({ number: 201 }), {
        cacheRoot: root,
        ttlSeconds: 1,
        clock,
        fetchedAt: new Date("2026-05-01T00:00:00Z"),
      });
      clock.setNow(new Date("2026-06-19T00:00:00Z"));
      const removed = cachePrune({ cacheRoot: root, olderThanDays: 30, clock });
      expect(removed.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("quarantine hard-fail", () => {
  it("skips content.md for credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-"));
    try {
      const result = cachePut(
        "github-issue",
        "deftai/directive/884",
        goodRaw({ number: 884, body: `oops: AKIA${"A".repeat(16)}` }),
        { cacheRoot: root },
      );
      expect(result.contentWritten).toBe(false);
      expect(existsSync(join(result.entryDir, "content.md"))).toBe(false);
      expect(result.scanResult.passed).toBe(false);
      const get = cacheGet("github-issue", "deftai/directive/884", { cacheRoot: root });
      expect(get.contentPath).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isFresh", () => {
  it("returns false for missing meta", () => {
    expect(isFresh("/no/such/meta.json")).toBe(false);
  });
});

describe("current-shape cache visibility (#1870)", () => {
  const shapeBody =
    "## Current shape (as of pass-2)\n\n" +
    "Last updated: 2026-06-28T12:00:00Z\n" +
    "Last pass type: additive\n" +
    "Child count: 2 (1/1)\n" +
    "Child-count history: pass-1: 1, pass-2: 2\n\n" +
    "### Open children\n\n- a\n\n### Closed children\n\n- b\n\n" +
    "### Wave order\n\n- Wave 1\n\n### Reading order for fresh contributors\n\n1. Body\n";

  it("renderContent appends canonical current shape from comments", () => {
    const rendered = renderContent("github-issue", {
      number: 1669,
      title: "Umbrella",
      body: "stale charter only",
      [RAW_ISSUE_COMMENTS_KEY]: [
        {
          id: 99,
          body: shapeBody,
          html_url: "https://github.com/o/r/issues/1669#issuecomment-99",
          author_association: "MEMBER",
          user: { login: "maint" },
        },
      ],
    });
    expect(rendered).toContain("# #1669: Umbrella");
    expect(rendered).toContain("stale charter only");
    expect(rendered).toContain("Canonical current shape (#1152 / #1870)");
    expect(rendered).toContain("pass-2");
    expect(rendered).toContain("issuecomment-99");
  });

  it("cachePut writes content.md + current-shape.json sidecar with permalink", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-shape-"));
    try {
      const result = cachePut(
        "github-issue",
        "deftai/directive/1669",
        goodRaw({
          number: 1669,
          title: "Umbrella tracker",
          body: "charter body",
          labels: [{ name: "epic" }],
          [RAW_ISSUE_COMMENTS_KEY]: [
            {
              id: 77,
              body: shapeBody,
              html_url: "https://github.com/deftai/directive/issues/1669#issuecomment-77",
              author_association: "OWNER",
              user: { login: "owner" },
            },
          ],
        }),
        { cacheRoot: root },
      );
      expect(result.contentWritten).toBe(true);
      const content = readFileSync(join(result.entryDir, "content.md"), "utf8");
      expect(content).toContain("Canonical current shape");
      expect(content).toContain("charter body");
      const sidecarPath = join(result.entryDir, CURRENT_SHAPE_SIDECAR);
      expect(existsSync(sidecarPath)).toBe(true);
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
      expect(sidecar.commentId).toBe(77);
      expect(sidecar.pass).toBe(2);
      expect(String(sidecar.htmlUrl)).toContain("issuecomment-77");
      expect(String(sidecar.body)).toContain("Current shape (as of pass-2)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const contributorDraft = {
    id: 5460037833,
    body: "## Current shape (as of pass-1)\n\nDRAFT-MARKER-MUST-NOT-BE-ECHOED",
    html_url: "https://github.com/deftai/directive/issues/3915#issuecomment-5460037833",
    author_association: "CONTRIBUTOR",
    user: { login: "dbcall2" },
  };

  it("cachePut records why no shape was selected on a contributor-only thread (#3934)", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-shape-null-"));
    try {
      const result = cachePut(
        "github-issue",
        "deftai/directive/3915",
        goodRaw({
          number: 3915,
          title: "Umbrella tracker",
          body: "superseded charter body",
          labels: [{ name: "epic" }],
          [RAW_ISSUE_COMMENTS_KEY]: [contributorDraft],
        }),
        { cacheRoot: root },
      );
      expect(result.contentWritten).toBe(true);
      const content = readFileSync(join(result.entryDir, "content.md"), "utf8");
      expect(content).toContain("## Canonical current shape: not selected (#1152 / #2307)");
      expect(content).toContain("comment 5460037833 (CONTRIBUTOR)");
      expect(content).toContain("superseded charter body");
      // The note reports the discard; it never reproduces the discarded body.
      expect(content).not.toContain("DRAFT-MARKER-MUST-NOT-BE-ECHOED");
      // Advisory only: still no sidecar, exactly as before #3934.
      expect(existsSync(join(result.entryDir, CURRENT_SHAPE_SIDECAR))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cachePut output is byte-identical when a selected shape coexists with a draft (#3934)", () => {
    const maintainerShape = {
      id: 5466380241,
      body: shapeBody,
      html_url: "https://github.com/deftai/directive/issues/3915#issuecomment-5466380241",
      author_association: "MEMBER",
      user: { login: "maint" },
    };
    const roots = [
      mkdtempSync(join(tmpdir(), "deft-cache-shape-mixed-")),
      mkdtempSync(join(tmpdir(), "deft-cache-shape-clean-")),
    ];
    try {
      const [mixed, clean] = [[contributorDraft, maintainerShape], [maintainerShape]].map(
        (comments, i) =>
          cachePut(
            "github-issue",
            "deftai/directive/3915",
            goodRaw({
              number: 3915,
              title: "Umbrella tracker",
              body: "superseded charter body",
              labels: [{ name: "epic" }],
              [RAW_ISSUE_COMMENTS_KEY]: comments,
            }),
            { cacheRoot: roots[i] as string },
          ),
      );
      const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
      expect(read((mixed as PutResult).entryDir, "content.md")).toBe(
        read((clean as PutResult).entryDir, "content.md"),
      );
      expect(read((mixed as PutResult).entryDir, CURRENT_SHAPE_SIDECAR)).toBe(
        read((clean as PutResult).entryDir, CURRENT_SHAPE_SIDECAR),
      );
    } finally {
      for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe("audit log", () => {
  it("appends cache:put records", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-cache-"));
    try {
      cachePut("github-issue", "deftai/directive/887", goodRaw({ number: 887 }), {
        cacheRoot: root,
      });
      const audit = readFileSync(join(root, "quarantine-audit.jsonl"), "utf8");
      expect(audit).toContain('"event":"cache:put"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cache containment (#2470)", () => {
  itSymlink("refuses cache put when .deft-cache is a symlink outside the project", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cache-contain-proj-"));
    const escapeTarget = mkdtempSync(join(tmpdir(), "cache-contain-escape-"));
    const escapeFile = join(escapeTarget, "stolen-cache");
    try {
      writeFileSync(escapeFile, "", { encoding: "utf8" });
      symlinkSync(escapeFile, join(projectDir, ".deft-cache"));
      expect(() =>
        cachePut("github-issue", "deftai/directive/900", goodRaw({ number: 900 }), {
          cacheRoot: join(projectDir, ".deft-cache"),
        }),
      ).toThrow(ProjectionContainmentError);
      expect(readFileSync(escapeFile, { encoding: "utf8" })).toBe("");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
});
