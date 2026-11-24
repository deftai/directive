/**
 * Ceremony links for signed approvals (#6945).
 *
 * `--request` prints one https link and writes nothing. The fragment is the
 * canonical request the page renders and hashes. A request over the fixed
 * size is refused so the operator splits the cohort. The QR line is printed
 * only when the link is short enough to scan.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { approvers } from "@deftai/directive-core";
import { resolveMergeBase } from "@deftai/directive-core/intent-constraint";

export const CEREMONY_REQUEST_SCHEMA = "deft.ceremony-request.v1";
export const CEREMONY_PATH = "/ceremony.html";
/** Canonical request bytes above this refuse. Split the cohort. */
export const MAX_REQUEST_BYTES = 6000;
/** A link at most this long is also printed as a QR payload. */
export const QR_URL_MAX = 1500;

export interface CeremonyRequest {
  readonly schema: typeof CEREMONY_REQUEST_SCHEMA;
  readonly mode: "approve" | "enroll" | "remove" | "re-root";
  readonly repo: string;
  readonly rp: { readonly id: string; readonly origins: readonly string[] };
  readonly entries?: readonly approvers.RecordApprovalEntry[];
  readonly name?: string;
  readonly credentialId?: string;
  /** Enrolled credential ids. Approve uses them as allowCredentials. */
  readonly credentialIds?: readonly string[];
  readonly predecessorDigest?: string | null;
  readonly predecessor?: approvers.ApproversBody | null;
}

export function rpFromOrigin(
  origin: string,
): { id: string; origins: [string] } | { error: string } {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { error: `origin ${origin} is not a URL` };
  }
  if (url.protocol !== "https:" || url.origin !== origin) {
    return { error: `origin ${origin} must be an https origin with no path` };
  }
  const id = url.hostname.toLowerCase();
  if (id === "localhost" || id.endsWith(".localhost")) {
    return { error: "origin must not be localhost" };
  }
  return { id, origins: [url.origin] };
}

export function buildCeremonyLink(
  origin: string,
  request: CeremonyRequest,
): { url: string; qr: string | null } | { error: string } {
  const rp = rpFromOrigin(origin);
  if ("error" in rp) return rp;
  let bytes: Uint8Array;
  try {
    bytes = approvers.canonicalBytes(request);
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (bytes.length > MAX_REQUEST_BYTES) {
    return {
      error: `request is ${String(bytes.length)} bytes, over ${String(MAX_REQUEST_BYTES)}; split the cohort (#6945)`,
    };
  }
  const url = `${rp.origins[0]}${CEREMONY_PATH}#${approvers.base64urlEncode(bytes)}`;
  return { url, qr: url.length <= QR_URL_MAX ? url : null };
}

export function formatCeremonyOutput(link: { url: string; qr: string | null }): string {
  const lines = [`link: ${link.url}`];
  if (link.qr !== null) lines.push(`qr: ${link.qr}`);
  lines.push(approvers.SIGNED_APPROVAL_CLAIM);
  return lines.join("\n");
}

export function signedLevelUsage(): string {
  return (
    "  Signed level (#6945): when .deft/approvers.json is on the merge base, pass --request " +
    "(builds the frozen set, prints the ceremony link, writes nothing) or --assertion <blob> " +
    "(verifies that blob and writes exactly those records). No terminal step. Without a trust " +
    `file the declared write is unchanged. ${approvers.SIGNED_APPROVAL_CLAIM}`
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The record-approval blob `--assertion` accepts. */
export function parseRecordAssertion(text: string): approvers.RecordApproval | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err: unknown) {
    return { error: `assertion is not JSON: ${String(err)}` };
  }
  if (!isObject(raw)) return { error: "assertion must be an object" };
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "authenticatorData,clientDataJSON,credentialId,payload,signature") {
    return {
      error:
        "assertion keys must be exactly payload, credentialId, authenticatorData, clientDataJSON, signature",
    };
  }
  const payloadError = approvers.recordApprovalPayloadError(raw.payload);
  if (payloadError !== null) return { error: `assertion payload: ${payloadError}` };
  for (const field of ["credentialId", "authenticatorData", "clientDataJSON", "signature"]) {
    if (typeof raw[field] !== "string" || raw[field].length === 0) {
      return { error: `assertion.${field} must be a non-empty string` };
    }
  }
  return raw as unknown as approvers.RecordApproval;
}

export type SignedWriteDecision =
  | { readonly kind: "declared" }
  | { readonly kind: "refuse"; readonly code: 1 | 2; readonly message: string }
  | { readonly kind: "request"; readonly level: Extract<approvers.SignedLevel, { ok: true }> }
  | {
      readonly kind: "assertion";
      readonly level: Extract<approvers.SignedLevel, { ok: true }>;
      readonly approval: approvers.RecordApproval;
    };

