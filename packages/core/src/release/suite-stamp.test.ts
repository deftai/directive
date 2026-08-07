import { describe, expect, it } from "vitest";
import {
  evaluateSuiteStamp,
  isValidHeadSha,
  parseSuiteStamp,
  readSuiteStamp,
  writeSuiteStamp,
} from "./suite-stamp.js";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

describe("parseSuiteStamp / isValidHeadSha", () => {
  it("accepts valid stamp JSON", () => {
    const stamp = parseSuiteStamp(
      JSON.stringify({
        schemaVersion: 1,
        headSha: SHA,
        suite: "pass",
        debtIssue: null,
        recordedAt: "2026-08-07T00:00:00.000Z",
      }),
    );
    expect(stamp).toEqual({
      schemaVersion: 1,
      headSha: SHA,
      suite: "pass",
      debtIssue: null,
      recordedAt: "2026-08-07T00:00:00.000Z",
    });
  });

  it("rejects corrupt / wrong schema", () => {
    expect(parseSuiteStamp("{}")).toBeNull();
    expect(parseSuiteStamp("not-json")).toBeNull();
    expect(
      parseSuiteStamp(
        JSON.stringify({
          schemaVersion: 2,
          headSha: SHA,
          suite: "pass",
          debtIssue: null,
          recordedAt: "t",
        }),
      ),
    ).toBeNull();
    expect(isValidHeadSha("zzzz")).toBe(false);
  });
});

describe("write/read/evaluate suite stamp", () => {
  it("round-trips via seams (no disk required)", () => {
    const files = new Map<string, string>();
    const io = {
      fileExists: (p: string) => files.has(p),
      readFile: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw new Error("missing");
        return v;
      },
      writeFile: (p: string, c: string) => {
        files.set(p, c);
      },
      mkdirp: () => undefined,
    };

    writeSuiteStamp(
      "/proj",
      {
        headSha: SHA,
        suite: "pass_with_debt",
        debtIssue: 3185,
        recordedAt: "2026-08-07T12:00:00.000Z",
      },
      io,
    );

    const read = readSuiteStamp("/proj", io);
    expect(read?.debtIssue).toBe(3185);
    expect(read?.suite).toBe("pass_with_debt");

    expect(
      evaluateSuiteStamp({
        projectRoot: "/proj",
        headSha: SHA,
        treeClean: true,
        io,
      }),
    ).toEqual({ kind: "hit", stamp: read });
  });

  it("misses on dirty tree, different HEAD, CI, or missing stamp", () => {
    const files = new Map<string, string>();
    const io = {
      fileExists: (p: string) => files.has(p),
      readFile: (p: string) => files.get(p) ?? "",
      writeFile: (p: string, c: string) => {
        files.set(p, c);
      },
      mkdirp: () => undefined,
    };
    writeSuiteStamp("/proj", { headSha: SHA, suite: "pass", debtIssue: null, recordedAt: "t" }, io);

    expect(
      evaluateSuiteStamp({
        projectRoot: "/proj",
        headSha: SHA,
        treeClean: false,
        io,
      }).kind,
    ).toBe("miss");

    expect(
      evaluateSuiteStamp({
        projectRoot: "/proj",
        headSha: "ffffffffffffffffffffffffffffffffffffffff",
        treeClean: true,
        io,
      }).kind,
    ).toBe("miss");

    expect(
      evaluateSuiteStamp({
        projectRoot: "/proj",
        headSha: SHA,
        treeClean: true,
        isCi: true,
        io,
      }),
    ).toEqual({ kind: "miss", reason: expect.stringMatching(/CI never trusts/) });

    expect(
      evaluateSuiteStamp({
        projectRoot: "/other",
        headSha: SHA,
        treeClean: true,
        io,
      }).kind,
    ).toBe("miss");
  });

  it("refuses pass_with_debt without debtIssue", () => {
    expect(() =>
      writeSuiteStamp(
        "/proj",
        { headSha: SHA, suite: "pass_with_debt", debtIssue: null, recordedAt: "t" },
        {
          writeFile: () => undefined,
          mkdirp: () => undefined,
          fileExists: () => false,
          readFile: () => "",
        },
      ),
    ).toThrow(/debtIssue/);
  });
});
