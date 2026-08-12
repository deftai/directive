import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctorHelp } from "./help.js";
import { cmdDoctor } from "./main.js";
import {
  filterCodaEntries,
  formatSessionCodaEnabledLine,
  hashU32,
  loadSessionCodas,
  projectRootRealpath,
  resolveSessionCodaLine,
  SESSION_CODA_OFF_HINT,
  SESSION_CODA_STAR_PREFIX,
  selectSessionCoda,
  sessionCodaHelpText,
  sessionCodaMode,
  shouldEmitSessionCodaLine,
  utcDateYmd,
} from "./session-coda.js";

const SEED_CODAS = [
  "A one-shot plan beats a ten-shot apology.",
  "If the agent re-asked, the standard was soft.",
  "Doctor first. Then continue.",
  "Ship the small true thing.",
];

describe("sessionCodaMode", () => {
  it("maps three-state env", () => {
    expect(sessionCodaMode(undefined)).toBe("unset");
    expect(sessionCodaMode("")).toBe("unset");
    expect(sessionCodaMode("1")).toBe("on");
    expect(sessionCodaMode("0")).toBe("off");
    expect(sessionCodaMode("true")).toBe("unset");
  });
});

describe("shouldEmitSessionCodaLine gate matrix", () => {
  const cases: Array<{
    name: string;
    tty: boolean;
    ci: boolean;
    json: boolean;
    exitOk: boolean;
    expect: boolean;
  }> = [
    { name: "interactive success", tty: true, ci: false, json: false, exitOk: true, expect: true },
    { name: "non-TTY", tty: false, ci: false, json: false, exitOk: true, expect: false },
    { name: "CI", tty: true, ci: true, json: false, exitOk: true, expect: false },
    { name: "json", tty: true, ci: false, json: true, exitOk: true, expect: false },
    { name: "hard fail", tty: true, ci: false, json: false, exitOk: false, expect: false },
    {
      name: "all gates fail",
      tty: false,
      ci: true,
      json: true,
      exitOk: false,
      expect: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        shouldEmitSessionCodaLine({
          tty: c.tty,
          ci: c.ci,
          json: c.json,
          exitOk: c.exitOk,
        }),
      ).toBe(c.expect);
    });
  }
});

describe("hashU32 + selectSessionCoda determinism", () => {
  it("is stable for fixed inputs", () => {
    const a = hashU32("2026-08-12\0/tmp/proj");
    const b = hashU32("2026-08-12\0/tmp/proj");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
  });

  it("selects the same line for fixed date + root", () => {
    const first = selectSessionCoda({
      date: "2026-08-12",
      projectRoot: "/fixed/root",
      codas: SEED_CODAS,
    });
    const second = selectSessionCoda({
      date: "2026-08-12",
      projectRoot: "/fixed/root",
      codas: SEED_CODAS,
    });
    expect(first).toBe(second);
    expect(first).not.toBeNull();
    expect(SEED_CODAS).toContain(first);
  });

  it("date rollover can change index", () => {
    const a = selectSessionCoda({
      date: "2026-08-12",
      projectRoot: "/fixed/root",
      codas: SEED_CODAS,
    });
    const b = selectSessionCoda({
      date: "2026-08-13",
      projectRoot: "/fixed/root",
      codas: SEED_CODAS,
    });
    // With 4 lines, collision is possible but uncommon; assert hash keys differ
    // and selection is still a valid pack member.
    expect(hashU32("2026-08-12\0/fixed/root")).not.toBe(hashU32("2026-08-13\0/fixed/root"));
    expect(SEED_CODAS).toContain(a);
    expect(SEED_CODAS).toContain(b);
  });

  it("returns null for empty codas", () => {
    expect(selectSessionCoda({ date: "2026-08-12", projectRoot: "/r", codas: [] })).toBeNull();
  });
});

describe("filterCodaEntries length filter", () => {
  it("skips non-strings, empty, and >100 chars", () => {
    const long = "x".repeat(101);
    expect(filterCodaEntries(["ok", "", long, 12, null, "also ok"])).toEqual(["ok", "also ok"]);
  });

  it("returns [] for non-array", () => {
    expect(filterCodaEntries({ lines: ["a"] })).toEqual([]);
    expect(filterCodaEntries(null)).toEqual([]);
  });
});

