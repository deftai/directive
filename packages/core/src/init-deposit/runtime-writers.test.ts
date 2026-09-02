import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_COMPLETED_MARKER_REL,
  writeSessionCompletedMarker,
} from "../check/session-completed-ac.js";
import { APPROVED_SCOPE_DIR } from "../scope-provenance/digest.js";
import { AC_PASS_BANK_DIR } from "../session/ac-pass-banking.js";
import { VERIFY_AC_SESSION_CACHE_DIR } from "../session/verify-ac-session-cache.js";
import {
  APPROVED_SCOPE_SIDECAR_GITIGNORE_LINES,
  CANONICAL_GITIGNORE_BASELINE,
  gitignoreRuleCoversPath,
  ignoreSetCoversPath,
  isGlobGitignoreRule,
} from "./gitignore.js";
import {
  RUNTIME_WRITER_PATHS,
  RUNTIME_WRITER_PATHS_LOCAL_CACHE,
  RUNTIME_WRITER_PATHS_TRACKED_PROVENANCE,
} from "./runtime-writers.js";

const here = dirname(fileURLToPath(import.meta.url));

const repoRoot = join(here, "..", "..", "..", "..");

type WriterManifest = {
  localCache: string[];
  trackedProvenance: string[];
  uncoveredProbe: string;
};

function loadWriterManifest(): WriterManifest {
  return JSON.parse(
    readFileSync(join(here, "runtime-writer-paths.json"), "utf8"),
  ) as WriterManifest;
}

function parseGoCanonicalGitignoreLines(): string[] {
  const src = readFileSync(
    join(here, "..", "..", "..", "..", "cmd", "deft-install", "setup.go"),
    "utf8",
  );
  const start = src.indexOf("var canonicalGitignoreLines = []string{");
  if (start < 0) throw new Error("canonicalGitignoreLines not found in setup.go");
  const open = src.indexOf("[", start);
  const close = src.indexOf("}", open);
  const block = src.slice(open, close);
  const lines: string[] = [];
  for (const raw of block.split("\n")) {
    const i = raw.indexOf('"');
    if (i < 0) continue;
    const j = raw.indexOf('"', i + 1);
    if (j < 0) continue;
    lines.push(raw.slice(i + 1, j));
  }
  return lines;
}

