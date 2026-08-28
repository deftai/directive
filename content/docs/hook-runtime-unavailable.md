# Hook runtime unavailable: `deft-hook` is not on PATH

On a host that cannot execute `deft-hook`, the Cursor `preToolUse` registration is `failClosed: true`, so **every mutation is denied** — and because the binary never runs, no Directive code is left to say why. The visible symptom is an opaque non-zero exit, typically **127** (command not found).

Tracker: [#3785](https://github.com/deftai/directive/issues/3785). Related: [#3736](https://github.com/deftai/directive/issues/3736) (timeout), [#3571](https://github.com/deftai/directive/issues/3571) (unused-host recovery), [#2752](https://github.com/deftai/directive/issues/2752) (per-host toggles).

## Who hits this

The registration travels via git; the runtime does not. `.cursor/hooks.json` is trackable by design and the `.deft/core/` deposit is born-ignored, so any environment that gets the repo without a Node install of the CLI inherits the fence without the implementation:

- cloud agent VMs whose image has no Node and no global install
- CI runners and containers that never run `npm i -g @deftai/directive`
- a fresh clone on a new workstation

## Recovery is out of band

There is no in-session escape. Run this from a shell where Node and the CLI **are** available — your workstation, or the repo before you push it:

```bash
deft policy:disable-host-hooks --host cursor --confirm
```

That sets `plan.policy.hostHooks.cursor = false` in `xbrief/PROJECT-DEFINITION.xbrief.json`, and the next `deft update` strips the Cursor registration. Commit and push; the locked-out environment clears on its next pull or fresh clone.

⚠ Capability cost: disabling `hostHooks` for a host removes `deft-hook` pre-execution guardrails for anyone who later opens this repo in that host. The change is tracked and recorded to `meta/policy-changes.log`. Inspect with `deft policy:show --field=hostHooks`; reverse by setting the host back to `true` and running `deft update`.

## Preferred fix: make the runtime travel with the registration

If Cursor is a host you rely on, restore the runtime rather than removing the fence. Either:

- commit a `package.json` dependency on `@deftai/directive` and run `npm install` in the image or clone, which puts `deft-hook` in `node_modules/.bin`; or
- add `npm i -g @deftai/directive` to the image build.

`deft init` and `deft update` warn when a hook registration is git-tracked and neither anchor is present, naming the affected file and this document.

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