/** What a record verb does once the merge-base level is known. */
export function decideSignedWrite(
  level: approvers.SignedLevel,
  request: boolean,
  assertionText: string | null,
): SignedWriteDecision {
  if (request && assertionText !== null) {
    return { kind: "refuse", code: 2, message: "pass --request or --assertion, not both" };
  }
  if (level.level === "none") {
    if (request || assertionText !== null) {
      return {
        kind: "refuse",
        code: 2,
        message:
          "not at the signed level: no .deft/approvers.json on the merge base. The declared write is unchanged. " +
          approvers.SIGNED_APPROVAL_CLAIM,
      };
    }
    return { kind: "declared" };
  }
  if (!level.ok) {
    return {
      kind: "refuse",
      code: level.code,
      message: `signed level (.deft/approvers.json) refuses: ${level.reason}. ${approvers.SIGNED_APPROVAL_CLAIM}`,
    };
  }
  if (!request && assertionText === null) {
    return {
      kind: "refuse",
      code: 2,
      message:
        "at the signed level pass --request (writes nothing) or --assertion <blob>. No terminal step. " +
        approvers.SIGNED_APPROVAL_CLAIM,
    };
  }
  if (request) return { kind: "request", level };
  const approval = parseRecordAssertion(assertionText ?? "");
  if ("error" in approval) return { kind: "refuse", code: 2, message: approval.error };
  return { kind: "assertion", level, approval };
}

function insideWorkTree(projectRoot: string): boolean {
  try {
    const out = execFileSync("git", ["-C", projectRoot, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

/**
 * Merge base for the record verbs. A directory that is not a work tree stays
 * on HEAD and resolves as unsigned. A work tree uses the intent-constraint
 * base resolver and reports a failure instead of reading HEAD.
 */
export function resolveCliSignedLevel(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): approvers.SignedLevel {
  if (!insideWorkTree(projectRoot)) {
    return approvers.resolveSignedLevel(projectRoot, "HEAD", { env });
  }
  const base = resolveMergeBase(projectRoot);
  if (typeof base !== "string") {
    return { level: "signed", ok: false, code: 2, reason: base.error };
  }
  return approvers.resolveSignedLevel(projectRoot, base, { env });
}

/**
 * Trust state the enroll and remove verbs sign against. Only versions in the
 * git history verification reads count. An uncommitted trust file is refused
 * so it cannot become the predecessor of another change.
 */
export function loadCliTrustState(
  projectRoot: string,
  options: {
    readonly verifyRegistration?: approvers.RegistrationVerifier;
    readonly mergeBase?: string;
  } = {},
): { state: approvers.TrustChainState | null } | { error: string } {
  const history = approvers.loadTrustHistory(projectRoot, options.mergeBase ?? "HEAD");
  if (history.kind === "shallow") {
    return { error: `shallow clone: ${approvers.SHALLOW_REMEDIATION}` };
  }
  if (history.kind === "error") return { error: history.reason };
  let state: approvers.TrustChainState | null = null;
  if (history.kind === "versions") {
    for (const version of history.versions) {
      if (version.text === null) {
        return {
          error: `.deft/approvers.json was deleted at ${version.commit}; once a repository opts in it stays signed`,
        };
      }
      const parsed = approvers.parseApproversFile(version.text);
      if ("error" in parsed) return { error: parsed.error };
      if (
        state !== null &&
        approvers.computeVersionDigest(parsed) === approvers.computeVersionDigest(state.file)
      ) {
        continue;
      }
      const next = approvers.applyTrustVersion(state, parsed, {
        at: version.commit,
        verifyRegistration: options.verifyRegistration,
      });
      if (!next.ok) return { error: next.reason };
      state = next.state;
    }
  }
  const disk = join(projectRoot, approvers.APPROVERS_FILE_REL);
  if (existsSync(disk)) {
    let text: string;
    try {
      text = readFileSync(disk, "utf8");
    } catch (err: unknown) {
      return { error: String(err) };
    }
    const parsed = approvers.parseApproversFile(text);
    if ("error" in parsed) return { error: parsed.error };
    const committed = state === null ? null : approvers.computeVersionDigest(state.file);
    if (committed !== approvers.computeVersionDigest(parsed)) {
      return {
        error:
          "commit .deft/approvers.json before another change; verification reads git history, and an uncommitted trust file cannot be the predecessor",
      };
    }
  }
  return { state };
}
