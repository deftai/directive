/**
 * Trust-file history walk and the signed level (#6945).
 *
 * At the merge base, verify walks every first-parent version of
 * `.deft/approvers.json` from its first appearance and checks each step with
 * `applyTrustVersion`. Once the file has appeared the repository stays at the
 * signed level: a later deletion or a malformed version refuses, as does a
 * rollback or a second transition from one predecessor (its predecessor
 * digest no longer names the version before it). A shallow clone refuses with
 * a full-history remediation. There is no level off in this story.
 * Residual: in a shallow clone whose visible history never holds the file
 * (a deletion past the shallow boundary), the walk cannot see the opt-in and
 * reads the repository as not opted in; CI that fetches full history closes it.
 *
 * The walk reads git only: no forge read and no network read.
 */
import { execFileSync } from "node:child_process";
import type { RegistrationVerifier } from "./attestation.js";
import { normalizeRepoSlug } from "./canonical.js";
import {
  applyTrustVersion,
  computeVersionDigest,
  parseApproversFile,
  type TrustChainState,
} from "./trust-file.js";
import { APPROVERS_FILE_REL, type ApproversBody } from "./types.js";

/** Output cap for git reads in the walk. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** One first-parent version: the commit that introduced it and its text (null: deleted). */
export interface TrustVersion {
  readonly commit: string;
  readonly text: string | null;
}

export type TrustHistoryLoad =
  | { readonly kind: "absent" }
  | { readonly kind: "shallow" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "versions"; readonly versions: readonly TrustVersion[] };

/** A verified chain: the current body and how its epoch was rooted. */
export interface VerifiedTrust {
  readonly body: ApproversBody;
  readonly rootKind: string;
  readonly epochStart: string;
  readonly attested: readonly string[];
}

export type TrustChainResult =
  | ({ readonly ok: true } & VerifiedTrust)
  | { readonly ok: false; readonly reason: string };

/** Remediation printed when the clone is shallow at the signed level. */
export const SHALLOW_REMEDIATION =
  "fetch full history (`git fetch --unshallow`, or `fetch-depth: 0` on actions/checkout) so verify can walk every version of .deft/approvers.json";

