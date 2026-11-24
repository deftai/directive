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
    'const REGISTRATION_CHALLENGE_SCHEMA = "deft.registration-challenge.v1";',
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
    return { request: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch (err) {
    return { error: "fragment is not JSON: " + String(err) };
  }
}

function fieldLine(key, value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (text.indexOf("\\n") >= 0 || text.indexOf("\\r") >= 0) {
    throw new Error(key + " must not contain a newline");
  }
  return key + " " + text;
}

export function shownApprove(request) {
  const lines = [fieldLine("repo", request.repo)];
  request.entries.forEach(function (entry, index) {
    lines.push("entry " + String(index + 1));
    lines.push(fieldLine("kind", entry.kind));
    lines.push(fieldLine("planId", entry.planId));
    lines.push(fieldLine("xbriefRelPath", entry.xbriefRelPath));
    lines.push(fieldLine("recordRel", entry.recordRel));
    lines.push(fieldLine("changeKind", entry.changeKind === null ? "null" : entry.changeKind));
    lines.push(fieldLine("contractDigest", entry.contractDigest));
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

export function shownTrust(request, members) {
  const lines = [
    fieldLine("mode", request.mode),
    fieldLine("repo", request.repo),
    fieldLine("rp", request.rp.id),
  ];
  const origins = request.rp && Array.isArray(request.rp.origins) ? request.rp.origins : [];
  for (const origin of origins) {
    lines.push(fieldLine("origin", origin));
  }
  if (request.name) lines.push(fieldLine("name", request.name));
  if (request.credentialId) lines.push(fieldLine("credential", request.credentialId));
  const list = Array.isArray(members) ? members : [];
  for (const approver of list) {
    lines.push(
      fieldLine("member", approver.name + " " + approver.credentialId + " " + approver.aaguid + " " + String(approver.backupEligible)),
    );
  }
  return lines.join("\\n");
}

function resultingMembers(request, created) {
  const previous = request.predecessor && request.predecessor.approvers ? request.predecessor.approvers : [];
  if (request.mode === "remove") {
    return previous.filter(function (approver) { return approver.credentialId !== request.credentialId; });
  }
  const rooting = request.mode === "re-root" || !request.predecessor;
  if (rooting) return created ? [created] : [];
  return created ? previous.concat([created]) : previous;
}

function b64urlToBuffer(text) {
  const bytes = base64urlDecode(text);
  if (bytes === null) throw new Error("bad base64url");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function concatBytes(parts) {
  let n = 0;
  for (const part of parts) n += part.length;
  const out = new Uint8Array(n);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodeCbor(bytes, offset, depth) {
  const pos0 = offset || 0;
  const deep = depth || 0;
  if (deep > 8) throw new Error("CBOR nesting too deep");
  if (pos0 >= bytes.length) throw new Error("CBOR truncated");
  const initial = bytes[pos0];
  const major = initial >> 5;
  const info = initial & 31;
  let pos = pos0 + 1;
  function readLength() {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (size === 0) throw new Error("CBOR indefinite or reserved length");
    if (pos + size > bytes.length) throw new Error("CBOR truncated");
    let n = 0;
    for (let i = 0; i < size; i += 1) n = n * 256 + bytes[pos + i];
    pos += size;
    if (!Number.isSafeInteger(n)) throw new Error("CBOR integer too large");
    return n;
  }
  if (major === 7) {
    if (info === 20) return { value: false, end: pos };
    if (info === 21) return { value: true, end: pos };
    if (info === 22) return { value: null, end: pos };
    if (info === 23) return { value: undefined, end: pos };
    throw new Error("CBOR floats and simple values are not supported");
  }
  if (major === 6) throw new Error("CBOR tags are not supported");
  const n = readLength();
  if (major === 0) return { value: n, end: pos };
  if (major === 1) return { value: -1 - n, end: pos };
  if (major === 2 || major === 3) {
    if (pos + n > bytes.length) throw new Error("CBOR truncated");
    const slice = bytes.slice(pos, pos + n);
    pos += n;
    if (major === 2) return { value: slice, end: pos };
    return { value: new TextDecoder("utf-8", { fatal: true }).decode(slice), end: pos };
  }
  if (major === 4) {
    const arr = [];
    for (let i = 0; i < n; i += 1) {
      const item = decodeCbor(bytes, pos, deep + 1);
      arr.push(item.value);
      pos = item.end;
    }
    return { value: arr, end: pos };
  }
  if (major === 5) {
    const map = new Map();
    for (let i = 0; i < n; i += 1) {
      const key = decodeCbor(bytes, pos, deep + 1);
      if (typeof key.value !== "number" && typeof key.value !== "string") {
        throw new Error("CBOR map keys must be integers or text");
      }
      if (map.has(key.value)) throw new Error("CBOR map has a duplicate key");
      const value = decodeCbor(bytes, key.end, deep + 1);
      map.set(key.value, value.value);
      pos = value.end;
    }
    return { value: map, end: pos };
  }
  throw new Error("CBOR major type not supported");
}

function derLen(n) {
  if (n < 128) return Uint8Array.from([n]);
  if (n < 256) return Uint8Array.from([0x81, n]);
  return Uint8Array.from([0x82, (n >> 8) & 255, n & 255]);
}

function derTlv(tag, body) {
  return concatBytes([Uint8Array.from([tag]), derLen(body.length), body]);
}

function derInt(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
  let mag = bytes.slice(i);
  if ((mag[0] & 0x80) !== 0) mag = concatBytes([Uint8Array.from([0]), mag]);
  return derTlv(0x02, mag);
}

/** COSE_Key bytes to SPKI DER. ES256, RS256 and Ed25519 only. */
export function coseKeyToSpki(cose) {
  const decoded = decodeCbor(cose, 0, 0);
  if (decoded.end !== cose.length || !(decoded.value instanceof Map)) {
    throw new Error("COSE key must be one map");
  }
  const map = decoded.value;
  const kty = map.get(1);
  const alg = map.get(3);
  if (kty === 2 && alg === -7) {
    if (map.get(-1) !== 1) throw new Error("ES256 key must use curve P-256");
    const x = map.get(-2);
    const y = map.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
      throw new Error("P-256 coordinates must be 32 bytes");
    }
    const prefix = Uint8Array.from([
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
    ]);
    return { alg: -7, spki: concatBytes([prefix, x, y]) };
  }
  if (kty === 1 && alg === -8) {
    if (map.get(-1) !== 6) throw new Error("EdDSA key must use curve Ed25519");
    const x = map.get(-2);
    if (!(x instanceof Uint8Array) || x.length !== 32) throw new Error("Ed25519 key must be 32 bytes");
    const prefix = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
    return { alg: -8, spki: concatBytes([prefix, x]) };
  }
  if (kty === 3 && alg === -257) {
    const modulus = map.get(-1);
    const exponent = map.get(-2);
    if (!(modulus instanceof Uint8Array) || !(exponent instanceof Uint8Array)) {
      throw new Error("RSA key parameters missing");
    }
    const pkcs1 = derTlv(0x30, concatBytes([derInt(modulus), derInt(exponent)]));
    const algId = Uint8Array.from([
      0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ]);
    const bit = derTlv(0x03, concatBytes([Uint8Array.from([0]), pkcs1]));
    return { alg: -257, spki: derTlv(0x30, concatBytes([algId, bit])) };
  }
  throw new Error("COSE key is not ES256, RS256 or Ed25519");
}

function attestedFromCreate(cred) {
  const att = new Uint8Array(cred.response.attestationObject);
  const decoded = decodeCbor(att, 0, 0);
  if (decoded.end !== att.length || !(decoded.value instanceof Map)) {
    throw new Error("attestationObject must be one CBOR map");
  }
  const authData = decoded.value.get("authData");
  if (!(authData instanceof Uint8Array) || authData.length < 55) {
    throw new Error("registration has no attested credential data");
  }
  const flags = authData[32];
  if ((flags & 0x40) === 0) throw new Error("registration has no attested credential data");
  const aaguid = authData.slice(37, 53);
  const idLen = (authData[53] << 8) + authData[54];
  if (55 + idLen > authData.length) throw new Error("credential id truncated");
  const credentialId = authData.slice(55, 55 + idLen);
  const cose = decodeCbor(authData, 55 + idLen, 0);
  const key = coseKeyToSpki(authData.slice(55 + idLen, cose.end));
  const hex = Array.from(aaguid).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  return {
    credentialId: base64urlEncode(credentialId),
    publicKey: base64urlEncode(key.spki),
    alg: key.alg,
    aaguid: hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20),
    backupEligible: (flags & 0x08) !== 0,
  };
}

function allowFromIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("the request has no credential ids to select");
  }
  return ids.map(function (id) {
    return { type: "public-key", id: b64urlToBuffer(id) };
  });
}

async function sha256Hex(bytes) {
  const digest = await sha256Bytes(bytes);
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function assertionFrom(cred) {
  const response = cred.response;
  return {
    authenticatorData: base64urlEncode(new Uint8Array(response.authenticatorData)),
    clientDataJSON: base64urlEncode(new Uint8Array(response.clientDataJSON)),
    signature: base64urlEncode(new Uint8Array(response.signature)),
  };
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
  let busy = false;
  if (request.mode === "approve") {
    try {
      set.textContent = shownApprove(request);
    } catch (err) {
      status.textContent = String(err);
      return;
    }
    button.textContent = "Approve";
    button.addEventListener("click", async function () {
      if (busy) return;
      busy = true;
      button.disabled = true;
      const shown = set.textContent || "";
      try {
        const challenge = await challengeFromShown(shown);
        const parsed = entriesFromShown(shown);
        if (parsed.error) throw new Error(parsed.error);
        const cred = await navigator.credentials.get({
          publicKey: {
            challenge: b64urlToBuffer(challenge),
            rpId: request.rp.id,
            allowCredentials: allowFromIds(request.credentialIds),
            userVerification: "required",
          },
        });
        const response = cred.response;
        blob.value = JSON.stringify({
          payload: buildRecordApprovalPayload(parsed.repo, parsed.entries),
          credentialId: base64urlEncode(new Uint8Array(cred.rawId)),
          authenticatorData: base64urlEncode(new Uint8Array(response.authenticatorData)),
          clientDataJSON: base64urlEncode(new Uint8Array(response.clientDataJSON)),
          signature: base64urlEncode(new Uint8Array(response.signature)),
        });
        status.textContent = "Copy the blob and pass it to --assertion.";
      } catch (err) {
        status.textContent = String(err);
      } finally {
        busy = false;
        button.disabled = false;
      }
    });
    return;
  }
  try {
    set.textContent = shownTrust(request, resultingMembers(request, null));
  } catch (err) {
    status.textContent = String(err);
    return;
  }
  button.textContent = request.mode === "remove" ? "Remove" : "Enroll";
  button.addEventListener("click", async function () {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      let created = null;
      let registration = null;
      if (request.mode !== "remove") {
        const regPayload = buildRegistrationChallengePayload({
          repo: request.repo,
          rpId: request.rp.id,
          name: request.name,
          predecessorDigest: request.predecessor ? request.predecessorDigest || null : null,
        });
        const createdCred = await navigator.credentials.create({
          publicKey: {
            rp: { id: request.rp.id, name: request.repo },
            user: { id: crypto.getRandomValues(new Uint8Array(16)), name: request.name, displayName: request.name },
            challenge: await sha256Bytes(canonicalBytes(regPayload)),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }, { type: "public-key", alg: -8 }],
            authenticatorSelection: { userVerification: "required" },
            attestation: "direct",
          },
        });
        const attested = attestedFromCreate(createdCred);
        const rawId = base64urlEncode(new Uint8Array(createdCred.rawId));
        if (rawId !== attested.credentialId) throw new Error("credential id mismatch");
        created = {
          name: request.name,
          credentialId: attested.credentialId,
          publicKey: attested.publicKey,
          alg: attested.alg,
          aaguid: attested.aaguid,
          backupEligible: attested.backupEligible,
        };
        registration = {
          attestationObject: base64urlEncode(new Uint8Array(createdCred.response.attestationObject)),
          clientDataJSON: base64urlEncode(new Uint8Array(createdCred.response.clientDataJSON)),
        };
      }
      const previous = request.predecessor && request.predecessor.approvers ? request.predecessor.approvers : [];
      const rooting = request.mode === "re-root" || !request.predecessor;
      const nextApprovers = resultingMembers(request, created);
      set.textContent = shownTrust(request, nextApprovers);
      let allowIds;
      if (request.mode === "remove") {
        allowIds = previous.map(function (approver) { return approver.credentialId; });
      } else if (rooting) {
        allowIds = [created.credentialId];
      } else {
        allowIds = previous.map(function (approver) { return approver.credentialId; });
      }
      const body = { repo: request.repo, rp: request.rp, approvers: nextApprovers };
      const bodyDigest = await sha256Hex(canonicalBytes(body));
      const transition = buildTransitionPayload({
        repo: request.repo,
        predecessorDigest: request.predecessor ? request.predecessorDigest || null : null,
        bodyDigest: bodyDigest,
      });
      const assertionCred = await navigator.credentials.get({
        publicKey: {
          challenge: await sha256Bytes(canonicalBytes(transition)),
          rpId: request.rp.id,
          allowCredentials: allowFromIds(allowIds),
          userVerification: "required",
        },
      });
      const assertion = assertionFrom(assertionCred);
      const signerId = base64urlEncode(new Uint8Array(assertionCred.rawId));
      const proof = rooting
        ? {
            kind: request.mode === "re-root" ? "re-root" : "root",
            credentialId: created.credentialId,
            registration: registration,
            assertion: assertion,
          }
        : { kind: "transition", credentialId: signerId, assertion: assertion };
      blob.value = JSON.stringify({ schema: "deft.approvers.v1", body: body, proof: proof });
      status.textContent = "Copy the trust file and pass it to --assertion.";
    } catch (err) {
      status.textContent = String(err);
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
}

if (typeof document !== "undefined" && document.getElementById("act")) void boot();
`;

const out = join(root, "content/tools/approvers/ceremony.js");
writeFileSync(out, `/** Generated by scripts/build-approvers-page.mjs from canonical.ts (#6945). */\n${transpiled}\n${page}`, "utf8");
process.stdout.write(`wrote ${out}\n`);
