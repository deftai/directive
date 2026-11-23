# Hook runtime unavailable

Directive registers each agent hook as `node <host dir>/deft-hook-<sha8>.mjs --host <host> --event <event>` (AC9.1). That small committed file uses only Node built-ins. It checks, in this order (AC9.12):

1. **Kill switch.** A valid kill record `.deft/authz/kill-switch.disable` ([deft-directive-disable.md](./deft-directive-disable.md), #6740), checked with `node:fs` and `git`: the hook allows the call and loads nothing else. A bare root flag file turns nothing off; the hook prints one warning and goes on.
2. **Runtime missing.** No `node_modules/@deftai/directive-runtime/dist/hook-bin.js`: the hook blocks the tool call and names the project install.
3. **Otherwise** it runs the pinned runtime, which checks that the installed version matches the pin and then decides.

Hooks never call `deft-hook` on `PATH`, a shell `.sh` wrapper, or `hook-bin.js` directly.

Tracker: [#3785](https://github.com/deftai/directive/issues/3785), [#5656](https://github.com/deftai/directive/issues/5656), [#5869](https://github.com/deftai/directive/issues/5869). Related: [#3736](https://github.com/deftai/directive/issues/3736) (timeout), [#3571](https://github.com/deftai/directive/issues/3571) (unused-host recovery), [#2752](https://github.com/deftai/directive/issues/2752) (per-host toggles).

## What each host does

| Situation | Claude Code / Codex | Cursor | Grok |
| --- | --- | --- | --- |
| Runtime missing, or the runtime can't reach a decision | Blocks the tool call (exit 2) | Blocks (deny) | Blocks (deny) |
| Installed runtime is not the pinned version | Blocks the tool call and names the project install. The exact install command may be let through when the hook can see the command's working folder; Codex often can't, so run it in a terminal outside the agent | Same | Same |
| The hook never starts (Node missing, hook file not found, host timeout) | Carries on with a hook error; Directive never ran | Blocks (`failClosed: true`) | Host behaviour |

Events other than a tool call (session start, compaction) never block (#6201).

When the hook never starts, nothing from Directive runs, so the only signal left is the managed `AGENTS.md` text. It tells the agent to say once that Directive is not protecting the session, then continue, and never to install anything itself.

Codex and Grok run hooks from the agent's current folder, and the registered path is relative to the project root. If the agent works in a subfolder, Node can't find the hook file and the hook never starts. Start the session at the project root and keep it there. See [known-limitations.md](./known-limitations.md).

## Who hits this

Hook registrations are committed; `node_modules` is not. Anything that skips the project install inherits the hooks without the runtime:

- a fresh clone or new worktree before `npm install` / `pnpm install --frozen-lockfile`
- cloud agent VMs whose image has no Node or never runs the project install
- CI runners and containers that never install the project packages

## Recovery

A person runs the fix in a terminal. The agent's own shell is blocked, and agents must not install anything themselves.

| What is wrong | Command |
| --- | --- |
| Runtime missing, or not the pinned version | `npm install`, or `pnpm install --frozen-lockfile` for pnpm |
| Node missing | Install Node, then the project install |
| Wiring damaged with the right runtime installed | `directive install --repair` |
| `directive` command missing | `npm i -g @deftai/directive` |

CI and swarm images may use `directive install --repair --yes` with a valid exact pin.

## Out-of-band escape (disable host hooks)

There is no in-session escape on a host without Node. Run this from a shell where Node and the CLI **are** available — your workstation, or the repo before you push it. Disable each host you use; Claude and Codex block too (#6201):

```bash
directive policy:disable-host-hooks --host cursor --confirm
directive policy:disable-host-hooks --host grok --confirm
directive policy:disable-host-hooks --host claude --confirm
directive policy:disable-host-hooks --host codex --confirm
directive install --repair   # or directive upgrade — refresh owned hook wiring
```

That sets `plan.policy.hostHooks.<host> = false` in `xbrief/PROJECT-DEFINITION.xbrief.json`, and the next repair or upgrade removes that host's registration and hook file. Commit and push; the locked-out environment clears on its next pull or fresh clone.

If the goal is to remove Directive entirely, follow the [full-stop recipe](./full-stop.md) before uninstalling — a leftover `.cursor/hooks.json` can still block, and a leftover registration on any host still runs the hook file.

⚠ Capability cost: disabling `hostHooks` for a host removes Directive's checks before each tool call for anyone who later opens this repo in that host. The change is tracked and recorded to `meta/policy-changes.log`. Inspect with `directive policy:show --field=hostHooks`; reverse by setting the host back to `true` and running `directive install --repair`.

## Preferred fix: make the runtime travel with the registration

If Cursor or Grok is a host you rely on, restore the runtime rather than removing the fence. Either:

- commit a `package.json` dependency on `@deftai/directive-runtime` (or the launcher pin that installs it) — a published version or another spec a clone can fetch, since a location spec (`file:`, `link:`, `../directive`, an absolute path) resolves only on the machine that wrote it — and run `npm install` in the image or clone, which places `node_modules/@deftai/directive-runtime/dist/hook-bin.js`; or
- make sure CI and images run the project install (`npm install`, or `pnpm install --frozen-lockfile`) so the runtime exists.

`directive install` / repair warn when a hook registration travels with the repository — already committed, or merely untracked and not ignored, so the next `git add` carries it — while neither anchor is present. The warning names the affected file and this document. For non-fail-closed travelers it also names **silent gate loss** and writes `.deft/hook-gate-off.json`.

See also [launcher.md](./launcher.md) and [known-limitations.md](./known-limitations.md).

## ⊗ Do not hand-edit `failClosed` in the deposited hook file

Setting `failClosed: false` in `.cursor/hooks.json` clears the block exactly once. That file is a managed deposit: the next repair/upgrade rewrites the entries with `failClosed: true` and **silently re-arms the lockout**, usually long after anyone remembers editing it. Use the policy verb above, which is durable and tracked. Do not delete hook files by hand for the same reason.

## What the flags do here

| Escape hatch | Effect on this failure |
|---|---|
| Kill record (`deft kill-switch:on --confirm`) | The hook file checks it first, so a valid record lets calls through even while the runtime is missing. A bare `.deft-directive-disable` flag does nothing. It can't help when the hook never starts. |
| `.no-deft-directive` | Consulted at `session.start` only; it never reaches `preToolUse`. |
| Host-side "skip hook" | A host concept. Directive has no such bypass. |

## Absent, crashed, and timed out

When the hook file runs, a missing runtime or a crash becomes a block in the host's own form (exit 2 on Claude Code and Codex, a deny on Cursor and Grok). Malformed output is checked only for Grok, where it becomes a deny; on the other hosts a successful runtime's output is passed through, and the host decides what malformed output means. When the hook file never starts, the host decides: Cursor blocks through `failClosed: true`; Claude Code and Codex carry on.

Directive blocks rather than allows on a missing runtime because fail-open-on-absence is a bypass primitive, not a lenience: removing `node_modules/@deftai/directive-runtime` is an ordinary filesystem operation, so treating absence as allow would convert a self-inflicted denial into a bypass of the write fence, the intent ceiling, the session ritual, and the occupancy lease ([#3156](https://github.com/deftai/directive/issues/3156)). A hook that never starts is outside that guarantee on Claude Code and Codex — see the table above.

For a timeout specifically, retry the gated ritual first when machine load is the likely cause; the Cursor / nested `tool.before` budget is sized for a gated ritual plus live readiness, so a repeated timeout is a real signal rather than noise.


## Cursor planning-choice prompt hook (#4973)

`beforeSubmitPrompt` / `afterAgentResponse` deposits use a finite 5s timeout
and do **not** set `failClosed`. Missing runtime, timeout, and malformed
stdout on that event follow Cursor's default fail-open command-hook rule.
This is a disclosed coverage gap, not an unconditional interlock. Mutation
`preToolUse` remains fail-closed as above. Planning-choice store path and
protocol: [cursor-plan-choice.md](./cursor-plan-choice.md).
