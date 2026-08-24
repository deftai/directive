# Contract: SCM readiness in mismatched / headless envs (#2275)

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**Parent:** issue #2275 (follow-up to #2203 Decision 7). Sibling of USER.md
resolution (#2271).

## Problem

In agentic sandboxes, execution-env often differs from install-env: `gh` /
`ghx` may be absent or unauthenticated even when the host desktop is fully
set up. SCM-dependent gates then fail opaquely (spawn errors, hung auth
prompts) while framework-local gates still work.

## Gate classes

### Framework-local (no SCM required)

`session:start`, `session:ready`, `verify:session-ritual`, `verify:tools`
(orientation), `verify:branch`, `xbrief:preflight`, `doctor` (offline),
`scope:*`, local cache-fresh / ritual state.

These ! run regardless of SCM readiness.

### SCM-dependent (require binary + auth)

At minimum: `triage:queue`, `triage:welcome` network hydrate, `issue:ingest`,
`reconcile:issues`, `pr:*`, `cache:fetch-all`, `scm:*` issue ops,
`umbrella:current-shape` live fetch, deep `github-auth-modes`.

These ! either run when ready or fail loud with a named reason. They ⊗ hang
on interactive auth prompts in headless envs without a clear diagnostic.

## Probe surface

| Surface | Depth | Blocks session? |
| --- | --- | --- |
| `session:start` default | shallow (PATH + token + `gh auth status`) | no |
| `session:start --with-network` | deep (API + optional repo) | no |
| `deft scm:status` | shallow default; `--deep` opt-in (derives target repo; expected user login via flags/env) | n/a (exit 0/1/2) |
| `deft github-auth-modes` | mode + principal validation (#1557 / #3665) | n/a |

JSON field shape (`session:start --json` → `scm`, or `scm:status --json`):

- `ready` (bool)
- `binary` (`ghx` \| `gh` \| null)
- `binary_path`
- `auth_state` (`authenticated` \| `unauthenticated` \| `missing-token` \|
  `binary-absent` \| `unknown`)
- `github_auth_mode` (`host-gh` \| `injected-token`)
- `runtime_mode`
- `injected_token_present` (bool; never the value)
- `depth` (`shallow` \| `deep`)
- `detail` (one-line human diagnostic)
- `remediation` (string \| null)
- `skipped_gates` (string[])
- `login` (string \| null; deep only)
- `failure_kind` (string \| null)

## Remediation contract

When not ready, agents ! prefer one of:

1. Install + auth in the **execution** env (`gh` / `ghx`, then
   `gh auth login` for host-gh).
2. Inject `GH_TOKEN` / `GITHUB_TOKEN` / `GH_ENTERPRISE_TOKEN` for
   injected-token / cloud-headless mode.
3. Run SCM-dependent gates from a matched authenticated environment.

⊗ Put token values into prompts, dispatch envelopes, or logs.

## Implementation anchors

- Probe: `packages/core/src/scm/readiness.ts`
- CLI: `packages/core/src/scm/readiness-cli.ts` (`scm:status`)
- Session orientation: `packages/core/src/session/session-start.ts`
- Auth modes: `packages/core/src/intake/github-auth-modes.ts` (#1557)
- Operator docs: `content/scm/github.md` § Mismatched/headless SCM readiness
