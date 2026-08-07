/**
 * SHA-bound release Step 5 suite stamp (#3187 / #3188 coordination).
 *
 * Local-only artifact under `.deft/` (gitignored). After suite green or
 * PASS_WITH_DEBT at HEAD S, re-entry at the same *clean* HEAD may skip the
 * suite. Dirty tree, different HEAD, corrupt stamp → fail closed (run suite).
 * CI never trusts this stamp (it is not committed and not read by GHA paths).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SUITE_STAMP_SCHEMA_VERSION = 1 as const;
export const SUITE_STAMP_RELPATH = join(".deft", "release-suite-stamp.json");

export type SuiteStampStatus = "pass" | "pass_with_debt";

export interface SuiteStamp {
  readonly schemaVersion: typeof SUITE_STAMP_SCHEMA_VERSION;
  readonly headSha: string;
  readonly suite: SuiteStampStatus;
  readonly debtIssue: number | null;
  readonly recordedAt: string;
}

export type SuiteStampValidity =
  | { readonly kind: "hit"; readonly stamp: SuiteStamp }
  | { readonly kind: "miss"; readonly reason: string };

export interface SuiteStampIo {
  readonly readFile?: (path: string) => string;
  readonly writeFile?: (path: string, content: string) => void;
  readonly fileExists?: (path: string) => boolean;
  readonly mkdirp?: (dir: string) => void;
}

function defaultIo(): Required<SuiteStampIo> {
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
    fileExists: (p) => existsSync(p),
    mkdirp: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
  };
}

export function suiteStampPath(projectRoot: string): string {
  return join(projectRoot, SUITE_STAMP_RELPATH);
}

export function isValidHeadSha(sha: string | null | undefined): sha is string {
  return typeof sha === "string" && /^[0-9a-f]{7,64}$/i.test(sha.trim());
}

/** Parse stamp JSON; returns null when missing/corrupt. */
export function parseSuiteStamp(raw: string): SuiteStamp | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SuiteStamp>;
    if (parsed.schemaVersion !== SUITE_STAMP_SCHEMA_VERSION) return null;
    if (!isValidHeadSha(parsed.headSha)) return null;
    if (parsed.suite !== "pass" && parsed.suite !== "pass_with_debt") return null;
    const debt =
      parsed.debtIssue === null || parsed.debtIssue === undefined ? null : Number(parsed.debtIssue);
    if (debt !== null && (!Number.isFinite(debt) || debt <= 0)) return null;
    if (typeof parsed.recordedAt !== "string" || !parsed.recordedAt) return null;
    return {
      schemaVersion: SUITE_STAMP_SCHEMA_VERSION,
      headSha: parsed.headSha.trim().toLowerCase(),
      suite: parsed.suite,
      debtIssue: debt,
      recordedAt: parsed.recordedAt,
    };
  } catch {
    return null;
  }
}

export function readSuiteStamp(projectRoot: string, io: SuiteStampIo = {}): SuiteStamp | null {
  const fs = { ...defaultIo(), ...io };
  const path = suiteStampPath(projectRoot);
  if (!fs.fileExists(path)) return null;
  try {
    return parseSuiteStamp(fs.readFile(path));
  } catch {
    return null;
  }
}

export function writeSuiteStamp(
  projectRoot: string,
  stamp: Omit<SuiteStamp, "schemaVersion"> & { schemaVersion?: number },
  io: SuiteStampIo = {},
): SuiteStamp {
  const fs = { ...defaultIo(), ...io };
  const full: SuiteStamp = {
    schemaVersion: SUITE_STAMP_SCHEMA_VERSION,
    headSha: stamp.headSha.trim().toLowerCase(),
    suite: stamp.suite,
    debtIssue: stamp.debtIssue,
    recordedAt: stamp.recordedAt,
  };
  if (!isValidHeadSha(full.headSha)) {
    throw new Error(`suite-stamp: invalid headSha ${JSON.stringify(stamp.headSha)}`);
  }
  if (full.suite === "pass_with_debt" && (full.debtIssue === null || full.debtIssue <= 0)) {
    throw new Error("suite-stamp: pass_with_debt requires debtIssue");
  }
  const path = suiteStampPath(projectRoot);
  fs.mkdirp(dirname(path));
  fs.writeFile(path, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

/**
 * Validate a stamp against current HEAD + tree cleanliness.
 * CI callers MUST NOT use a hit to skip suite (document-only; stamp is local).
 */
export function evaluateSuiteStamp(options: {
  readonly projectRoot: string;
  readonly headSha: string | null;
  readonly treeClean: boolean;
  /** When true (CI), always miss — never trust laptop stamps. */
  readonly isCi?: boolean;
  readonly io?: SuiteStampIo;
}): SuiteStampValidity {
  if (options.isCi === true) {
    return { kind: "miss", reason: "CI never trusts release suite stamp (#3187)" };
  }
  if (!options.treeClean) {
    return { kind: "miss", reason: "working tree dirty — suite stamp invalidated" };
  }
  if (!isValidHeadSha(options.headSha)) {
    return { kind: "miss", reason: "HEAD sha unavailable" };
  }
  const stamp = readSuiteStamp(options.projectRoot, options.io);
  if (!stamp) {
    return { kind: "miss", reason: "suite stamp missing or corrupt" };
  }
  if (stamp.headSha.toLowerCase() !== options.headSha.trim().toLowerCase()) {
    return {
      kind: "miss",
      reason: `suite stamp HEAD ${stamp.headSha.slice(0, 12)} ≠ current ${options.headSha.trim().slice(0, 12)}`,
    };
  }
  return { kind: "hit", stamp };
}
