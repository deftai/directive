# Hook runtime unavailable: `deft-hook` is not on PATH

Host behavior when `deft-hook` cannot run is **not universal**. Cursor and Grok deny; Claude and Codex silently lose the gate.

tracker: [#3785](https://github.com/deftai/directive/issues/3785), [#5656](https://github.com/deftai/directive/issues/5656). Related: [#3736](https://github.com/deftai/directive/issues/3736) (timeout), [#3571](https://github.com/deftai/directive/issues/3571) (unused-host recovery), [#2752](https://github.com/deftai/directive/issues/2752) (per-host toggles).

## Per-host authority (#5656)

| Host | Missing / non-decision `deft-hook` | Mechanism |
| --- | --- | --- |
| Cursor | Deny (opaque non-zero, often **127**) | Schema `failClosed: true` on `preToolUse` |
| Grok | Deny when the deposited wrapper starts | `.grok/hooks/deft-pretooluse-wrapper.sh` emits `{"decision":"deny",...}` for missing/non-executable/crash/malformed `deft-hook`. Empty stdout + exit 0 stays Grok allow wire. **Residual:** wrapper-never-starts (missing `sh` / host timeout with no decision) is host-contract, not closed by Directive. |
| Claude / Codex | **Silent gate loss** — tools proceed | Nested deposits have no failClosed and no outer wrapper. Travel warning + `.deft/hook-gate-off.json` name this. |

⊗ Do not read Cursor-only fail-closed prose as host-universal. ⊗ Do not treat #3785 opaque 127 as permission to edit on Grok — when the wrapper starts, missing runtime is a deny.

When story-start (`scope:promote` / `scope:activate` / `xbrief:preflight`) is only prose+CLI because the hook never starts, that is the hook-absent case: closed for Grok by the outer deny + durable gate-off record + this naming (#5656 P3→P1).

## Who hits this

The registration travels via git; the runtime does not. `.cursor/hooks.json` / `.grok/hooks/deft.json` are trackable by design and the `.deft/core/` deposit is born-ignored, so any environment that gets the repo without a Node install of the CLI inherits the fence without the implementation:

- cloud agent VMs whose image has no Node and no global install
- CI runners and containers that never run `npm i -g @deftai/directive`
- a fresh clone on a new workstation

## Recovery is out of band

There is no in-session escape on a host without Node. Run this from a shell where Node and the CLI **are** available — your workstation, or the repo before you push it:

```bash
deft policy:disable-host-hooks --host cursor --confirm
deft policy:disable-host-hooks --host grok --confirm
```

That sets `plan.policy.hostHooks.<host> = false` in `xbrief/PROJECT-DEFINITION.xbrief.json`, and the next `deft update` strips the Cursor registration and the Grok wrapper deposit. Commit and push; the locked-out environment clears on its next pull or fresh clone.

If the goal is to remove Directive, do not uninstall first. Leftover Cursor `failClosed` and Grok wrapper registrations are live deny authority after the CLI is gone. Follow the [full-stop recipe](./full-stop.md).

⚠ Capability cost: disabling `hostHooks` for a host removes `deft-hook` pre-execution guardrails for anyone who later opens this repo in that host. The change is tracked and recorded to `meta/policy-changes.log`. Inspect with `deft policy:show --field=hostHooks`; reverse by setting the host back to `true` and running `deft update`.

## Preferred fix: make the runtime travel with the registration

If Cursor or Grok is a host you rely on, restore the runtime rather than removing the fence. Either:

- commit a `package.json` dependency on `@deftai/directive` — a published version or another spec a clone can fetch, since a location spec (`file:`, `link:`, `../directive`, an absolute path) resolves only on the machine that wrote it — and run `npm install` in the image or clone, which puts `deft-hook` in `node_modules/.bin`; or
- add `npm i -g @deftai/directive` to the image build.

`deft init` and `deft update` warn when a hook registration travels with the repository — already committed, or merely untracked and not ignored, so the next `git add` carries it — while neither anchor is present. The warning names the affected file and this document. For non-fail-closed travelers it also names **silent gate loss** and writes `.deft/hook-gate-off.json`.

## ⊗ Do not hand-edit `failClosed` in the deposited hook file

Setting `failClosed: false` in `.cursor/hooks.json` clears the block exactly once. That file is a managed deposit: the next `deft update` rewrites the entries with `failClosed: true` and **silently re-arms the lockout**, usually long after anyone remembers editing it. Use the policy verb above, which is durable and tracked. Do not delete the Grok wrapper by hand for the same reason.

## Why the flags do not help

| Escape hatch | Why it does not reach this failure |
|---|---|
| `.deft-directive-disable` | Evaluated *inside* `deft-hook`. When the binary is missing, nothing reads the flag. |
| `.no-deft-directive` | Consulted at `session.start` only; it never reaches `preToolUse`. |
| Host-side "skip hook" | A host concept. Directive has no such bypass. |

## Absent, crashed, and timed out (Cursor / Grok wrapper)

The hook exit contract already decouples the exit code from the verdict: exit `0` means a decision was **rendered** — allow *or* deny — so every non-zero exit is by construction a *non-decision*. On Cursor, absence, a crash, and a host timeout kill stay fail-closed via schema. On Grok, the deposited wrapper turns missing/non-executable/crash/malformed output into an explicit deny envelope when the wrapper itself starts.

They stay fail-closed on those hosts because fail-open-on-absence is a bypass primitive, not a lenience: removing the binary is an ordinary shell call, so treating absence as allow would convert a self-inflicted denial into a bypass of the write fence, the intent ceiling, the session ritual, and the occupancy lease ([#3156](https://github.com/deftai/directive/issues/3156)). Claude/Codex do not get that guarantee today — see the table above.

For a timeout specifically, retry the gated ritual first when machine load is the likely cause; the Cursor / nested `tool.before` budget is sized for a gated ritual plus live readiness, so a repeated timeout is a real signal rather than noise.


## Cursor planning-choice prompt hook (#4973)

`beforeSubmitPrompt` / `afterAgentResponse` deposits use a finite 5s timeout
and do **not** set `failClosed`. Missing runtime, timeout, and malformed
stdout on that event follow Cursor's default fail-open command-hook rule.
This is a disclosed coverage gap, not an unconditional interlock. Mutation
`preToolUse` remains fail-closed as above. Planning-choice store path and
protocol: [cursor-plan-choice.md](./cursor-plan-choice.md).