describe("resolveSessionCodaLine", () => {
  it("unset + gates ⇒ fixed off-hint without star", () => {
    const line = resolveSessionCodaLine({
      mode: "unset",
      shouldEmit: true,
      date: "2026-08-12",
      projectRoot: "/r",
      codas: SEED_CODAS,
    });
    expect(line).toBe(SESSION_CODA_OFF_HINT);
    expect(line).not.toContain("\u2726");
  });

  it("=0 ⇒ silent", () => {
    expect(
      resolveSessionCodaLine({
        mode: "off",
        shouldEmit: true,
        date: "2026-08-12",
        projectRoot: "/r",
        codas: SEED_CODAS,
      }),
    ).toBeNull();
  });

  it("=1 ⇒ exactly one star line", () => {
    const line = resolveSessionCodaLine({
      mode: "on",
      shouldEmit: true,
      date: "2026-08-12",
      projectRoot: "/r",
      codas: SEED_CODAS,
    });
    expect(line).not.toBeNull();
    expect(line?.startsWith(SESSION_CODA_STAR_PREFIX)).toBe(true);
    const body = selectSessionCoda({
      date: "2026-08-12",
      projectRoot: "/r",
      codas: SEED_CODAS,
    });
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(line).toBe(formatSessionCodaEnabledLine(body));
  });

  it("=1 + empty pack ⇒ omit star", () => {
    expect(
      resolveSessionCodaLine({
        mode: "on",
        shouldEmit: true,
        date: "2026-08-12",
        projectRoot: "/r",
        codas: [],
      }),
    ).toBeNull();
  });

  it("gates fail ⇒ nothing even when on", () => {
    expect(
      resolveSessionCodaLine({
        mode: "on",
        shouldEmit: false,
        date: "2026-08-12",
        projectRoot: "/r",
        codas: SEED_CODAS,
      }),
    ).toBeNull();
  });
});

describe("loadSessionCodas fail-open", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when pack missing", () => {
    const root = mkdtempSync(join(tmpdir(), "coda-miss-"));
    created.push(root);
    mkdirSync(join(root, "content"), { recursive: true });
    expect(loadSessionCodas(root)).toEqual([]);
  });

  it("returns [] when pack invalid JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "coda-bad-"));
    created.push(root);
    mkdirSync(join(root, "content", "doctor"), { recursive: true });
    writeFileSync(join(root, "content", "doctor", "session-coda.json"), "{not-json", "utf8");
    expect(loadSessionCodas(root)).toEqual([]);
  });

  it("loads valid pack under content/", () => {
    const root = mkdtempSync(join(tmpdir(), "coda-ok-"));
    created.push(root);
    mkdirSync(join(root, "content", "doctor"), { recursive: true });
    writeFileSync(
      join(root, "content", "doctor", "session-coda.json"),
      JSON.stringify(["Short line.", "x".repeat(101), "Another."]),
      "utf8",
    );
    expect(loadSessionCodas(root)).toEqual(["Short line.", "Another."]);
  });

  it("uses readText seam when provided", () => {
    expect(loadSessionCodas("/unused", () => JSON.stringify(["via-seam"]))).toEqual(["via-seam"]);
    expect(loadSessionCodas("/unused", () => null)).toEqual([]);
  });
});

describe("utcDateYmd + projectRootRealpath + help", () => {
  it("formats UTC date", () => {
    expect(utcDateYmd(new Date("2026-08-12T23:30:00Z"))).toBe("2026-08-12");
  });

  it("realpath falls back on missing path", () => {
    expect(projectRootRealpath(join(tmpdir(), "no-such-coda-root-xyz"))).toContain(
      "no-such-coda-root-xyz",
    );
  });

  it("help documents three-state env and examples", () => {
    const help = formatDoctorHelp();
    expect(help).toContain("DEFT_SESSION_CODA");
    expect(help).toContain(SESSION_CODA_OFF_HINT);
    expect(help).toContain("\u2726 ");
    expect(help).toContain("=0");
    expect(help).toContain("=1");
    expect(sessionCodaHelpText()).toContain(SESSION_CODA_OFF_HINT);
  });
});

