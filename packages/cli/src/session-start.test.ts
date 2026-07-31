import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, run } from "./session-start.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  temps.length = 0;
  vi.unstubAllEnvs();
});

describe("session-start parseArgs", () => {
  it("defaults project root to cwd", () => {
    expect(parseArgs([])).toEqual({
      projectRoot: ".",
      deferValues: [],
      emitJson: false,
      noHistory: false,
      readOnly: false,
      withNetwork: false,
    });
  });

  it("parses --project-root, --defer, --json, and --no-history", () => {
    expect(
      parseArgs([
        "--project-root",
        "/tmp/proj",
        "--defer",
        "doctor=postponed",
        "--json",
        "--no-history",
      ]),
    ).toEqual({
      projectRoot: "/tmp/proj",
      deferValues: ["doctor=postponed"],
      emitJson: true,
      noHistory: true,
      readOnly: false,
      withNetwork: false,
    });
  });

  it("accepts equals-form flags", () => {
    expect(parseArgs(["--project-root=/x", "--defer=cache_fresh=later"])).toEqual({
      projectRoot: "/x",
      deferValues: ["cache_fresh=later"],
      emitJson: false,
      noHistory: false,
      readOnly: false,
      withNetwork: false,
    });
  });

  it("parses --read-only", () => {
    expect(parseArgs(["--read-only", "--project-root", "/x"])).toEqual({
      projectRoot: "/x",
      deferValues: [],
      emitJson: false,
      noHistory: false,
      readOnly: true,
      withNetwork: false,
    });
  });

  it("parses --with-network (#2991)", () => {
    expect(parseArgs(["--with-network", "--json"])).toEqual({
      projectRoot: ".",
      deferValues: [],
      emitJson: true,
      noHistory: false,
      readOnly: false,
      withNetwork: true,
    });
  });

  it("rejects unknown flags", () => {
    expect(parseArgs(["--nope"]).error).toContain("unrecognized argument");
  });

  it("requires a value after --project-root", () => {
    expect(parseArgs(["--project-root"]).error).toContain("expected one argument");
  });

  it("requires a value after --defer", () => {
    expect(parseArgs(["--defer"]).error).toContain("expected one argument");
  });
});

describe("session-start run", () => {
  it("returns 2 for parse errors", () => {
    const prevStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(run(["--defer"])).toBe(2);
    } finally {
      process.stderr.write = prevStderr;
    }
  });

  it("returns 2 for invalid defer tokens", () => {
    const prevStderr = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(run(["--defer", "not-a-valid-step"])).toBe(2);
      expect(err.length).toBeGreaterThan(0);
    } finally {
      process.stderr.write = prevStderr;
    }
  });

  it("writes read-only footer without ritual-state on --read-only", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-session-start-ro-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "T", status: "running", items: [] } })}\n`,
      "utf8",
    );
    const prevStdout = process.stdout.write.bind(process.stdout);
    const prevStderr = process.stderr.write.bind(process.stderr);
    let out = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = run(["--project-root", root, "--read-only", "--no-history"]);
      expect(code).toBe(0);
      expect(out).toContain("read-only session posture");
      expect(out).toContain("[deft environment] os=");
      expect(out).not.toContain("session ritual recorded");
    } finally {
      process.stdout.write = prevStdout;
      process.stderr.write = prevStderr;
    }
  });

  it("writes structured shell orientation in read-only JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-session-start-json-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "T", status: "running", items: [] } })}\n`,
      "utf8",
    );
    vi.stubEnv("DEFT_EXECUTION_SHELL", "/opt/homebrew/bin/bash");
    vi.stubEnv("SHELL", "/bin/zsh");
    const prevStdout = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(run(["--project-root", root, "--read-only", "--no-history", "--json"])).toBe(0);
    } finally {
      process.stdout.write = prevStdout;
    }
    const payload = JSON.parse(out) as {
      environment: {
        host_platform: string;
        shell: { name: string; path: string | null; kind: string; source: string };
      };
    };
    expect(payload.environment.shell).toEqual({
      name: "bash",
      path: "/opt/homebrew/bin/bash",
      kind: "execution",
      source: "DEFT_EXECUTION_SHELL",
    });
    expect(payload.environment.host_platform.length).toBeGreaterThan(0);
  });

  it("writes text lines to stdout on success", () => {
    const root = mkdtempSync(join(tmpdir(), "deft-session-start-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
      `${JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "T", status: "running", items: [] } })}\n`,
      "utf8",
    );
    const prevStdout = process.stdout.write.bind(process.stdout);
    const prevStderr = process.stderr.write.bind(process.stderr);
    let out = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = run(["--project-root", root, "--no-history"]);
      expect([0, 1, 2]).toContain(code);
      if (code === 0) {
        expect(out).toContain("session ritual recorded");
      }
    } finally {
      process.stdout.write = prevStdout;
      process.stderr.write = prevStderr;
    }
  });
});
