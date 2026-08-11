/**
 * Human-origin structural apply gate for scope:decompose (#3239 / epic #3237 Q2).
 *
 * Apply requires a human-origin grant bound to:
 *   project root identity (worktree and/or repo), parent path, draft/target path,
 *   SHA-256 of exact draft bytes, and op scope.decompose.apply.structural.
 *
 * --check stays ungated (caller responsibility). Missing / expired / mismatched /
 * agent-origin grants fail closed before any child story writes.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type MintGrantInput, mintHumanOriginGrant } from "./actions.js";
import {
  evidenceSatisfiesImplementationApproval,
  isHumanOriginGrant,
  isRejectedOriginKind,
} from "./origin.js";
import { listGrants } from "./store.js";
import {
  type AuthzDecisionCode,
  type HumanOriginGrant,
  SCOPE_DECOMPOSE_APPLY_STRUCTURAL,
} from "./types.js";

export type DecomposeApplyDecisionCode =
  | AuthzDecisionCode
  | "authz-grant-digest-mismatch"
  | "authz-grant-parent-mismatch"
  | "authz-grant-target-mismatch"
  | "authz-grant-project-mismatch"
  | "authz-grant-binding-incomplete";

export interface DecomposeApplyDecision {
  readonly allowed: boolean;
  readonly code: DecomposeApplyDecisionCode;
  readonly reason: string;
  readonly humanApprovalRef: string | null;
  readonly draftDigest: string;
}

export interface EvaluateDecomposeStructuralApplyInput {
  readonly projectRoot: string;
  /** Absolute or project-relative parent artifact path. */
  readonly parentPath: string;
  /** Absolute or project-relative draft path whose bytes were digested. */
  readonly draftPath: string;
  /** SHA-256 hex of the exact draft file bytes about to be applied. */
  readonly draftDigest: string;
  readonly grants?: readonly HumanOriginGrant[];
  /** Optional GitHub-style repo identity (owner/name); compared when grant pins repo. */
  readonly repo?: string | null;
  readonly now?: Date;
}

/** SHA-256 hex of a buffer or utf8 string. */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 hex of file bytes at path (exact on-disk digest). */
export function sha256FileHex(path: string): string {
  return sha256Hex(readFileSync(path));
}

/** Flatten CR/LF so deny-reason markdown cannot break out of a line. */
function flattenCliArgNewlines(value: string): string {
  return value.replace(/\r\n/g, " ").replace(/[\r\n]/g, " ");
}

/**
 * Quote a CLI token for operator copy-paste when it has whitespace or shell
 * metacharacters (Greptile #3291 / PR #3300). Safe bare tokens stay unquoted
 * so deny-reason mint hints match the common path shape.
 *
 * Single quotes keep `$()`, backticks, and `!` inert. Apostrophe escape differs
 * by shell: POSIX uses `'\''`; PowerShell uses `''`. Callers that need both
 * pass dialect `"posix"` or `"pwsh"`.
 */
