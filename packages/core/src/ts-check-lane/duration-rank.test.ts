import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRankLines,
  main,
  omissionNoteForHeartbeat,
  parseFileDurationLine,
  parseTopN,
  rankFileDurations,
  rankTeeFile,
  rankTeeText,
  scrapeFileDurations,
} from "./duration-rank.js";
import { formatFileDurationLine, PROGRESS_FILE_HEARTBEAT_MS } from "./progress.js";

describe("parseFileDurationLine", () => {
  it("parses formatFileDurationLine output", () => {
    const line = formatFileDurationLine("packages/core/src/foo.test.ts", 45_000, "unit");
    expect(parseFileDurationLine(line)).toEqual({
      file: "packages/core/src/foo.test.ts",
      elapsedMs: 45_000,
      project: "unit",
    });
  });

  it("ignores last-file and progress lines", () => {
    expect(parseFileDurationLine("ts:check-lane last-file a.test.ts (1/10 files)")).toBeNull();
    expect(parseFileDurationLine("ts:check-lane 20% (2/10 files)")).toBeNull();
    expect(
      parseFileDurationLine("ts:check-lane timeline project unit complete 1000ms files=3"),
    ).toBeNull();
  });
});

describe("scrape + rank", () => {
  it("ranks by duration descending and respects topN", () => {
    const text = [
      formatFileDurationLine("a.test.ts", 40_000, "unit"),
      formatFileDurationLine("b.test.ts", 90_000, "spawn-heavy"),
      formatFileDurationLine("c.test.ts", 60_000, "unit"),
      "noise",
    ].join("\n");
    const scraped = scrapeFileDurations(text);
    expect(scraped).toHaveLength(3);
    const ranked = rankFileDurations(scraped, 2);
    expect(ranked.map((e) => e.file)).toEqual(["b.test.ts", "c.test.ts"]);
  });

  it("last-wins on duplicate file+project keys", () => {
    const text = [
      formatFileDurationLine("a.test.ts", 40_000, "unit"),
      formatFileDurationLine("a.test.ts", 55_000, "unit"),
    ].join("\n");
    expect(scrapeFileDurations(text)).toEqual([
      { file: "a.test.ts", elapsedMs: 55_000, project: "unit" },
    ]);
  });

  it("rankTeeText returns omission note and fails closed on empty", () => {
    const ok = rankTeeText(formatFileDurationLine("a.test.ts", 31_000, "unit"), 5);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.omissionNote).toContain(String(PROGRESS_FILE_HEARTBEAT_MS));
      expect(ok.entries).toHaveLength(1);
    }
    const empty = rankTeeText("ts:check-lane last-file only\n", 5);
    expect(empty).toEqual(
      expect.objectContaining({
        ok: false,
        kind: "no-duration-lines",
      }),
    );
  });

  it("formatRankLines prints stable columns", () => {
    expect(formatRankLines([{ file: "a.test.ts", elapsedMs: 31_000, project: "unit" }])).toEqual([
      " 1.    31000ms  a.test.ts  project=unit",
    ]);
  });
});

describe("parseTopN", () => {
  it("requires an explicit positive integer (no coded default)", () => {
    expect(parseTopN(undefined)).toEqual(expect.objectContaining({ ok: false, kind: "bad-top" }));
    expect(parseTopN("")).toEqual(expect.objectContaining({ ok: false, kind: "bad-top" }));
    expect(parseTopN("20")).toEqual({ ok: true, topN: 20 });
  });

  it("returns bad-top for non-positive values", () => {
    expect(parseTopN("0")).toEqual(expect.objectContaining({ ok: false, kind: "bad-top" }));
    expect(parseTopN("x")).toEqual(expect.objectContaining({ ok: false, kind: "bad-top" }));
  });

  it("states the 30s omission explicitly", () => {
    expect(omissionNoteForHeartbeat()).toMatch(/sub-30s files are never ranked/);
  });
});

describe("rankTeeFile / main", () => {
  const temps: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a tee file and returns ranked entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "duration-rank-"));
    temps.push(dir);
    const path = join(dir, "tee.log");
    writeFileSync(
      path,
      [
        formatFileDurationLine("slow.test.ts", 80_000, "unit"),
        formatFileDurationLine("mid.test.ts", 50_000, "unit"),
      ].join("\n"),
      "utf8",
    );
    const result = rankTeeFile(path, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries[0]?.file).toBe("slow.test.ts");
    }
  });

  it("returns read-error without throwing", () => {
    const result = rankTeeFile(join(tmpdir(), "missing-duration-rank-tee.log"), 5);
    expect(result).toEqual(expect.objectContaining({ ok: false, kind: "read-error" }));
  });

  it("main prints top rows and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "duration-rank-main-"));
    temps.push(dir);
    const path = join(dir, "tee.log");
    writeFileSync(path, formatFileDurationLine("z.test.ts", 33_000, "unit"), "utf8");
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    expect(main(["--top", "5", path])).toBe(0);
    expect(out.join("")).toContain("z.test.ts");
    expect(err.join("")).toBe("");
  });

  it("main returns 1 when --top is omitted", () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    expect(main(["tee.log"])).toBe(1);
    expect(err.join("")).toContain("Usage:");
  });
});
