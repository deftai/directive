/**
 * Bundle the canonical encoder into the ceremony page (#6945).
 *
 * The page and the Node verifier share packages/core/src/approvers/canonical.ts.
 * Run: node scripts/build-approvers-page.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "packages/core/src/approvers/canonical.ts");
const source = readFileSync(sourcePath, "utf8").replace(
  /import \{[\s\S]*?\} from "\.\/types\.js";/,
  [
    'const APPROVAL_RECORD_KINDS = ["observable-scope", "intent-constraint"];',
    'const APPROVERS_TRANSITION_SCHEMA = "deft.approvers-transition.v1";',
    'const RECORD_APPROVAL_SCHEMA = "deft.record-approval.v1";',
  ].join("\n"),
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  fileName: "canonical.ts",
}).outputText;

const page = `
export const MAX_REQUEST_BYTES = 6000;
export const QR_URL_MAX = 1500;

export function decodeRequest(fragment) {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const bytes = base64urlDecode(raw);
  if (bytes === null) return { error: "fragment is not canonical base64url" };
  if (bytes.length > MAX_REQUEST_BYTES) return { error: "request is too large; split the cohort" };
  try {
    return { request: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (err) {
    return { error: "fragment is not JSON: " + String(err) };
  }
}

export function shownApprove(request) {
  const lines = ["repo " + request.repo];
  request.entries.forEach(function (entry, index) {
    lines.push("entry " + String(index + 1));
    lines.push("kind " + entry.kind);
    lines.push("planId " + entry.planId);
    lines.push("xbriefRelPath " + entry.xbriefRelPath);
    lines.push("recordRel " + entry.recordRel);
    lines.push("changeKind " + (entry.changeKind === null ? "null" : entry.changeKind));
    lines.push("contractDigest " + entry.contractDigest);
  });
  return lines.join("\\n");
}

export function entriesFromShown(shown) {
  const lines = shown.split("\\n");
  const repoLine = lines[0] || "";
  if (!repoLine.startsWith("repo ")) return { error: "shown text has no repo line" };
  const repo = repoLine.slice(5);
  const entries = [];
  let current = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith("entry ")) {
      if (current !== null) entries.push(current);
      current = {};
      continue;
    }
    if (current === null) return { error: "shown text has a field before an entry" };
    const space = line.indexOf(" ");
    if (space < 0) return { error: "shown text has a bad field line" };
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    current[key] = key === "changeKind" && value === "null" ? null : value;
  }
  if (current !== null) entries.push(current);
  if (entries.length === 0) return { error: "shown text has no entries" };
  return { repo: repo, entries: entries };
}

export async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

/** Challenge computed from the text the page shows, not from a hidden copy. */
export async function challengeFromShown(shown) {
  const parsed = entriesFromShown(shown);
  if (parsed.error) throw new Error(parsed.error);
  const payload = buildRecordApprovalPayload(parsed.repo, parsed.entries);
  return base64urlEncode(await sha256Bytes(canonicalBytes(payload)));
}

export function shownTrust(request, created) {
  const lines = [
    "mode " + request.mode,
    "repo " + request.repo,
    "rp " + request.rp.id,
    "name " + (request.name || ""),
    "credential " + (request.credentialId || ""),
  ];
  const previous = request.predecessor && request.predecessor.approvers ? request.predecessor.approvers : [];
  for (const approver of previous) {
    if (request.mode === "remove" && approver.credentialId === request.credentialId) continue;
    lines.push("keeps " + approver.name + " " + approver.credentialId);
  }
  if (created) {
    lines.push("new " + created.name + " " + created.aaguid + " " + String(created.backupEligible));
  }
  return lines.join("\\n");
}

function b64urlToBuffer(text) {
  const bytes = base64urlDecode(text);
  if (bytes === null) throw new Error("bad base64url");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function boot() {
  const decoded = decodeRequest(location.hash);
  const status = document.getElementById("status");
  const set = document.getElementById("set");
  const qr = document.getElementById("qr");
  const blob = document.getElementById("blob");
  const button = document.getElementById("act");
  if (!status || !set || !button || !blob) return;
  if (decoded.error) {
    status.textContent = decoded.error;
    return;
  }
  const request = decoded.request;
  if (location.href.length <= QR_URL_MAX && qr) qr.textContent = "qr: " + location.href;
  if (request.mode === "approve") {
    set.textContent = shownApprove(request);
    button.textContent = "Approve";
    button.addEventListener("click", async function () {
      try {
        const challenge = await challengeFromShown(set.textContent || "");
        const cred = await navigator.credentials.get({
          publicKey: {
            challenge: b64urlToBuffer(challenge),
            rpId: request.rp.id,
            userVerification: "required",
          },
        });
        const response = cred.response;
        blob.value = JSON.stringify({
          payload: buildRecordApprovalPayload(
            entriesFromShown(set.textContent || "").repo,
            entriesFromShown(set.textContent || "").entries,
          ),
          credentialId: base64urlEncode(new Uint8Array(cred.rawId)),
          authenticatorData: base64urlEncode(new Uint8Array(response.authenticatorData)),
          clientDataJSON: base64urlEncode(new Uint8Array(response.clientDataJSON)),
          signature: base64urlEncode(new Uint8Array(response.signature)),
        });
        status.textContent = "Copy the blob and pass it to --assertion.";
      } catch (err) {
        status.textContent = String(err);
      }
    });
    return;
  }
  set.textContent = shownTrust(request);
  button.textContent = request.mode === "remove" ? "Remove" : "Enroll";
  button.addEventListener("click", async function () {
    try {
      let created = null;
      if (request.mode !== "remove") {
        const createdCred = await navigator.credentials.create({
          publicKey: {
            rp: { id: request.rp.id, name: request.repo },
            user: { id: crypto.getRandomValues(new Uint8Array(16)), name: request.name, displayName: request.name },
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }, { type: "public-key", alg: -8 }],
            authenticatorSelection: { userVerification: "required" },
            attestation: request.mode === "enroll" && !request.predecessor ? "direct" : "direct",
          },
        });
        created = { name: request.name, aaguid: "pending", backupEligible: false, credential: createdCred };
        set.textContent = shownTrust(request, created);
      }
      const allow = [];
      const previous = request.predecessor && request.predecessor.approvers ? request.predecessor.approvers : [];
      for (const approver of previous) {
        if (request.mode === "remove" && approver.credentialId === request.credentialId) continue;
        allow.push({ type: "public-key", id: b64urlToBuffer(approver.credentialId) });
      }
      status.textContent = "An enrolled key must sign this set in the same session.";
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: request.rp.id,
          allowCredentials: allow,
          userVerification: "required",
        },
      });
      blob.value = JSON.stringify({ created: created !== null, assertionId: assertion.id, shown: set.textContent });
      status.textContent = "The page built this from the text above. Paste is not the trust-file proof until the authenticator returns one; copy the blob the verifier accepts.";
    } catch (err) {
      status.textContent = String(err);
    }
  });
}

if (typeof document !== "undefined" && document.getElementById("act")) void boot();
`;

const out = join(root, "content/tools/approvers/ceremony.js");
writeFileSync(out, `/** Generated by scripts/build-approvers-page.mjs from canonical.ts (#6945). */\n${transpiled}\n${page}`, "utf8");
process.stdout.write(`wrote ${out}\n`);
