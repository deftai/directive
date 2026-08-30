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
import { AC_PASS_BANK_DIR } from "../session/ac-pass-banking.js";
import { VERIFY_AC_SESSION_CACHE_DIR } from "../session/verify-ac-session-cache.js";
import { CANONICAL_GITIGNORE_BASELINE, ignoreSetCoversPath } from "./gitignore.js";
import { RUNTIME_WRITER_PATHS } from "./runtime-writers.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadWriterManifest(): { writerPaths: string[]; uncoveredProbe: string } {
  return JSON.parse(readFileSync(join(here, "runtime-writer-paths.json"), "utf8")) as {
    writerPaths: string[];
    uncoveredProbe: string;
  };
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

describe("runtime writer ignore containment (#3612)", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("locksteps imported writer constants to the Go-readable JSON manifest", () => {
    const manifest = loadWriterManifest();
    expect([...RUNTIME_WRITER_PATHS]).toEqual(manifest.writerPaths);
    expect(manifest.uncoveredProbe).toBe(".deft/uncovered-writer-probe");
  });

  it("covers every runtime writer path with the TypeScript baseline", () => {
    const missing = RUNTIME_WRITER_PATHS.filter(
      (path) => !ignoreSetCoversPath(CANONICAL_GITIGNORE_BASELINE, path),
    );
    expect(missing).toEqual([]);
  });

  it("covers every runtime writer path with the Go baseline", () => {
    const goLines = parseGoCanonicalGitignoreLines();
    const missing = RUNTIME_WRITER_PATHS.filter((path) => !ignoreSetCoversPath(goLines, path));
    expect(missing).toEqual([]);
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
});
