# Contract: Functional agent-hook readiness (#3100)

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Purpose

Mutation readiness must not report green when an enabled agent-host hook is missing, drifted, unavailable, or non-functional. This gate is deterministic and independent of doctor severity and doctor throttling.

The canonical command is:

```bash
deft verify:hooks-installed --scope=agent --live
```

Default `verify:hooks-installed` scope remains `git`; callers must explicitly select `agent` or `all` before using `--live`.

## Four distinct states

Readiness reports these dimensions separately for each host:

1. **registration** — the enabled managed hook entry exists and matches the deposited contract;
2. **command functionality** — allow and deny fixtures pass through the installed `deft-hook` shim and produce the host-specific decision envelope;
3. **host trust** — whether the host has authorized the project hook;
4. **interception coverage** — whether the host actually invoked the hook for a real tool action.

The live probe verifies the first two dimensions. It does not simulate a host tool call, so interception remains `not-directly-verified`. Codex project-hook trust cannot be read by Directive and is reported as `manual-review-required`; operators open `/hooks` and approve the exact project commands. Neither state is described as active or trusted merely because the registration and shim work.

## Gate behavior

- ! Structural inspection runs first. A missing or drifted enabled registration fails before any subprocess probe.
- ! On structural green, the installed `deft-hook` shim is invoked directly for allow and deny fixtures. Resolving and running the full `deft` CLI is not a fallback.
- ! The host-specific codecs for Claude, Grok, Cursor, and Codex are checked. Missing command, timeout, empty or invalid JSON where a decision is required, and wrong allow/deny envelopes fail closed.
- ! Exit `0` means all enabled hosts are structurally registered and functionally green (or every host is intentionally disabled). Exit `1` means drift/non-functional output. Exit `2` means the installed shim is unavailable or configuration cannot be evaluated.
- ! A maintainer source checkout skips this consumer-only gate; missing consumer deposits in the Directive framework repository are not failures.
- ⊗ Treat Codex `manual-review-required` as a default hard failure. Trust remains a distinct operator-review state in v1.

## Per-host opt-out

The typed opt-out is `deft policy:disable-host-hooks -- --host <host> --confirm`. It prints a capability-cost disclosure: opted-out hosts lose `deft-hook` pre-execution guardrails, and the result is tracked. Inspect current state with:

```bash
deft policy:show --field=hostHooks
```

Only enabled hosts can fail readiness. An opted-out host reports `registration=disabled`, `functionality=disabled`, `trust=disabled`, and `interception=disabled`; it is not probed and repair output must not tell the operator to reinstall that host. When a failed enabled host is unused, recovery copy names the confirm-gated disable verb and the guardrail cost — not ungated hand-edit. Hand-edit of `plan.policy.hostHooks` plus `deft update` still strips (human high-trust bypass). Timeout is not unused-host opt-out.

This policy is independent of `.githooks/` and `hostSlashCommands`.

## Mutation-path wiring

- `directive init` and `deft update` run and report readiness after depositing hooks. A readiness failure returns non-zero without rolling back the completed deposit; JSON reports `deposit_completed: true` separately from `success` and `agent_hook_readiness.ready`.
- `deft verify:session-ritual -- --tier=gated` owns a non-deferrable `agent_hooks` step that invokes the canonical live command. It does not route through doctor.
- `deft session:ready` forces that gated hook check once even when cached gated state looked fresh, so later registration drift cannot be hidden by the fast path.
- Cold `deft session:start` does not run the live probe. It remains the quick-tier ceremony and does not record an `agent_hooks` success.

## Probe budget

Each host fixture has a hard timeout of **1.5 seconds**, **one retry** after a timeout, and each host stops after its first failed fixture. With four enabled hosts, two fixtures, and one retry, the absolute timeout ceiling is **24 seconds** (still under Cursor `tool.before` 30 seconds). A `timed-out` case is not mapped as non-functional and must not recommend reinstall or hostHooks disable. Healthy local shims are expected to finish well below that ceiling. The gate does not inherit doctor's 4-hour or 24-hour throttle.

## Implementation anchors

- Coordinator: `packages/core/src/verify-env/agent-hook-readiness.ts`
- Live probe and codecs: `packages/core/src/verify-env/agent-hooks-live-probe.ts`
- CLI: `packages/cli/src/verify-hooks-installed.ts`
- Mutation ritual: `packages/core/src/session/verify-session-ritual.ts`
- One-shot readiness: `packages/core/src/session/session-ready.ts`
- Post-deposit reporting: `packages/core/src/init-deposit/init-deposit.ts`, `packages/core/src/init-deposit/refresh.ts`
