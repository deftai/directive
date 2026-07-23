# Product signal (optional partner check-in)

Phase 1 consented product-improvement signal under epic #2603 (#2693). Defaults **off**.

## Enable (project)

```bash
task product-signal:enable -- --confirm
task policy:show -- --field=productSignal
```

Capability-cost disclosure prints before `--confirm` applies `plan.policy.productSignal.enabled=true`.

## Consent (install / user)

Consent file: `%APPDATA%\\deft\\product-signal-consent.json` (Windows) or `~/.config/deft/product-signal-consent.json` (Unix).

Schema **v2** records the normalized `owner/repo` sink you authorize (#2767). Legacy v1 consent authorizes only the baked-in default `deftai/product-signal`; a custom `plan.policy.productSignal.sinkRepo` requires re-consent after grant.

```bash
task product-signal:consent -- --grant [--project-root .]
task product-signal:consent -- --revoke
task product-signal:status
```

`task product-signal:status` shows configured sink, consented sink, and whether they match. Outbound requires **both** enable and consent, and the configured sink must match the consented destination (including dry-run).

## Submit (ops / tests)

```bash
task product-signal:submit -- --surface pulse|portrait [--dry-run] [--json] [--nps 0-10]
```

Changing `sinkRepo` after consent soft-skips with `sink-unconsented` until you re-run consent for the new destination. Destination authorization cannot be bypassed with `skipGates`.

## Sink bootstrap (maintainers)

Internal (org) inbox: `deftai/product-signal` (overridable via `plan.policy.productSignal.sinkRepo`). Not public.

```bash
task product-signal:bootstrap-sink [-- --dry-run]
```

Creates the repo if needed, sets visibility to **internal**, and bootstraps D20 labels (`surface:*`, `nps:*`, `signal:gap`). Standing threads keyed by `(installId, actorName)`.

## Skill

Agents: `deft-directive-product-signal` — triggers `product check-in`, `product pulse`, `partner feedback`, `product signal`.

## Related

- Public gap escalation: `deft-directive-feedback` / `task feedback:file` (hard confirm)
- Skill telemetry emit: #829 (optional `skillsSummary` hook only; not required for pulse)
- HTTP transport: #2697 (Phase 2)
