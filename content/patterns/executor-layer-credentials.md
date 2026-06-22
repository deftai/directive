# Executor-layer credentials (#806)

Secrets for privileged operations MUST be bound at the **invocation
layer** (the orchestrator, the command definition, the trusted shim
that wraps the capability) -- never inside the agent's context window,
prompt, filesystem, or globally-inherited environment. The agent
receives access to the **capability**, not the **credential**.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Load when:** the project gives an LLM-driven agent (or any
non-human caller whose instructions can be steered by external
content) access to a privileged CLI, HTTP API, SDK, or MCP server
that requires a token, key, or other credential.

**Why this matters:** the agent's context window is the largest
unaudited surface in an agentic system. Anything the agent can read,
print, or describe -- prompts, files it loads, tool outputs it
ingests, environment variables it enumerates -- can be exfiltrated by
an attacker who controls a single piece of upstream content (a
retrieved document, a tool result, a chat message). Putting a
credential anywhere on that surface treats the agent as a trust
boundary; it isn't. The application is the trust boundary, and the
invocation layer is the only place to enforce it.

**⚠️ See also**:
- [../coding/security.md](../coding/security.md) -- baseline security standards; `## Agent-Specific Threats` enumerates the threat model this pattern operationalises
- [./llm-app.md](./llm-app.md) -- LLM application standards; the trust-tier ordering and the tool-call validation rules here describe *what* the agent must not see, this file describes *how* to keep it from seeing them
- [./multi-agent.md](./multi-agent.md) -- multi-agent identity separation; the GitHub-credential-specific instance of this pattern (workers consume `GH_TOKEN` injected by the dispatcher, not the maintainer's `gh auth` state)

## The principle

There are three wrong ways to give an agent access to a privileged
CLI or API. They look distinct, but they all collapse to the same
failure mode: the credential enters the agent's reachable state.

- ⊗ MUST NOT pass the secret in the prompt (any tier -- system, user, retrieved, tool result). Once the bytes enter the context window the model can be coerced into emitting them via prompt-injection, can be logged by upstream telemetry, can be memorised, can be quoted back in a future turn
- ⊗ MUST NOT write the secret to a file the agent can read. The agent has a `read_file` tool or a shell; the file is reachable; the threat model is the same as putting the secret in the prompt with an extra step
- ⊗ MUST NOT set the secret as a globally-inherited environment variable in the agent's process tree. Any subprocess, any tool call, any shell command the agent emits inherits the var by default; `env`, `printenv`, `Get-ChildItem env:`, or a stray `echo $TOKEN` exfiltrates it

The correct pattern is **bind the credential at the invocation
layer**. The orchestrator (trusted, code-reviewed, not steered by
agent output) holds the credential. When the agent invokes the
capability, the execution layer injects the credential at the syscall
/ HTTP / SDK boundary. The agent only ever sees the capability name
and the result of the call.

This is the affirmative complement to existing rules:

- #587 (no-read-secret) -- tells agents what NOT to do (don't read secrets)
- #686 (tool-call safety) -- names the failure mode (safety is independent of text-level prose; an instruction that says "don't read this" does not protect against a tool call that reads it)
- #806 (this pattern) -- names what to do instead (bind at the invocation layer)

## Implementation-agnostic examples

The pattern is interface-agnostic. The shape is always the same: a
trusted shim wraps the capability; the shim attaches the credential
at exec / connect / send time; the agent gets a handle to the shim,
not to the credential.

### CLI tools

! MUST wrap privileged CLIs in a command factory that injects env
vars (or `--*-file` flags) at exec time. The factory is trusted
code; the agent sees only the wrapped command name.

```js path=null start=null
// trusted code (orchestrator / SDK / command definition)
defineCommand('gh', {
  env: { GH_TOKEN: process.env.GH_TOKEN },  // resolved in trusted code
});

// agent-reachable surface
await runCommand('gh', ['pr', 'list']);  // the agent invokes the capability; the token never appears in agent-visible state
```

The Flue SDK's `defineCommand` shape (withastro/flue README) is the
canonical worked example. The agent never sees `GH_TOKEN`; the
runner attaches it to the spawned subprocess `env=` before `execve`.

- ⊗ MUST NOT let the agent construct the env dict itself; the env mapping is constructed in trusted code
- ⊗ MUST NOT pass the secret on the command line (argv is world-readable via `/proc/<pid>/cmdline` and most shell history files); use env or `--*-file` flag pointing at a file the agent cannot read
- ⊗ MUST NOT cache the secret in a variable the agent's tool surface can dump (`process.env` snapshot, a logged config struct, a printed banner) -- the injection MUST happen at exec time, not as a long-lived process-state mutation

### HTTP APIs

! MUST proxy privileged HTTP APIs through a trusted sidecar (or a
local wrapper service) that adds the auth header at request time.
The agent talks to the sidecar via an unauthenticated local endpoint;
the sidecar talks to upstream with the credential.

```python path=null start=null
# trusted sidecar -- DO NOT copy this naively
UPSTREAM_BASE = "https://api.example.com"
ALLOWED_PATHS = {"/v1/datasets/foo", "/v1/datasets/bar"}      # explicit allow-list
FORWARD_HEADERS = {"content-type", "accept", "accept-encoding"}  # explicit allow-list

def proxy_handler(request):
    # 1. Validate the path against an allow-list -- agent-controlled path concatenation
    #    is an SSRF vector that lets a prompt-injected agent route the bound credential
    #    to an attacker-controlled host (e.g. `request.path = "//attacker.com/steal"`
    #    would resolve `UPSTREAM_BASE + request.path` to `https://attacker.com/steal`).
    if request.path not in ALLOWED_PATHS:
        return Response(403, b"path not in allow-list")
    # 2. Filter incoming headers to a known-good set -- forwarding `{**request.headers}`
    #    unfiltered lets the agent inject `Host: attacker.com`, `X-Admin: true`, or
    #    smuggle additional auth headers upstream.
    safe_headers = {k: v for k, v in request.headers.items() if k.lower() in FORWARD_HEADERS}
    # 3. Add the upstream auth header in trusted code, NEVER from request.headers.
    safe_headers["Authorization"] = f"Bearer {load_secret('upstream_token')}"
    # 4. Assemble the final URL. Safety comes from the allow-list check at step 1, NOT
    #    from urljoin -- `urllib.parse.urljoin` with an absolute path (starting with `/`)
    #    replaces the base URL's path component entirely, so it does NOT prevent path
    #    escaping on its own. urljoin is used here only as a URL-assembly utility.
    upstream_url = urljoin(UPSTREAM_BASE, request.path)
    return forward(upstream_url, headers=safe_headers, body=request.body)

# agent-reachable surface (local loopback, no auth)
agent.fetch("http://localhost:7100/v1/datasets/foo")  # the sidecar attaches the upstream token
```

- ! MUST validate the agent-supplied path against an explicit allow-list of upstream endpoints before concatenating it with the upstream base URL; raw concatenation of an agent-controlled path is an SSRF vector that forwards the bound credential to an attacker-controlled host
- ! MUST filter incoming headers to a known-good allow-list and add the upstream `Authorization` header from trusted code (never copy it from the request); spreading `{**request.headers}` lets the agent smuggle `Host`, `X-Admin`, or replacement auth headers upstream
- ⊗ MUST NOT let the agent see the upstream `Authorization` header in any response, log, error, or trace
- ⊗ MUST NOT bind the sidecar to a non-loopback interface unless it carries its own access control; the sidecar's job is to keep the upstream credential off the agent's reachable surface, not to add a new public endpoint
- ⊗ MUST NOT concatenate the agent-supplied path onto the upstream base URL without validation -- a prompt-injected agent supplying `//attacker.com/x` turns `UPSTREAM_BASE + request.path` into `https://attacker.com/x` and exfiltrates the bound credential the pattern was designed to protect

### SDKs

! MUST initialize privileged SDK clients in trusted code and pass
the **client object** (not the API key) to the agent-reachable
surface. The client owns the credential; the agent calls methods on
the client.

```python path=null start=null
# trusted code
from openai import OpenAI
client = OpenAI(api_key=load_secret("openai_key"))  # resolved in trusted code

# agent-reachable surface receives the client, never the key
def run_agent(client: OpenAI, task: str) -> str:
    return client.chat.completions.create(...).choices[0].message.content
```

- ⊗ MUST NOT pass the API key as a string parameter to an agent-reachable function; pass the initialised client
- ⊗ MUST NOT call `repr()` / `str()` / `model_dump()` / serialisation on the client and surface the result to the agent; many SDK clients embed the credential in their string representation
- ~ SHOULD prefer SDKs whose client object is opaque to introspection (no `client.api_key` attribute, no debug print of the auth header); when the SDK is leaky, wrap it in a façade that exposes only the methods the agent needs

### MCP servers

! MUST connect to privileged MCP servers in trusted code with the
required headers / auth bound at connect time; pass the **resolved
tool list** to the agent, not the connection string.

```python path=null start=null
# trusted code
async with mcp.client.connect(server_url, headers={"Authorization": f"Bearer {load_secret('mcp_token')}"}) as session:
    tools = await session.list_tools()
    # agent-reachable surface receives the tool list and the session handle; never the token or the headers
```

- ⊗ MUST NOT let the agent see the headers / connection params used to establish the MCP session
- ⊗ MUST NOT let the agent re-open the session itself (e.g. via a `reconnect` tool that accepts a URL parameter) -- the connect step is trusted; agent-initiated reconnects move that step into the agent's reachable state

### Shells and arbitrary subprocesses

When the agent has a `run_shell` / `execute_command` capability and
must invoke a privileged CLI through it, the same rules apply:

- ! MUST set the credential in the subprocess `env=` mapping at spawn time, NOT in the agent's shell session env
- ⊗ MUST NOT let the agent emit commands that read `$TOKEN`, `printenv`, `Get-ChildItem env:`, `env | grep`, or equivalent without a safety gate (the credential is in the subprocess env precisely so it is not in the agent shell env; an agent that can enumerate its own env defeats the partitioning)
- ~ SHOULD pair this pattern with a destructive-verb preflight gate (see `coding/security.md` Agent-Specific Threats and the `scripts/preflight_gh.py` reference pattern from #1019) so an agent that gets a credential through the binding layer still cannot use it to delete the repo

## Operator runbook

### Where the credential lives

The credential MUST be stored outside the agent's reach -- typically
one of:

- A secret manager (Vault, AWS Secrets Manager, GCP Secret Manager, 1Password Connect) that the orchestrator queries at startup; the resolved secret lives in orchestrator process memory only
- A gitignored `secrets/*.env` file readable only by the orchestrator process user (per `coding/security.md` `## Secrets Management`)
- An OS keychain entry whose ACL admits only the orchestrator process

The agent process MUST NOT have read access to any of the above. If
the orchestrator and the agent run in the same process (no privilege
separation), the orchestrator MUST scrub the credential from any
data structure the agent can introspect before handing control over.

### Wiring the invocation layer

1. The orchestrator resolves the credential at startup (or on first use), in trusted code, with logging set to redact the value at write time
2. The orchestrator constructs the capability shim (command factory / HTTP sidecar / SDK client / MCP session) with the credential bound in
3. The orchestrator hands the agent a handle to the shim (a command name, a localhost URL, a client object, a tool list) -- never the raw credential
4. Every agent invocation of the capability routes through the shim; the shim attaches the credential at the syscall / HTTP / SDK boundary
5. The shim logs each invocation to an audit log with the credential redacted (per `coding/security.md` `## Agent-Specific Threats`)

### Rotation and revocation

- ! MUST rotate credentials on the cadence documented in `coding/security.md` `## Secrets Management` (typically quarterly for long-lived bot PATs; auto-rotated for GitHub App installation tokens, etc.)
- ! MUST revoke and re-issue the credential immediately on any suspected exposure -- including any incident where an agent's context window or transcript was inadvertently logged with the credential present (a regression to the prompt-binding anti-pattern)
- ~ SHOULD re-issue the credential on every framework / orchestrator upgrade that could change the credential's reachable surface (e.g. a new tool that increases the agent's read access)

## Anti-patterns

- ⊗ Pasting the credential into the agent's system prompt with a "do not reveal" instruction. The model is not a security boundary; the instruction is data, not a control message. Treat any system prompt carrying a literal secret as already-leaked
- ⊗ Writing the credential to a file the agent can read (`~/.config/<tool>/token`, `secrets/agent.env` chowned to the agent user, a file the agent's `read_file` tool can target). Filesystem reachability is reachability
- ⊗ Setting the credential as a process-level env var inherited by every subprocess the agent spawns. The agent doesn't need to read it; any tool the agent invokes inherits it and can leak it
- ⊗ Round-tripping the credential through the agent's tool output. A capability that returns the credential (e.g. a `whoami` tool that echoes `Authorization`) puts the credential back on the agent's reachable surface even if it was initially bound at the invocation layer
- ⊗ Putting the credential in the URL of a request the agent constructs (`https://api/x?token=...`). URLs are logged by every layer of the request path (proxy access logs, CDN logs, browser history, error tracebacks). Use a header, and bind the header at the invocation layer
- ⊗ Storing the credential in a SDK client's mutable attribute the agent can read (`client.api_key`, `client.config.token`). Wrap the SDK in a façade if its client object is leaky
- ⊗ Treating "the agent is local / sandboxed / trusted" as an excuse to relax this pattern. Local agents are still steered by external content (issues, PRs, retrieved documents); sandboxed agents still log to telemetry the operator reads; trusted agents still get compromised. The pattern is about credential containment, not about which agent is well-behaved today
- ⊗ Logging the credential at any layer (orchestrator logs, sidecar access logs, SDK debug output, telemetry traces). Redact at log-write time, not at log-read time (per `coding/security.md` `## Secrets Management`)

## Cross-references

- #587 -- no-read-secret rule for agentic application development (the prohibition this pattern complements)
- #686 -- tool-call safety: safety is independent of text level (the failure mode this pattern prevents)
- #677 -- agent sandbox pattern (the broader containment surface this credential-binding pattern fits inside)
- #678 -- agent network egress standards (the network-layer analogue; this pattern owns the credential side, #678 owns the destination side)
- #983 -- multi-agent identity separation (the GitHub-credential-specific instance of this pattern -- workers consume `GH_TOKEN` injected by the dispatcher, not the maintainer's `gh auth` state; lives in `patterns/multi-agent.md`)
- #481 -- LLM application standards (the trust-tier framing that motivates why the credential MUST NOT enter any tier of the prompt; lives in `patterns/llm-app.md`)
- #661 -- baseline security standards (`coding/security.md` `## Secrets Management` and `## Agent-Specific Threats` -- the universal rules this pattern operationalises for agent surfaces)
- `coding/security.md` -- baseline security standards (Secrets Management, Agent-Specific Threats)
- `patterns/llm-app.md` -- LLM application standards (Trust tiers, Tool / function calling)
- `patterns/multi-agent.md` -- multi-agent identity separation pattern
- Flue SDK `defineCommand` (`https://github.com/withastro/flue`) -- canonical worked example of CLI-side invocation-layer binding