function git(projectRoot: string, args: readonly string[], input?: string): string | null {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      input,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Load every first-parent version of the trust file reachable from
 * `mergeBase`. `absent` when the merge base is not a commit in this
 * repository or the path never appears on its history.
 */
export function loadTrustHistory(projectRoot: string, mergeBase: string): TrustHistoryLoad {
  // One spawn: "true|false" then the commit; fails when the merge base is not a commit.
  const resolved = git(projectRoot, [
    "rev-parse",
    "--is-shallow-repository",
    `${mergeBase}^{commit}`,
  ]);
  const [shallowFlag, base] = (resolved ?? "").split("\n").map((l) => l.trim());
  if (base === undefined || base.length === 0) return { kind: "absent" };
  const touched = git(projectRoot, ["log", "-1", "--format=%H", base, "--", APPROVERS_FILE_REL]);
  if (touched === null) return { kind: "error", reason: "git log of .deft/approvers.json failed" };
  if (touched.trim().length === 0) return { kind: "absent" };
  if (shallowFlag === "true") return { kind: "shallow" };
  if (shallowFlag !== "false")
    return { kind: "error", reason: "could not tell whether the clone is shallow" };
  const listed = git(projectRoot, ["rev-list", "--first-parent", "--reverse", base]);
  if (listed === null) return { kind: "error", reason: "git rev-list of the merge base failed" };
  const commits = listed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const query = commits.map((c) => `${c}:${APPROVERS_FILE_REL}`).join("\n");
  const checked = git(
    projectRoot,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    `${query}\n`,
  );
  if (checked === null)
    return { kind: "error", reason: "git cat-file over the first-parent history failed" };
  const lines = checked.split("\n").filter((l) => l.length > 0);
  if (lines.length !== commits.length) {
    return { kind: "error", reason: "git cat-file returned an unexpected line count" };
  }
  const steps: { commit: string; oid: string | null }[] = [];
  let previous: string | undefined;
  for (let i = 0; i < commits.length; i += 1) {
    const line = lines[i]!;
    const missing = line.endsWith(" missing");
    const [oid, type] = line.split(" ");
    const key = missing ? "missing" : `${oid}`;
    if (key === previous) continue;
    previous = key;
    if (missing) {
      if (steps.length > 0) steps.push({ commit: commits[i]!, oid: null });
      continue;
    }
    // A non-blob at the path (a tree, a submodule) reads as malformed text.
    steps.push({ commit: commits[i]!, oid: type === "blob" ? key : "" });
  }
  if (steps.length === 0) return { kind: "absent" };
  const blobs = readBlobs(projectRoot, [
    ...new Set(steps.map((s) => s.oid).filter((o): o is string => o !== null && o.length > 0)),
  ]);
  if (blobs === null)
    return { kind: "error", reason: "git cat-file could not read trust-file versions" };
  return {
    kind: "versions",
    versions: steps.map((s) => ({
      commit: s.commit,
      text: s.oid === null ? null : (blobs.get(s.oid) ?? ""),
    })),
  };
}

/** Read blobs in one `git cat-file --batch` spawn. Null on failure. */
function readBlobs(projectRoot: string, oids: readonly string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  if (oids.length === 0) return out;
  let raw: Buffer;
  try {
    raw = execFileSync("git", ["-C", projectRoot, "cat-file", "--batch"], {
      input: `${oids.join("\n")}\n`,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  let pos = 0;
  for (const oid of oids) {
    const eol = raw.indexOf(0x0a, pos);
    if (eol < 0) return null;
    const header = raw.subarray(pos, eol).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (header[0] !== oid || header[1] !== "blob" || !Number.isSafeInteger(size)) return null;
    out.set(oid, raw.subarray(eol + 1, eol + 1 + size).toString("utf8"));
    pos = eol + 1 + size + 1;
  }
  return out;
}

/** Check every version in order; the last verified state is the current trust. */
export function verifyTrustHistory(
  versions: readonly TrustVersion[],
  options: { readonly verifyRegistration?: RegistrationVerifier } = {},
): TrustChainResult {
  let state: TrustChainState | null = null;
  let firstSeen: string | null = null;
  let lastDigest: string | null = null;
  for (const version of versions) {
    if (version.text === null) {
      return {
        ok: false,
        reason:
          `.deft/approvers.json was deleted at ${version.commit} after it first appeared at ${firstSeen ?? "?"}; ` +
          "once a repository opts in it stays at the signed level",
      };
    }
    const parsed = parseApproversFile(version.text);
    if ("error" in parsed) {
      return {
        ok: false,
        reason: `.deft/approvers.json at ${version.commit} is malformed: ${parsed.error}`,
      };
    }
    firstSeen ??= version.commit;
    const digest = computeVersionDigest(parsed);
    if (digest === lastDigest) continue;
    const next = applyTrustVersion(state, parsed, {
      at: version.commit,
      verifyRegistration: options.verifyRegistration,
      // Accepted history must keep verifying after a root certificate expires.
      checkCertificateValidity: false,
    });
    if (!next.ok) return { ok: false, reason: next.reason };
    state = next.state;
    lastDigest = digest;
  }
  if (state === null) return { ok: false, reason: ".deft/approvers.json has no versions" };
  return {
    ok: true,
    body: state.file.body,
    rootKind: state.rootKind,
    epochStart: state.epochStart,
    attested: [...state.attested],
  };
}

const GITHUB_REMOTE =
  /^(?:https?:\/\/|ssh:\/\/|git:\/\/)?(?:[^@/]+@)?[^/:]+[:/](.+?)(?:\.git)?\/?$/;

/**
 * The repository the payload names: `GITHUB_REPOSITORY`, else the origin
 * remote. Null when neither resolves.
 */
export function resolveApprovalRepo(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const fromEnv = env.GITHUB_REPOSITORY?.trim();
  if (fromEnv !== undefined && /^[^/\s]+\/[^/\s]+$/.test(fromEnv))
    return normalizeRepoSlug(fromEnv);
  const url = git(projectRoot, ["remote", "get-url", "origin"])?.trim();
  return url === undefined ? null : parseRemoteRepo(url);
}

/** `owner/repo` (lowercase) from a remote URL; null when it has no two-part path. */
export function parseRemoteRepo(url: string): string | null {
  const match = GITHUB_REMOTE.exec(url.trim());
  const path = match?.[1];
  if (path === undefined) return null;
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  return normalizeRepoSlug(`${parts[parts.length - 2]}/${parts[parts.length - 1]}`);
}

/** The approval level a merge base puts a repository at. */
export type SignedLevel =
  | { readonly level: "none" }
  | {
      readonly level: "signed";
      readonly ok: true;
      readonly repo: string;
      readonly trust: VerifiedTrust;
    }
  | { readonly level: "signed"; readonly ok: false; readonly code: 1 | 2; readonly reason: string };

/**
 * Resolve the signed level at `mergeBase`: `none` when the trust file never
 * appeared on its first-parent history, else the verified trust or the
 * reason verify refuses.
 */
export function resolveSignedLevel(
  projectRoot: string,
  mergeBase: string,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly verifyRegistration?: RegistrationVerifier;
  } = {},
): SignedLevel {
  const load = loadTrustHistory(projectRoot, mergeBase);
  if (load.kind === "absent") return { level: "none" };
  return signedLevelFromLoad(load, () => resolveApprovalRepo(projectRoot, options.env), options);
}

/** The signed level for a loaded history; `repo` is read only when the chain verifies. */
export function signedLevelFromLoad(
  load: TrustHistoryLoad,
  repoOf: () => string | null,
  options: { readonly verifyRegistration?: RegistrationVerifier } = {},
): SignedLevel {
  if (load.kind === "absent") return { level: "none" };
  if (load.kind === "shallow") {
    return {
      level: "signed",
      ok: false,
      code: 2,
      reason: `shallow clone at the signed level: ${SHALLOW_REMEDIATION}`,
    };
  }
  if (load.kind === "error") return { level: "signed", ok: false, code: 2, reason: load.reason };
  const chain = verifyTrustHistory(load.versions, {
    verifyRegistration: options.verifyRegistration,
  });
  if (!chain.ok) return { level: "signed", ok: false, code: 1, reason: chain.reason };
  const repo = repoOf();
  if (repo === null) {
    return {
      level: "signed",
      ok: false,
      code: 2,
      reason: "cannot resolve this repository: set GITHUB_REPOSITORY or an origin remote",
    };
  }
  if (chain.body.repo !== repo) {
    return {
      level: "signed",
      ok: false,
      code: 1,
      reason: `.deft/approvers.json names repository ${chain.body.repo}, this repository is ${repo}`,
    };
  }
  const { ok: _ok, ...trust } = chain;
  return { level: "signed", ok: true, repo, trust };
}
