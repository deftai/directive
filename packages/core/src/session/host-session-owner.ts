/**
 * Where a host publishes the session id Directive uses as the occupancy owner
 * (#3611 / #3873).
 *
 * This is payload/environment classification, not authentication: cooperative
 * owner ids are locally forgeable by another same-user process. It lives here,
 * outside the hook classifier, because two processes must agree on the answer.
 * The hook resolves it from its own environment; the CLI resolves it from the
 * shell the same host spawned. A claim made under a different id than the write
 * gate later presents is the #3873 defect -- the session denied by its own lease.
 */

export const HOST_IDENTITY_PROVIDERS = ["codex", "claude", "cursor", "grok"] as const;
export type HookHostIdentityProvider = (typeof HOST_IDENTITY_PROVIDERS)[number];
export const MAX_HOOK_HOST_IDENTITY_UTF8_BYTES = 512;

/**
 * Where a provider publishes its owner id.
 *
 * `payload` providers carry a verified field on every hook invocation.
 * `host-env` providers publish a stable id in the environment of the processes
 * the host spawns. That environment is host-set: the hook is a sibling of the
 * agent's shell rather than a descendant, so a shell export cannot reach it.
 */
export type HookHostIdentitySource =
  | { readonly kind: "payload"; readonly field: string }
  | { readonly kind: "host-env"; readonly variable: string };

const HOST_IDENTITY_SOURCES: Readonly<Record<HookHostIdentityProvider, HookHostIdentitySource>> = {
  codex: { kind: "payload", field: "session_id" },
  claude: { kind: "payload", field: "session_id" },
  cursor: { kind: "payload", field: "conversation_id" },
  grok: { kind: "host-env", variable: "GROK_SESSION_ID" },
};

// #4431: payload hosts stay payload-only. Adding CLAUDE_CODE_SESSION_ID (or a
// Codex/Cursor env twin) as host-env is refused: the value is shell-reachable
// and not distinct per agent session, so a child inherits its parent's owner.

/**
 * The `host-env` half of the table above, resolved once.
 *
 * `ambientHostSessionOwner` reads it to build the owner list, and
 * `HOST_ENV_IDENTITY_VARIABLES` projects the variable names out of the same
 * entries, so the production scan and the surface a caller scrubs cannot name
 * different providers (#3954).
 */
const HOST_ENV_IDENTITY_ENTRIES: readonly {
  readonly provider: HookHostIdentityProvider;
  readonly variable: string;
}[] = HOST_IDENTITY_PROVIDERS.flatMap((provider) => {
  const source = HOST_IDENTITY_SOURCES[provider];
  return source.kind === "host-env" ? [{ provider, variable: source.variable }] : [];
});

/**
 * Every variable a `host-env` provider publishes.
 *
 * Exported because the ambient step is now read by the CLI occupancy surfaces
 * as well as the hook, so callers that must control the whole ambient identity
 * surface — a hermetic test process, a dispatcher scrubbing a child's
 * environment — need the list rather than the one variable its author knew
 * about (#3954).
 */
export const HOST_ENV_IDENTITY_VARIABLES: readonly string[] = HOST_ENV_IDENTITY_ENTRIES.map(
  (entry) => entry.variable,
);

/** The identity source for a host, or null when the host has no contract. */
export function hookHostIdentitySource(host: string): HookHostIdentitySource | null {
  return (
    (HOST_IDENTITY_SOURCES as Record<string, HookHostIdentitySource | undefined>)[host] ?? null
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) return true;
  }
  return false;
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** Bound a raw host id by UTF-8 bytes, control characters and surrogate pairing. */
export function isUsableHostSessionId(raw: string): boolean {
  return (
    raw.length > 0 &&
    raw === raw.trim() &&
    !hasControlCharacter(raw) &&
    !hasUnpairedUtf16Surrogate(raw) &&
    Buffer.byteLength(raw, "utf8") <= MAX_HOOK_HOST_IDENTITY_UTF8_BYTES
  );
}

export function canonicalHostSessionId(
  provider: HookHostIdentityProvider,
  rawSessionId: string,
): string {
  const encoded = Buffer.from(rawSessionId, "utf8").toString("base64url");
  return `host:${provider}:v1:${encoded}`;
}

/**
 * The canonical owner form, derived from the provider list so every surface
 * that checks it moves when a provider is added: the lifecycle-rewrite bridge
 * and grant-time child validation both read this one pattern (#3873 / #3954).
 * Provider ids are lowercase ASCII words, so the alternation needs no escaping.
 */
export const CANONICAL_OWNER_PATTERN = new RegExp(
  `^host:(?:${HOST_IDENTITY_PROVIDERS.join("|")}):v1:[A-Za-z0-9_-]+$`,
);

/**
 * True when a value claims the canonical owner shape, well-formed or not.
 *
 * The `host:` prefix is reserved for host-published identity, so a value under
 * it that is not canonical is a malformed owner rather than an opaque id some
 * session could present (#3954).
 */
export function claimsHostSessionIdShape(value: string): boolean {
  return value.startsWith("host:");
}

export interface HostSessionIdParts {
  readonly provider: HookHostIdentityProvider;
  readonly rawSessionId: string;
}

