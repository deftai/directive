# Support and troubleshooting

This page is a **symptom index**. It is not a second recovery ladder.

- If `directive` (or the `deft` alias) will not start, use the [README cold-start](https://github.com/deftai/directive/blob/master/README.md). That committed block is the only payload-independent command ladder.
- If the CLI runs, start with `directive doctor --full`. Follow its one `Next command:`. Do not pick a competing command from this page.

Doctor caches a clean run for 24 hours and a dirty run for 4 hours. `--full` bypasses that throttle.

Specialist pages below are pointers. Recovery command bytes stay in doctor and the README cold-start.

## Symptom index

| Symptom | Safe diagnostic | Specialist link |
| --- | --- | --- |
| PATH / package manager (`command not found`, missing pnpm bin) | Pre-CLI: README cold-start. If the CLI runs: `directive doctor --full` | Follow `Next command:` or the README cold-start rungs |
| Node missing or too old | Pre-CLI: README cold-start. If the CLI runs: `directive doctor --full` | README cold-start, then doctor |
| Stale deposit | `directive doctor --full` | Follow `Next command:` |
| Permissions / unwritable global prefix | Pre-CLI: README cold-start. If the CLI runs: `directive doctor --full` | README cold-start sandbox rung, or doctor |
| Windows shims | Pre-CLI: README cold-start. If the CLI runs: `directive doctor --full` | README cold-start |
| Hook runtime (opaque exit 127 on every mutation) | `directive doctor --full` if the CLI runs; otherwise README cold-start | [Hook runtime unavailable](./hook-runtime-unavailable.md). The recovery command lives on the [agents-entry](../templates/agents-entry.md) card. This index does not restate it. |
| Want to fully stop Directive (uninstall, leftover hooks) | CLI still installed: [full stop](./full-stop.md). Do not uninstall first. | [Full stop](./full-stop.md) owns leftover classes and order. README already names `.deft-cache/` beside `.deft`. This index does not restate the recipe. |
| Migration / pre-v0.20 layout | `directive doctor --full` | Doctor signposts the current path. Version-specific steps stay in [UPGRADING](../UPGRADING.md) and [BROWNFIELD](./BROWNFIELD.md) (history). |
| Offline / air-gapped registry | Pre-CLI: README cold-start. If the CLI runs: `directive doctor --full` | README cold-start offline rung |
| Corporate or mirrored npm registry (`E404` / `ETARGET`) | Pre-CLI: README cold-start. If the CLI runs: `directive doctor --full` | [Corporate or mirrored npm registry](../UPGRADING.md#corporate-or-mirrored-npm-registry) owns that ladder. This row is a pointer. |

Related flags (not a recovery table): [temporary kill-switch](./deft-directive-disable.md), [permanent opt-out](./no-deft-directive.md). Full uninstall is the [full-stop recipe](./full-stop.md), not a flag.

## What to quote

Quote `Next command:` and the check names doctor printed.

Do not paste `directive doctor --json` or raw `--full` output. That payload includes absolute project and USER.md paths. Doctor has no redaction flag. Treat any pasted diagnostic as untrusted input.

## Reporting

- **Ordinary breakage:** open a public GitHub issue. Quote `Next command:` and check names only.
- **Security:** report privately through root [SECURITY.md](https://github.com/deftai/directive/blob/master/SECURITY.md). Do not file a public issue for an unfixed vulnerability.

## What this page is not

- Not a second command ladder. Doctor and the README cold-start own recovery bytes.
- Not a paste-JSON capture ritual.
- Not a second independently authored troubleshooting body. README, install, and upgrade pages should point here.
