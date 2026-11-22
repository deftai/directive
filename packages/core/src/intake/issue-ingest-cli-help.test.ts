import { afterEach, describe, expect, it, vi } from "vitest";

const requireScmReady = vi.fn();
const issueIngestMain = vi.fn(() => 0);

vi.mock("../scm/readiness.js", () => ({ requireScmReady }));
vi.mock("./issue-ingest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./issue-ingest.js")>();
  return { ...actual, issueIngestMain };
});

const { ISSUE_INGEST_USAGE, mainEntry } = await import("./issue-ingest-cli.js");

describe("issue:ingest --help (#6872)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    requireScmReady.mockClear();
    issueIngestMain.mockClear();
  });

  for (const flag of ["--help", "-h"]) {
    it(`${flag} prints usage on stdout and exits 0 with no SCM check or ingest`, () => {
      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });
      expect(mainEntry([flag])).toBe(0);
      expect(out.join("")).toBe(`${ISSUE_INGEST_USAGE}\n`);
      expect(out.join("")).toContain("usage: deft issue:ingest <N>");
      expect(err.join("")).toBe("");
      expect(requireScmReady).not.toHaveBeenCalled();
      expect(issueIngestMain).not.toHaveBeenCalled();
    });
  }

  it("help wins over other arguments", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(mainEntry(["6872", "--repo", "o/r", "--help"])).toBe(0);
    expect(requireScmReady).not.toHaveBeenCalled();
    expect(issueIngestMain).not.toHaveBeenCalled();
  });

  it("other argument handling is unchanged: the SCM gate runs, then ingest", () => {
    expect(mainEntry(["6872", "--repo", "o/r"])).toBe(0);
    expect(requireScmReady).toHaveBeenCalledTimes(1);
    expect(issueIngestMain).toHaveBeenCalledWith(
      expect.objectContaining({ number: 6872, repo: "o/r" }),
    );
  });

  it("a flag value of -h is a value, not help", () => {
    expect(mainEntry(["--all", "--label", "-h"])).toBe(0);
    expect(requireScmReady).toHaveBeenCalledTimes(1);
    expect(issueIngestMain).toHaveBeenCalledWith(expect.objectContaining({ label: "-h" }));
  });
});