/**
 * Split a canonical owner back into the provider and the raw id the host
 * published, or null when the value is not canonical.
 *
 * The round-trip check is the point: `host:grok:v1:Z3Jvay1zZXNzaW9uLWF` decodes
 * to the same raw id as `...LWE` does, so without it one session would have two
 * canonical strings and a grant could name the one it never presents (#3954).
 * The raw id is held to the same bound the identity surface applies, so a
 * payload the host could not have published is not accepted here either.
 */
export function parseCanonicalHostSessionId(value: string): HostSessionIdParts | null {
  if (!CANONICAL_OWNER_PATTERN.test(value)) return null;
  const segments = value.split(":");
  const provider = segments[1] as HookHostIdentityProvider;
  const encoded = segments[3] ?? "";
  const rawSessionId = Buffer.from(encoded, "base64url").toString("utf8");
  if (!isUsableHostSessionId(rawSessionId)) return null;
  if (canonicalHostSessionId(provider, rawSessionId) !== value) return null;
  return { provider, rawSessionId };
}

export type HostEnvIdentityStatus = "ok" | "missing" | "invalid";

export type HostEnvIdentityResolution =
  | { readonly status: "ok"; readonly rawSessionId: string }
  | { readonly status: "missing" | "invalid"; readonly rawSessionId: null };

/** Read one `host-env` provider's variable out of a process environment. */
export function readHostEnvIdentity(
  environ: NodeJS.ProcessEnv,
  variable: string,
): HostEnvIdentityResolution {
  const raw = environ[variable];
  // An unset variable and an empty one are one state to a host: `set X=` on
  // Windows deletes the entry, so absence must not read as a malformed value.
  if (raw === undefined || raw.length === 0) return { status: "missing", rawSessionId: null };
  return isUsableHostSessionId(raw)
    ? { status: "ok", rawSessionId: raw }
    : { status: "invalid", rawSessionId: null };
}

/**
 * The canonical owner the running host published to this process, or null.
 *
 * Used by the CLI claim path so `session:start` binds the lease to the same id
 * the write hook will present. Two live host variables are ambiguous and
 * resolve to null: picking one would bind a claim to a guess.
 */
export function ambientHostSessionOwner(environ: NodeJS.ProcessEnv = process.env): string | null {
  const resolved: string[] = [];
  for (const { provider, variable } of HOST_ENV_IDENTITY_ENTRIES) {
    const value = readHostEnvIdentity(environ, variable);
    if (value.status === "ok") resolved.push(canonicalHostSessionId(provider, value.rawSessionId));
  }
  return resolved.length === 1 ? (resolved[0] as string) : null;
}

/**
 * Env markers that mean a declared identity-contract host is running here
 * (#4431). Presence is not an occupancy identity source: it only tells the
 * claim path to refuse a mint instead of binding a UUID no later hook can
 * present.
 */
const DECLARED_IDENTITY_HOST_PRESENCE: Readonly<
  Record<HookHostIdentityProvider, readonly string[]>
> = {
  grok: ["GROK_AGENT", "GROK_SESSION_ID"],
  claude: ["CLAUDECODE", "CLAUDE_CODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"],
  cursor: ["CURSOR_AGENT", "CURSOR_TRACE_ID", "CURSOR_SESSION_ID"],
  codex: ["CODEX_SANDBOX", "CODEX_CI", "OPENAI_CODEX"],
};

/**
 * Print-only companions for payload-identity hosts (#4431).
 *
 * These can name the owner a later hook would present when no PreToolUse hook
 * is registered. They are not occupancy identity sources and must not join
 * HOST_ENV_IDENTITY_VARIABLES: CLAUDE_CODE_SESSION_ID is shell-reachable and
 * inherited by child sessions, so claiming from it reopens the #4066 class.
 */
const PAYLOAD_HOST_PRINT_COMPANIONS: Readonly<Partial<Record<HookHostIdentityProvider, string>>> = {
  claude: "CLAUDE_CODE_SESSION_ID",
};

function envMarkerPresent(environ: NodeJS.ProcessEnv, name: string): boolean {
  const raw = environ[name];
  return raw !== undefined && raw.length > 0;
}

/** Hosts with a declared identity contract visible in this process environment. */
export function detectDeclaredIdentityHosts(
  environ: NodeJS.ProcessEnv = process.env,
): readonly HookHostIdentityProvider[] {
  return HOST_IDENTITY_PROVIDERS.filter((provider) =>
    DECLARED_IDENTITY_HOST_PRESENCE[provider].some((name) => envMarkerPresent(environ, name)),
  );
}

/**
 * Canonical owner a payload host can print for recovery, or null.
 *
 * Print-only: never feed this into the claim lookup chain.
 */
export function printCompanionHostOwner(
  provider: HookHostIdentityProvider,
  environ: NodeJS.ProcessEnv = process.env,
): string | null {
  const variable = PAYLOAD_HOST_PRINT_COMPANIONS[provider];
  if (variable === undefined) return null;
  const value = readHostEnvIdentity(environ, variable);
  if (value.status !== "ok") return null;
  return canonicalHostSessionId(provider, value.rawSessionId);
}
