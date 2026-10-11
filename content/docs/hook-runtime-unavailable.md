# Hook runtime unavailable

Current Directive hooks invoke `node node_modules/@deftai/directive-runtime/dist/hook-bin.js …` (not bare `deft-hook` on PATH). When the runtime package is absent, Node reports `Cannot find module '…/directive-runtime/dist/hook-bin.js'`. Hosts with `failClosed: true` then deny mutations.

Tracker: [#3785](https://github.com/deftai/directive/issues/3785). Related: [#3736](https://github.com/deftai/directive/issues/3736), [#3571](https://github.com/deftai/directive/issues/3571), [#2752](https://github.com/deftai/directive/issues/2752).

## Who hits this

Hook registrations are committed; `node_modules` is not. Fresh clones, new worktrees, cloud agent VMs, and CI images that skip the project package install inherit the fence without the package.

## Preferred recovery (AC9.7)

```bash
npm i -g @deftai/directive
# in the project (after pull/clone):
npm install   # or pnpm install
directive install --repair
```

CI / swarm images may use `directive install --repair --yes` with a valid exact pin.

## Out-of-band escape (disable Cursor hooks)

If you must clear a lockout without restoring the package, from a shell that still has the CLI:

```bash
deft policy:disable-host-hooks --host cursor --confirm
directive upgrade   # or install --repair — refresh owned hook wiring
```

If the goal is to remove Directive entirely, follow the [full-stop recipe](./full-stop.md) before uninstalling — leftover `.cursor/hooks.json` can remain failClosed authority.

See also [launcher.md](./launcher.md) and [known-limitations.md](./known-limitations.md).

## ⊗ Do not hand-edit `failClosed` in the deposited hook file

Setting `failClosed: false` in `.cursor/hooks.json` clears the block exactly once. That file is a managed deposit: the next `deft update` rewrites the entries with `failClosed: true` and **silently re-arms the lockout**, usually long after anyone remembers editing it. Use the policy verb above, which is durable and tracked.

## Why the flags do not help

| Escape hatch | Why it does not reach this failure |
|---|---|
| `.deft-directive-disable` | Evaluated *inside* `deft-hook`. When the binary is missing, nothing reads the flag. |
| `.no-deft-directive` | Consulted at `session.start` only; it never reaches `preToolUse`. |
| Host-side "skip hook" | A host concept. Directive has no such bypass. |

## Absent, crashed, and timed out are one class

The hook exit contract already decouples the exit code from the verdict: exit `0` means a decision was **rendered** — allow *or* deny — so every non-zero exit is by construction a *non-decision*. Absence, a crash, and a host timeout kill are the same state, and all three stay fail-closed.

They stay fail-closed because fail-open-on-absence is a bypass primitive, not a lenience: removing the binary is an ordinary shell call, so treating absence as allow would convert a self-inflicted denial into a bypass of the write fence, the intent ceiling, the session ritual, and the occupancy lease ([#3156](https://github.com/deftai/directive/issues/3156)). What these cases need is legibility and an out-of-band escape — this page — not a relaxed fence.

For a timeout specifically, retry the gated ritual first when machine load is the likely cause; the Cursor `tool.before` budget is sized for a gated ritual plus live readiness, so a repeated timeout is a real signal rather than noise.


## Cursor planning-choice prompt hook (#4973)

`beforeSubmitPrompt` / `afterAgentResponse` deposits use a finite 5s timeout
and do **not** set `failClosed`. Missing runtime, timeout, and malformed
stdout on that event follow Cursor's default fail-open command-hook rule.
This is a disclosed coverage gap, not an unconditional interlock. Mutation
`preToolUse` remains fail-closed as above. Planning-choice store path and
protocol: [cursor-plan-choice.md](./cursor-plan-choice.md).