function shellQuoteCliArg(value: string, dialect: "posix" | "pwsh"): string {
  const flat = flattenCliArgNewlines(value);
  // Allowlist: alnum + common path/repo chars without whitespace or shell meta.
  if (flat.length > 0 && /^[A-Za-z0-9_./:@+=,-]+$/.test(flat)) {
    return flat;
  }
  if (dialect === "pwsh") {
    // PowerShell single-quoted string: only ' is special, doubled as ''.
    return `'${flat.replace(/'/g, "''")}'`;
  }
  // POSIX single-quote; only ' needs escaping as '\''
  return `'${flat.replace(/'/g, `'\\''`)}'`;
}

function mintCommandWithDialect(
  parent: string,
  draft: string,
  repo: string,
  dialect: "posix" | "pwsh",
): string {
  return (
    `deft authz:grant -- --parent ${shellQuoteCliArg(parent, dialect)} --draft ${shellQuoteCliArg(draft, dialect)}` +
    (repo ? ` --repo ${shellQuoteCliArg(repo, dialect)}` : "") +
    " --confirm"
  );
}

/**
 * Exact operator CLI mint command for a structural decompose apply grant (#3291).
 * Paths are project-relative POSIX when inside projectRoot; otherwise as provided.
 * Parent / draft / repo tokens are shell-quoted when they contain whitespace or
 * shell metacharacters. When POSIX and PowerShell apostrophe escapes differ,
 * both forms are emitted so either shell can copy-paste correctly. Does not
 * include agent/CI/TTY gates — those remain on the CLI multi-factor path.
 */
export function formatDecomposeStructuralMintCommand(
  parentPath: string,
  draftPath: string,
  options?: { readonly projectRoot?: string; readonly repo?: string | null },
): string {
  let parent = parentPath.replace(/\\/g, "/");
  let draft = draftPath.replace(/\\/g, "/");
  const root = options?.projectRoot;
  if (root) {
    parent = toProjectRelativePosix(root, parentPath) ?? parent;
    draft = toProjectRelativePosix(root, draftPath) ?? draft;
  }
  const repo = (options?.repo ?? "").trim();
  const posix = mintCommandWithDialect(parent, draft, repo, "posix");
  const pwsh = mintCommandWithDialect(parent, draft, repo, "pwsh");
  if (posix === pwsh) return posix;
  return `${posix}  (pwsh: ${pwsh})`;
}

/**
 * Normalize a path to project-relative POSIX form for grant binding compare.
 * Returns null when the path escapes the project root.
 */
export function toProjectRelativePosix(projectRoot: string, path: string): string | null {
  const root = resolve(projectRoot);
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel === "..") return null;
  // Windows absolute on different drive yields absolute rel — treat as escape.
  if (isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function normalizeDigest(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim().toLowerCase();
  if (t.length === 0) return null;
  // Accept optional sha256: prefix.
  return t.startsWith("sha256:") ? t.slice("sha256:".length) : t;
}

/**
 * Exact path equality for grant binding (POSIX separators only).
 * Case-sensitive: case-variant paths are distinct on case-sensitive filesystems
 * (#3239 Greptile P1). Windows operators mint with the same relative form
 * produce via toProjectRelativePosix.
 */
function pathsEqual(a: string, b: string): boolean {
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

function grantValidity(
  grant: HumanOriginGrant,
  now: Date,
  mintHint: string,
): { ok: true } | { ok: false; code: DecomposeApplyDecisionCode; reason: string } {
  if (!isHumanOriginGrant(grant)) {
    const kind = grant.origin.kind;
    if (isRejectedOriginKind(kind)) {
      return {
        ok: false,
        code: "authz-grant-origin-reject",
        reason:
          `Directive denied scope:decompose apply: grant ${grant.id} origin.kind=${kind} is ` +
          "agent/self-authored and cannot approve a decomposition draft. " +
          `Human action required: \`${mintHint}\`.`,
      };
    }
    return {
      ok: false,
      code: "authz-grant-origin-reject",
      reason:
        `Directive denied scope:decompose apply: grant ${grant.id} lacks human-origin provenance. ` +
        `Human action required: \`${mintHint}\`.`,
    };
  }
  if (grant.semantics.revokedAt !== null) {
    return {
      ok: false,
      code: "authz-grant-revoked",
      reason: `Directive denied scope:decompose apply: grant ${grant.id} was revoked at ${grant.semantics.revokedAt}.`,
    };
  }
  if (grant.semantics.singleUse && grant.semantics.usedAt !== null) {
    return {
      ok: false,
      code: "authz-grant-single-use-spent",
      reason:
        `Directive denied scope:decompose apply: single-use grant ${grant.id} already spent at ${grant.semantics.usedAt}. ` +
        `Human action required: \`${mintHint}\`.`,
    };
  }
  if (grant.semantics.expiresAt !== null) {
    const exp = Date.parse(grant.semantics.expiresAt);
    if (!Number.isNaN(exp) && exp <= now.getTime()) {
      return {
        ok: false,
        code: "authz-grant-expired",
        reason:
          `Directive denied scope:decompose apply: grant ${grant.id} expired at ${grant.semantics.expiresAt}. ` +
          `Human action required: \`${mintHint}\`.`,
      };
    }
  }
  return { ok: true };
}

function grantHasStructuralOp(grant: HumanOriginGrant): boolean {
  return grant.scope.operations.includes(SCOPE_DECOMPOSE_APPLY_STRUCTURAL);
}

/**
 * Evaluate whether a human-origin grant covers structural decompose apply for
 * the exact draft digest + parent + target + project identity.
 */