describe("cmdDoctor session coda wiring (#2712)", () => {
  function captureDoctor(
    args: string[],
    seams: Parameters<typeof cmdDoctor>[1],
  ): { exit: number; out: string } {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = cmdDoctor(args, seams);
      return { exit, out: chunks.join("") };
    } finally {
      process.stdout.write = orig;
    }
  }

  const baseSeams = {
    whichFn: () => "/usr/bin/x",
    stdoutIsTty: () => true,
    ciEnv: undefined as string | undefined,
    now: () => new Date("2026-08-12T12:00:00Z"),
    loadSessionCodas: () => SEED_CODAS,
  };

  it("default unset: interactive success ⇒ off-hint, no star", () => {
    const { exit, out } = captureDoctor(["--full"], {
      ...baseSeams,
      sessionCodaEnv: undefined,
    });
    expect(exit).toBe(0);
    expect(out).toContain("System check passed!");
    expect(out).toContain(SESSION_CODA_OFF_HINT);
    expect(out).not.toContain("\u2726");
    // After final footer: blank then hint
    const idx = out.indexOf("System check passed!");
    const after = out.slice(idx);
    expect(after.indexOf(SESSION_CODA_OFF_HINT)).toBeGreaterThan(0);
  });

  it("=0: interactive success ⇒ silent", () => {
    const { exit, out } = captureDoctor(["--full"], {
      ...baseSeams,
      sessionCodaEnv: "0",
    });
    expect(exit).toBe(0);
    expect(out).toContain("System check passed!");
    expect(out).not.toContain(SESSION_CODA_OFF_HINT);
    expect(out).not.toContain("\u2726");
  });

  it("=1: interactive success ⇒ exactly one star line after footer", () => {
    const { exit, out } = captureDoctor(["--full"], {
      ...baseSeams,
      sessionCodaEnv: "1",
    });
    expect(exit).toBe(0);
    expect(out).toContain("System check passed!");
    const stars = out.match(/\u2726 /g) ?? [];
    expect(stars).toHaveLength(1);
    expect(out).not.toContain(SESSION_CODA_OFF_HINT);
    const expected = resolveSessionCodaLine({
      mode: "on",
      shouldEmit: true,
      date: "2026-08-12",
      projectRoot: projectRootRealpath(process.cwd()),
      codas: SEED_CODAS,
    });
    expect(out).toContain(expected ?? "MISSING");
  });

  it("json mode: no coda field, no star, no off-hint", () => {
    const { exit, out } = captureDoctor(["--full", "--json"], {
      ...baseSeams,
      sessionCodaEnv: "1",
    });
    expect(exit).toBe(0);
    expect(out).toContain('"status": "completed"');
    expect(out).not.toContain("\u2726");
    expect(out).not.toContain(SESSION_CODA_OFF_HINT);
    expect(out).not.toContain("session_coda");
    expect(out).not.toContain("sessionCoda");
  });

  it("soft green (warnings): coda still allowed", () => {
    const { exit, out } = captureDoctor(["--full"], {
      ...baseSeams,
      sessionCodaEnv: "1",
      // node missing ⇒ warning path (exit 0 with warnings)
      whichFn: (c) => (c === "node" ? null : "/bin/x"),
    });
    expect(exit).toBe(0);
    expect(out).toContain("System check completed with");
    expect(out).toMatch(/\u2726 /);
  });

  it("hard fail: no off-hint, no coda", () => {
    const { exit, out } = captureDoctor(["--full"], {
      ...baseSeams,
      sessionCodaEnv: "1",
      whichFn: () => null,
    });
    expect(exit).toBe(1);
    expect(out).toContain("System check failed");
    expect(out).not.toContain("\u2726");
    expect(out).not.toContain(SESSION_CODA_OFF_HINT);
  });

  it("non-TTY: silent", () => {
    const { exit, out } = captureDoctor(["--full"], {
      ...baseSeams,
      stdoutIsTty: () => false,
      sessionCodaEnv: undefined,
    });
    expect(exit).toBe(0);
    expect(out).not.toContain(SESSION_CODA_OFF_HINT);
    expect(out).not.toContain("\u2726");
  });

  it("CI: silent", () => {
    const { exit, out } = captureDoctor(["--full"], {
      ...baseSeams,
      ciEnv: "true",
      sessionCodaEnv: "1",
    });
    expect(exit).toBe(0);
    expect(out).not.toContain("\u2726");
    expect(out).not.toContain(SESSION_CODA_OFF_HINT);
  });

  it("pack load fail with =1: still exit 0, no star", () => {
    const { exit, out } = captureDoctor(["--full"], {
      ...baseSeams,
      sessionCodaEnv: "1",
      loadSessionCodas: () => [],
    });
    expect(exit).toBe(0);
    expect(out).toContain("System check passed!");
    expect(out).not.toContain("\u2726");
  });

  it("--help documents session coda env", () => {
    const { exit, out } = captureDoctor(["--help"], {});
    expect(exit).toBe(0);
    expect(out).toContain("DEFT_SESSION_CODA");
    expect(out).toContain(SESSION_CODA_OFF_HINT);
  });
});

describe("copy not in AGENTS templates or skill bodies", () => {
  it("seed lines are not embedded in agents-entry or build skill", () => {
    const root = join(process.cwd());
    const agentsEntry = readFileSync(join(root, "content/templates/agents-entry.md"), "utf8");
    const buildSkill = readFileSync(
      join(root, "content/skills/deft-directive-build/SKILL.md"),
      "utf8",
    );
    for (const line of [
      "A one-shot plan beats a ten-shot apology.",
      "Leave the repo easier to doctor than you found it.",
    ]) {
      expect(agentsEntry).not.toContain(line);
      expect(buildSkill).not.toContain(line);
    }
  });

  it("shipped pack has >= 20 lines each <= 100 chars", () => {
    const packPath = join(process.cwd(), "content/doctor/session-coda.json");
    const raw = JSON.parse(readFileSync(packPath, "utf8")) as unknown;
    const lines = filterCodaEntries(raw);
    expect(lines.length).toBeGreaterThanOrEqual(20);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});
