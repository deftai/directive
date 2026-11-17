/**
 * Pin-mismatch-only refusal text (#6375): checked root on a labelled line,
 * outside-terminal instruction, plain install by root lockfile kind, retry note.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  escapeControlCharacters,
  PIN_MISMATCH_NO_LOCKFILE_LINE,
  PIN_MISMATCH_RETRY_LINE,
  PIN_MISMATCH_ROOT_LABEL,
  PIN_MISMATCH_TERMINAL_LINE,
  renderPinMismatchRecoveryGuidance,
} from "./pin-mismatch-guidance.js";
import type { FsSeams } from "./readers.js";

const ROOT = join("/work", "proj");

/** In-memory filesystem: path -> text. */
function fsWith(files: Record<string, string>): FsSeams {
  return {
    isFile: (p) => Object.hasOwn(files, p),
    readText: (p) => (Object.hasOwn(files, p) ? (files[p] as string) : null),
  };
}

const PNPM_LOCK = (version: string) =>
  `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      '@deftai/directive-runtime':\n        specifier: ${version}\n        version: ${version}\n`;
const NPM_LOCK = (version: string) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "node_modules/@deftai/directive-runtime": { version } },
  });

function render(files: Record<string, string>, root = ROOT): string {
  const rooted = Object.fromEntries(Object.entries(files).map(([k, v]) => [join(root, k), v]));
  return renderPinMismatchRecoveryGuidance(root, fsWith(rooted));
}

/** An npm command (not the `npm` inside `pnpm`). */
function namesNpmCommand(text: string): boolean {
  return /(^|[^\w-])npm\s+(install|ci|i)\b/.test(text);
}

function namesPnpmCommand(text: string): boolean {
  return /\bpnpm\s+(install|i|add)\b/.test(text);
}

function rootLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.startsWith(PIN_MISMATCH_ROOT_LABEL));
}

describe("renderPinMismatchRecoveryGuidance (#6375)", () => {
  it("has a labelled line that holds the resolved project root and nothing else", () => {
    const text = render({ "pnpm-lock.yaml": PNPM_LOCK("1.2.3") });
    expect(rootLine(text)).toBe(`${PIN_MISMATCH_ROOT_LABEL} ${ROOT}`);
    expect(text.split("\n")[0]).toBe(`${PIN_MISMATCH_ROOT_LABEL} ${ROOT}`);
  });

  it("says to use a terminal outside the blocked agent session at that directory", () => {
    const text = render({});
    expect(text.split("\n")).toContain(PIN_MISMATCH_TERMINAL_LINE);
    expect(PIN_MISMATCH_TERMINAL_LINE).toMatch(/terminal outside this blocked agent session/);
    expect(PIN_MISMATCH_TERMINAL_LINE).toMatch(/at that directory/);
  });

  it("names `pnpm install` as the command to run with a pnpm lockfile, and no npm command", () => {
    const text = render({ "pnpm-lock.yaml": PNPM_LOCK("1.2.3") });
    expect(text.split("\n")).toContain("Run: `pnpm install`");
    expect(namesNpmCommand(text)).toBe(false);
  });

  it("names `npm install` as the command to run with only an npm lockfile, and no pnpm command", () => {
    const text = render({ "package-lock.json": NPM_LOCK("1.2.3") });
    expect(text.split("\n")).toContain("Run: `npm install`");
    expect(namesPnpmCommand(text)).toBe(false);
    expect(text).not.toContain("pnpm");
  });

  it("names `pnpm install` when both lockfiles are at the root", () => {
    const text = render({
      "pnpm-lock.yaml": PNPM_LOCK("1.2.3"),
      "package-lock.json": NPM_LOCK("1.2.3"),
    });
    expect(text.split("\n")).toContain("Run: `pnpm install`");
    expect(namesNpmCommand(text)).toBe(false);
  });

  it.each([
    ["pnpm-lock.yaml", PNPM_LOCK("1.2.3"), "`pnpm install --frozen-lockfile`"],
    ["package-lock.json", NPM_LOCK("1.2.3"), "`npm ci`"],
  ])("with %s, says the frozen form can be tried when the lockfile already records the pin", (file, body, frozen) => {
    const text = render({ [file]: body });
    const line = text.split("\n").find((l) => l.includes(frozen));
    expect(line).toBeDefined();
    expect(line).toMatch(/^You can try /);
    expect(line).toMatch(/when the lockfile already records the pin\.$/);
  });

  it("says that no lockfile was found and names no exact install command when none is at the root", () => {
    const text = render({});
    expect(text.split("\n")).toContain(PIN_MISMATCH_NO_LOCKFILE_LINE);
    expect(PIN_MISMATCH_NO_LOCKFILE_LINE).toMatch(/No lockfile .* was found at that directory/);
    expect(namesNpmCommand(text)).toBe(false);
    expect(namesPnpmCommand(text)).toBe(false);
    expect(text).not.toContain("Run: ");
  });

  it("does not look for a lockfile above the project root", () => {
    const parentLock = { [join("/work", "pnpm-lock.yaml")]: PNPM_LOCK("1.2.3") };
    const text = renderPinMismatchRecoveryGuidance(ROOT, fsWith(parentLock));
    expect(text.split("\n")).toContain(PIN_MISMATCH_NO_LOCKFILE_LINE);
  });

  it.each([
    ["pnpm-lock.yaml", PNPM_LOCK],
    ["package-lock.json", NPM_LOCK],
  ])("gives the same text for two %s files that differ only in the recorded runtime version", (file, lock) => {
    const a = render({ [file]: lock("1.2.3") });
    const b = render({ [file]: lock("9.9.9") });
    expect(a).toBe(b);
  });

  it("says to retry after the install, that this check needs no restart, and that normal checks still apply", () => {
    const text = render({ "pnpm-lock.yaml": PNPM_LOCK("1.2.3") });
    const lines = text.split("\n");
    expect(lines[lines.length - 1]).toBe(PIN_MISMATCH_RETRY_LINE);
    expect(PIN_MISMATCH_RETRY_LINE).toMatch(
      /retry the command once the installed runtime matches the pin/,
    );
    expect(PIN_MISMATCH_RETRY_LINE).toMatch(/needs no session restart/);
    expect(PIN_MISMATCH_RETRY_LINE).toMatch(/normal checks still apply/);
  });

  it("keeps the whole path on the root line when the root contains a space", () => {
    const root = join("/work", "my project", "app");
    const text = render({}, root);
    expect(rootLine(text)).toBe(`${PIN_MISMATCH_ROOT_LABEL} ${root}`);
  });

  it("shows a control character in the root escaped, on one line", () => {
    const root = join("/work", "a\nb\tc\u007fd\u0085e");
    const text = render({}, root);
    const line = rootLine(text);
    expect(line).toBe(
      `${PIN_MISMATCH_ROOT_LABEL} ${join("/work", "a\\u000ab\\u0009c\\u007fd\\u0085e")}`,
    );
    expect(text.split("\n")).toHaveLength(4);
  });
});

describe("escapeControlCharacters (#6375)", () => {
  it("escapes C0, DEL and C1 characters and keeps everything else", () => {
    expect(escapeControlCharacters("\u0000\u001f \u007e\u007f\u009f\u00a0é")).toBe(
      "\\u0000\\u001f ~\\u007f\\u009f\u00a0é",
    );
    expect(escapeControlCharacters("C:\\Repos\\x y")).toBe("C:\\Repos\\x y");
  });
});