export function evaluateDecomposeStructuralApply(
  input: EvaluateDecomposeStructuralApplyInput,
): DecomposeApplyDecision {
  const now = input.now ?? new Date();
  const digest = normalizeDigest(input.draftDigest) ?? "";
  const parentRel = toProjectRelativePosix(input.projectRoot, input.parentPath);
  const targetRel = toProjectRelativePosix(input.projectRoot, input.draftPath);
  const projectAbs = resolve(input.projectRoot);
  const grants = input.grants ?? listGrants(input.projectRoot);
  const mintHint = formatDecomposeStructuralMintCommand(input.parentPath, input.draftPath, {
    projectRoot: input.projectRoot,
    repo: input.repo,
  });

  if (parentRel === null || targetRel === null) {
    return {
      allowed: false,
      code: "authz-grant-scope-deny",
      reason:
        "Directive denied scope:decompose apply: parent or draft path is outside the project root. " +
        `Human action required: \`${mintHint}\` with paths inside the project root.`,
      humanApprovalRef: null,
      draftDigest: digest,
    };
  }

  let lastReject: {
    code: DecomposeApplyDecisionCode;
    reason: string;
    grantId: string | null;
  } | null = null;

  for (const grant of grants) {
    if (!evidenceSatisfiesImplementationApproval({ grant })) {
      const validity = grantValidity(grant, now, mintHint);
      if (!validity.ok) {
        lastReject = { code: validity.code, reason: validity.reason, grantId: grant.id };
        continue;
      }
      lastReject = {
        code: "authz-grant-origin-reject",
        reason:
          `Directive denied scope:decompose apply: grant ${grant.id} does not satisfy ` +
          `human-origin implementation approval. Human action required: \`${mintHint}\`.`,
        grantId: grant.id,
      };
      continue;
    }

    const validity = grantValidity(grant, now, mintHint);
    if (!validity.ok) {
      lastReject = { code: validity.code, reason: validity.reason, grantId: grant.id };
      continue;
    }

    if (!grantHasStructuralOp(grant)) {
      lastReject = {
        code: "authz-grant-scope-deny",
        reason:
          `Directive denied scope:decompose apply: grant ${grant.id} does not include operation ` +
          `'${SCOPE_DECOMPOSE_APPLY_STRUCTURAL}'. Human action required: \`${mintHint}\`.`,
        grantId: grant.id,
      };
      continue;
    }

    const boundDigest = normalizeDigest(grant.scope.contentDigest ?? null);
    const boundParent = grant.scope.parentPath?.trim() ?? "";
    const boundTarget = grant.scope.targetPath?.trim() ?? "";
    const boundRepo = grant.scope.repo?.trim() ?? "";
    const boundWorktree = grant.scope.worktree?.trim() ?? "";

    if (boundDigest === null || boundParent.length === 0 || boundTarget.length === 0) {
      lastReject = {
        code: "authz-grant-binding-incomplete",
        reason:
          `Directive denied scope:decompose apply: grant ${grant.id} is missing required ` +
          "structural bindings (contentDigest, parentPath, targetPath). " +
          `Human action required: \`${mintHint}\`.`,
        grantId: grant.id,
      };
      continue;
    }

    if (boundRepo.length === 0 && boundWorktree.length === 0) {
      lastReject = {
        code: "authz-grant-binding-incomplete",
        reason:
          `Directive denied scope:decompose apply: grant ${grant.id} does not bind project ` +
          "identity (repo and/or worktree). " +
          `Human action required: \`${mintHint}\`.`,
        grantId: grant.id,
      };
      continue;
    }

    if (boundDigest !== digest) {
      lastReject = {
        code: "authz-grant-digest-mismatch",
        reason:
          `Directive denied scope:decompose apply: grant ${grant.id} is bound to draft digest ` +
          `${boundDigest.slice(0, 12)}… but the draft bytes hash to ${digest.slice(0, 12)}…. ` +
          "Any content change after approval invalidates the grant. " +
          `Human action required: \`${mintHint}\`.`,
        grantId: grant.id,
      };
      continue;
    }

    if (!pathsEqual(boundParent, parentRel)) {
      lastReject = {
        code: "authz-grant-parent-mismatch",
        reason:
          `Directive denied scope:decompose apply: grant ${grant.id} is bound to parent ` +
          `'${boundParent}' but apply targets '${parentRel}'. ` +
          `Human action required: \`${mintHint}\`.`,
        grantId: grant.id,
      };
      continue;
    }

    if (!pathsEqual(boundTarget, targetRel)) {
      lastReject = {
        code: "authz-grant-target-mismatch",
        reason:
          `Directive denied scope:decompose apply: grant ${grant.id} is bound to draft path ` +
          `'${boundTarget}' but apply uses '${targetRel}'. ` +
          `Human action required: \`${mintHint}\`.`,
        grantId: grant.id,
      };
      continue;
    }

    // Project identity: when grant pins repo and/or worktree, attempt must match.
    if (boundRepo.length > 0) {
      const attemptRepo = (input.repo ?? "").trim();
      if (attemptRepo.length === 0 || attemptRepo.toLowerCase() !== boundRepo.toLowerCase()) {
        lastReject = {
          code: "authz-grant-project-mismatch",
          reason:
            `Directive denied scope:decompose apply: grant ${grant.id} is bound to repo ` +
            `'${boundRepo}' which does not match the apply context. ` +
            `Human action required: \`${mintHint}\`.`,
          grantId: grant.id,
        };
        continue;
      }
    }
    if (boundWorktree.length > 0) {
      const grantWt = resolve(boundWorktree);
      // Worktree compare is path-normalize only (resolve); keep exact string match of
      // resolved absolute paths without case-folding (same rule as parent/target paths).
      if (grantWt !== projectAbs) {
        lastReject = {
          code: "authz-grant-project-mismatch",
          reason:
            `Directive denied scope:decompose apply: grant ${grant.id} is bound to worktree ` +
            `'${boundWorktree}' which does not match project root '${projectAbs}'. ` +
            `Human action required: \`${mintHint}\`.`,
          grantId: grant.id,
        };
        continue;
      }
    }

    return {
      allowed: true,
      code: "authz-allow",
      reason:
        `Directive allowed scope:decompose apply via human-origin grant ${grant.id} ` +
        `bound to draft digest ${digest.slice(0, 12)}….`,
      humanApprovalRef: grant.id,
      draftDigest: digest,
    };
  }

  if (lastReject !== null) {
    return {
      allowed: false,
      code: lastReject.code,
      reason: lastReject.reason,
      humanApprovalRef: lastReject.grantId,
      draftDigest: digest,
    };
  }

  return {
    allowed: false,
    code: "authz-grant-missing",
    reason:
      "Directive denied scope:decompose apply: no human-origin grant covers " +
      `'${SCOPE_DECOMPOSE_APPLY_STRUCTURAL}' for this draft digest. ` +
      `Human action required: \`${mintHint}\` ` +
      "(self-authored lifecycle/dispatch tokens do not count). --check remains ungated.",
    humanApprovalRef: null,
    draftDigest: digest,
  };
}

