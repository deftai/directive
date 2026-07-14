# Package-Manager Network Access (#2182)

Legend (from RFC2119): !=MUST, ~=SHOULD, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../../main.md) | [tools/taskfile.md](./taskfile.md) | [scm/github.md](../scm/github.md)

**Scope:** How Directive's own tooling (session ritual, doctor, read-only flows) treats npm/pnpm registry access as an explicit, security-sensitive, opt-in operation. Applies to Directive's own code, not to a consumer project's own build/install scripts.

## Why this exists

Directive runs against arbitrary repositories, including private monorepos with private package scopes, workspace dependencies, proxy configuration, and authenticated registries. If Directive silently invokes `npm`/`pnpm` during session startup or health checks, it may contact public or private registries, disclose package names/scopes/dependency-graph shape over the network, pick up unintended project/user registry configuration, or trip sandboxed network-approval prompts for work that never needed dependency resolution. Registry traffic itself is sensitive even when no secrets are printed.

## Rules

- ! Read-only, session-start, and session-ritual flows (`deft session:start`, `deft verify:session-ritual`, `deft verify:tools`) MUST perform no npm/pnpm registry access. Tool-presence probes MUST use PATH lookups (`which`/`accessSync`) or `--version` checks, never a subcommand that can resolve dependencies or query a registry.
- ! `deft doctor` MUST default to an OFFLINE tier: no check in the default run may contact an npm/pnpm registry. The one check that can (`payload-staleness`, which uses `git ls-remote` to verify the installed pin and `npm view <package> version` to compare a release-tag install with the latest stable package) is gated behind the explicit `--network` flag and is skipped by default with a pointer to that flag.
- ! Before a network-gated check runs, `deft doctor --network` MUST print a disclosure line naming the tool and registry class it may contact (for example, "may contact your git remote and the npm registry") BEFORE any network call is attempted.
- ! Any future doctor check, session step, or read-only command that needs to invoke `npm`/`pnpm` in a way that can reach a registry MUST follow the same pattern: explicit flag or subcommand, disclosed registry class before the call, and offline by default.
- ~ Where a package-manager operation is unavoidable in an explicitly-invoked flow (e.g. a release or install workflow that legitimately needs to fetch packages), prefer offline/frozen modes (`--offline`, `--prefer-offline`, `--frozen-lockfile`) when the operation only needs to validate local state rather than resolve fresh metadata.
- ⊗ MUST NOT invoke `npm`/`pnpm` subcommands that can contact a registry from any code path reachable by `session:start`, `verify:session-ritual`, `verify:tools`, or the default `deft doctor` invocation.
- ⊗ MUST NOT ship a new registry-reaching check without adding it to this doc and gating it the same way.

## Non-goals

This does not ban dependency installation or registry verification from explicit build/check/release workflows (e.g. `task build`, CI install steps) -- those are intentionally invoked and their network use is expected. It does not require supporting every private registry provider, and it does not replace npm/pnpm lockfile or provenance checks where they are intentionally invoked.

## Reference implementation

`packages/core/src/doctor/payload-staleness.ts` is the only code path in the TS engine that shells out to `npm` (`npm view`) or performs a git-remote network call for framework-currency checks; `packages/core/src/doctor/main.ts` gates it behind `--network` and prints the disclosure line first. `packages/core/src/session/session-start.ts` and `packages/core/src/verify-env/verify-tools.ts` perform no package-manager network access at all -- tool presence is resolved via PATH probing only.
