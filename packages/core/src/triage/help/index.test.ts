import { describe, expect, it } from "vitest";
import {
  interceptHelp,
  REGISTRY,
  renderCategoryList,
  renderVerbHelp,
  resolveVerbFromArgv,
  runHelp,
} from "./index.js";

describe("help registry", () => {
  it("is non-empty", () => {
    expect(Object.keys(REGISTRY).length).toBeGreaterThanOrEqual(30);
  });
});

describe("renderCategoryList", () => {
  it("includes triage session-start section", () => {
    const out = renderCategoryList("triage");
    expect(out).toContain("Session-start:");
    expect(out).toContain("task triage:summary");
    expect(out).toContain("task triage:subscribe");
  });

  it("includes scope promote section", () => {
    const out = renderCategoryList("scope");
    expect(out).toContain("Promote / demote:");
    expect(out).toContain("task scope:promote");
  });

  it("rejects unknown category", () => {
    expect(() => renderCategoryList("typo")).toThrow(/unknown category/);
  });
});

describe("renderVerbHelp", () => {
  it("renders structured sections for triage:queue", () => {
    const out = renderVerbHelp("task triage:queue");
    expect(out.startsWith("task triage:queue")).toBe(true);
    expect(out).toContain("Usage:");
    expect(out).toContain("Flags:");
    expect(out).toContain("Examples:");
    expect(out).toContain("See also:");
  });

  it("marks placeholder verbs", () => {
    const out = renderVerbHelp("task triage:metrics");
    expect(out).toContain("not yet implemented");
  });
});

describe("interceptHelp", () => {
  it("returns null without help flag", () => {
    expect(interceptHelp("triage_bulk", ["accept", "--repo", "o/r"])).toBeNull();
  });

  it("prints bulk-accept help for triage_bulk accept --help", () => {
    const lines: string[] = [];
    const rc = interceptHelp("triage_bulk", ["accept", "--help"], {
      write: (t) => lines.push(t),
    });
    expect(rc).toBe(0);
    expect(lines.join("")).toContain("task triage:bulk-accept");
  });

  it("prints bulk-defer help for triage_bulk defer --help", () => {
    const lines: string[] = [];
    const rc = interceptHelp("triage_bulk", ["defer", "--help"], {
      write: (t) => lines.push(t),
    });
    expect(rc).toBe(0);
    expect(lines.join("")).toContain("task triage:bulk-defer");
  });

  it("prints bulk-needs-ac help for triage_bulk needs-ac --help", () => {
    const lines: string[] = [];
    const rc = interceptHelp("triage_bulk", ["needs-ac", "--help"], {
      write: (t) => lines.push(t),
    });
    expect(rc).toBe(0);
    expect(lines.join("")).toContain("task triage:bulk-needs-ac");
  });

  it("prints bulk-reject help for triage_bulk reject --help", () => {
    const lines: string[] = [];
    const rc = interceptHelp("triage_bulk", ["reject", "--help"], {
      write: (t) => lines.push(t),
    });
    expect(rc).toBe(0);
    expect(lines.join("")).toContain("task triage:bulk-reject");
  });

  it("resolves subscribe default help", () => {
    expect(resolveVerbFromArgv("triage_subscribe", ["--help"])).toBe("task triage:subscribe");
  });

  it("resolves smoketest default help", () => {
    const lines: string[] = [];
    const rc = interceptHelp("triage_smoketest", ["--help"], {
      write: (t) => lines.push(t),
    });
    expect(rc).toBe(0);
    expect(lines.join("")).toContain("triage:smoketest");
  });
});

describe("runHelp CLI", () => {
  it("lists verbs", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(runHelp(["list"])).toBe(0);
      expect(stdout.join("")).toContain("task triage:queue");
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });

  it("shows scope and rejects unknown verb", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(runHelp(["scope"])).toBe(0);
      expect(stdout.join("")).toContain("Task scope");
      expect(runHelp(["nope"])).toBe(2);
      expect(stderr.join("")).toContain("unknown command");
      expect(runHelp([])).toBe(2);
      expect(runHelp(["help"])).toBe(2);
      expect(runHelp(["help", "task triage:metrics"])).toBe(0);
      expect(runHelp(["-h"])).toBe(0);
      expect(runHelp(["--help"])).toBe(0);
      expect(runHelp(["help", "task triage:missing-verb-xyz"])).toBe(2);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });

  it("normalizes help verb without task prefix", () => {
    const stdout: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => {
      stdout.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runHelp(["help", "triage:queue"])).toBe(0);
      expect(stdout.join("")).toContain("task triage:queue");
    } finally {
      process.stdout.write = orig;
    }
  });
});