export interface MintDecomposeStructuralApplyGrantInput {
  readonly projectRoot: string;
  readonly parentPath: string;
  readonly draftPath: string;
  /** When omitted, digest is computed from draftPath on-disk bytes. */
  readonly contentDigest?: string;
  readonly actor?: string;
  readonly repo?: string | null;
  readonly expiresAt?: string | null;
  readonly singleUse?: boolean;
  readonly grantId?: string;
  readonly now?: Date;
  readonly pinActive?: boolean;
  readonly eventRef?: string | null;
}

/**
 * Operator mint helper: human-origin grant bound to exact draft bytes + paths.
 * Sole mint path remains mintHumanOriginGrant (operator-cli origin).
 */
export function mintDecomposeStructuralApplyGrant(
  input: MintDecomposeStructuralApplyGrantInput,
): HumanOriginGrant {
  const parentRel = toProjectRelativePosix(input.projectRoot, input.parentPath);
  const targetRel = toProjectRelativePosix(input.projectRoot, input.draftPath);
  if (parentRel === null || targetRel === null) {
    throw new Error(
      "mintDecomposeStructuralApplyGrant: parentPath and draftPath must resolve inside projectRoot",
    );
  }
  const digest =
    input.contentDigest !== undefined
      ? (normalizeDigest(input.contentDigest) ?? "")
      : sha256FileHex(
          isAbsolute(input.draftPath)
            ? input.draftPath
            : resolve(input.projectRoot, input.draftPath),
        );
  if (digest.length === 0) {
    throw new Error("mintDecomposeStructuralApplyGrant: contentDigest must be non-empty");
  }

  const mintInput: MintGrantInput = {
    projectRoot: input.projectRoot,
    actor: input.actor,
    operations: [SCOPE_DECOMPOSE_APPLY_STRUCTURAL],
    contentDigest: digest,
    parentPath: parentRel,
    targetPath: targetRel,
    worktree: resolve(input.projectRoot),
    repo: input.repo ?? null,
    expiresAt: input.expiresAt ?? null,
    singleUse: input.singleUse === true,
    grantId: input.grantId,
    now: input.now,
    pinActive: input.pinActive,
    eventRef: input.eventRef ?? null,
  };
  return mintHumanOriginGrant(mintInput);
}