describe("runtime writer ignore containment (#3612 / #4116)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("locksteps imported writer constants to the Go-readable JSON manifest", () => {
    const manifest = loadWriterManifest();
    expect([...RUNTIME_WRITER_PATHS_LOCAL_CACHE]).toEqual(manifest.localCache);
    expect([...RUNTIME_WRITER_PATHS_TRACKED_PROVENANCE]).toEqual(manifest.trackedProvenance);
    expect([...RUNTIME_WRITER_PATHS]).toEqual([
      ...manifest.localCache,
      ...manifest.trackedProvenance,
    ]);
    expect(manifest.uncoveredProbe).toBe(".deft/uncovered-writer-probe");
  });

  it("covers every local-cache writer path with the TypeScript baseline", () => {
    const missing = RUNTIME_WRITER_PATHS_LOCAL_CACHE.filter(
      (path) => !ignoreSetCoversPath(CANONICAL_GITIGNORE_BASELINE, path),
    );
    expect(missing).toEqual([]);
  });

  it("covers every local-cache writer path with the Go baseline", () => {
    const goLines = parseGoCanonicalGitignoreLines();
    const missing = RUNTIME_WRITER_PATHS_LOCAL_CACHE.filter(
      (path) => !ignoreSetCoversPath(goLines, path),
    );
    expect(missing).toEqual([]);
  });

  it("does not cover tracked-provenance writers on either baseline", () => {
    const goLines = parseGoCanonicalGitignoreLines();
    for (const path of RUNTIME_WRITER_PATHS_TRACKED_PROVENANCE) {
      expect(ignoreSetCoversPath(CANONICAL_GITIGNORE_BASELINE, path)).toBe(false);
      expect(ignoreSetCoversPath(goLines, path)).toBe(false);
    }
    expect(CANONICAL_GITIGNORE_BASELINE).not.toContain(".deft/approved-scope/");
    expect(CANONICAL_GITIGNORE_BASELINE).not.toContain(".deft/approved-scope");
    expect(goLines).not.toContain(".deft/approved-scope/");
    expect(goLines).not.toContain(".deft/approved-scope");
  });

  it("keeps neighbor local-only paths ignored", () => {
    for (const line of [
      ".deft/authz/",
      ".deft/metrics/",
      ".deft/delivery-attempts/",
      ".deft/escalations/",
    ]) {
      expect(CANONICAL_GITIGNORE_BASELINE).toContain(line);
      expect(parseGoCanonicalGitignoreLines()).toContain(line);
    }
  });

  it("lists approved-scope sidecar globs on both baselines", () => {
    expect(APPROVED_SCOPE_SIDECAR_GITIGNORE_LINES.length).toBeGreaterThan(0);
    const goLines = parseGoCanonicalGitignoreLines();
    for (const line of APPROVED_SCOPE_SIDECAR_GITIGNORE_LINES) {
      expect(isGlobGitignoreRule(line)).toBe(true);
      expect(CANONICAL_GITIGNORE_BASELINE).toContain(line);
      expect(goLines).toContain(line);
    }
  });

  it("fails closed on a deliberately uncovered writer path", () => {
    expect(
      ignoreSetCoversPath(CANONICAL_GITIGNORE_BASELINE, loadWriterManifest().uncoveredProbe),
    ).toBe(false);
    expect(
      ignoreSetCoversPath(parseGoCanonicalGitignoreLines(), loadWriterManifest().uncoveredProbe),
    ).toBe(false);
  });

  it("does not cover .deft/core managed deposit via writer rules", () => {
    expect(ignoreSetCoversPath(CANONICAL_GITIGNORE_BASELINE, ".deft/core/main.md")).toBe(false);
  });

  it("does not treat a sibling prefix as coverage", () => {
    expect(ignoreSetCoversPath([".deft/cache/"], ".deft/cache-poison/x.json")).toBe(false);
    expect(ignoreSetCoversPath([".deft/cache/"], ".deft/cache/ac-pass-banks/x.json")).toBe(true);
  });

  it("does not dirty a throwaway consumer seeded with the TS baseline", () => {
    const root = mkdtempSync(join(tmpdir(), "gitignore-3612-consumer-"));
    created.push(root);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.dev"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, ".gitignore"), `${CANONICAL_GITIGNORE_BASELINE.join("\n")}\n`, "utf8");
    execFileSync("git", ["add", ".gitignore"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init"], {
      cwd: root,
      stdio: "ignore",
    });

    mkdirSync(join(root, AC_PASS_BANK_DIR), { recursive: true });
    writeFileSync(join(root, AC_PASS_BANK_DIR, "x.json"), "{}\n", "utf8");
    mkdirSync(join(root, VERIFY_AC_SESSION_CACHE_DIR), { recursive: true });
    writeFileSync(join(root, VERIFY_AC_SESSION_CACHE_DIR, "s-scope.json"), "{}\n", "utf8");
    writeSessionCompletedMarker(root, {
      path: "xbrief/completed/foo.xbrief.json",
      sessionId: "s",
      completedAt: "2026-08-30T00:00:00Z",
    });

    const status = execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" });
    expect(status.trim()).toBe("");

    for (const rel of [
      `${AC_PASS_BANK_DIR}/x.json`,
      `${VERIFY_AC_SESSION_CACHE_DIR}/s-scope.json`,
      SESSION_COMPLETED_MARKER_REL.join("/"),
    ]) {
      const ignored = execFileSync("git", ["check-ignore", "-v", "--", rel], {
        cwd: root,
        encoding: "utf8",
      });
      expect(ignored).toMatch(/\.deft\/cache\//);
    }
  });

  it("stages approved-scope records with plain git add and ignores sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "gitignore-4116-records-"));
    created.push(root);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.dev"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "t"], {
      cwd: root,
      stdio: "ignore",
    });
    writeFileSync(join(root, ".gitignore"), `${CANONICAL_GITIGNORE_BASELINE.join("\n")}\n`, "utf8");
    execFileSync("git", ["add", ".gitignore"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init"], {
      cwd: root,
      stdio: "ignore",
    });

    const dir = join(root, APPROVED_SCOPE_DIR);
    mkdirSync(dir, { recursive: true });
    const recordRel = `${APPROVED_SCOPE_DIR}/plan-1.json`;
    const intentRel = `${APPROVED_SCOPE_DIR}/plan-1.intent.json`;
    writeFileSync(join(root, recordRel), "{}\n", "utf8");
    writeFileSync(join(root, intentRel), "{}\n", "utf8");
    const sidecars = [
      `${APPROVED_SCOPE_DIR}/plan-1.json.bak`,
      `${APPROVED_SCOPE_DIR}/plan-1.intent.json.bak`,
      `${APPROVED_SCOPE_DIR}/plan-1.json.next.tmp`,
      `${APPROVED_SCOPE_DIR}/plan-1.intent.json.next.tmp`,
      `${APPROVED_SCOPE_DIR}/.plan-1.pair.lock.tmp`,
      `${APPROVED_SCOPE_DIR}/.plan-1.pair.lock.tmp.stale`,
      `${APPROVED_SCOPE_DIR}/.plan-1.publishing.bak`,
    ];
    for (const rel of sidecars) {
      writeFileSync(join(root, rel), "residue\n", "utf8");
    }

    execFileSync("git", ["add", "--", recordRel, intentRel], {
      cwd: root,
      stdio: "ignore",
    });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(staged).toContain("plan-1.json");
    expect(staged).toContain("plan-1.intent.json");
    expect(staged).not.toContain(".bak");
    expect(staged).not.toContain(".next.tmp");

    for (const rel of [recordRel, intentRel]) {
      expect(() =>
        execFileSync("git", ["check-ignore", "-q", "--", rel], {
          cwd: root,
          stdio: "ignore",
        }),
      ).toThrow();
    }
    for (const rel of sidecars) {
      const ignored = execFileSync("git", ["check-ignore", "-v", "--", rel], {
        cwd: root,
        encoding: "utf8",
      });
      expect(ignored.length).toBeGreaterThan(0);
    }
  });

  it("does not let a non-glob baseline rule cover tracked approved-scope records", () => {
    const tracked = execFileSync("git", ["ls-files", "--", APPROVED_SCOPE_DIR], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(tracked.length).toBeGreaterThan(0);
    for (const rel of tracked) {
      const covering = CANONICAL_GITIGNORE_BASELINE.filter(
        (rule) => !isGlobGitignoreRule(rule) && gitignoreRuleCoversPath(rule, rel),
      );
      expect(covering).toEqual([]);
    }
  });
});
