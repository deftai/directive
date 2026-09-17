# Full stop: reverse-init recipe

Uninstall plus delete `.deft/` is not a complete stop. Leftover host hook files still deny writes after the CLI is gone. This page is the reverse-init recipe: leftover classes, then the ordered stop while the CLI still exists.

Tracker: [#4674](https://github.com/deftai/directive/issues/4674).

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

This is not a delete-these leftover list. Completeness is the ordered strip, not a post-uninstall file count.

## Two operator goals

Keep these separate.

| Goal | Existing path | What it is not |
| --- | --- | --- |
| Stop using Directive in this project | [`.no-deft-directive`](./no-deft-directive.md) / `directive policy:disable-directive` | Not uninstall. Those docs already forbid auto-delete of the deposit. |
| Full stop (this page) | Ordered strip below, then uninstall | Not opt-out. Not the [temporary kill-switch](./deft-directive-disable.md). |

⊗ Do not fold `policy:disable-directive` into the uninstall command list. That mixes two goals.

## Leftover classes

Partition before you act. These are not one leftover list.

### 1. Live host-hook authority

`.cursor/hooks.json` is trackable `failClosed: true`. After `npm uninstall -g`, leftover Cursor hook files still deny every mutation with opaque exit 127. Other leftover host files (`.claude`, `.codex`, `.grok`) fail open after the CLI is gone. They are not the same class.

! Strip live Cursor hook authority while the CLI still exists.
! Reuse leftover-free strip: write empty host hook files (`{}`).
⊗ Do not `rm` host dirs (`.cursor/`, `.claude/`, `.codex/`, `.grok/`, `.agents/`). Leftover-free strip preserves consumer host settings.

See [hook runtime unavailable](./hook-runtime-unavailable.md).

### 2. Git hook dispatch

`task setup` / `deft setup` sets `core.hooksPath=.githooks`. After uninstall, git still dispatches `.githooks/pre-commit` and `pre-push` at a missing `deft` binary.

! Unset `core.hooksPath` while the CLI still exists.

### 3. Local-only caches beside `.deft`

`.deft-cache/` sits **beside** `.deft`, not inside it. Delete-`.deft` misses it. README already names `.deft-cache/` as a gitignored local-only artifact beside `.deft/core/` and `.deft/.cli/`. The gap is this recipe, not an unknown path.

Optional delete **after** the CLI is gone:

- `.deft-cache/`
- `.deft-run-summary.json`
- ignored `.deft` sidecars (ritual-state, local scratch)

### 4. Tracked practice-layer (not leftovers)

These stay. They are committed project files, not npm-package residue.

- `xbrief/` — next-build tree
- `package.json` — reconstitution pin
- `AGENTS.md`, `Taskfile.yml`, `.github/`, `ROADMAP.md`, and similar practice-layer files
- Host skill dirs that init deposited as tracked files

Reverse-init of tracked deposits is a separate explicit destructive operation. Uninstall does not imply it.

### 5. Cross-project identity (not a leftover)

`%APPDATA%\deft\USER.md` on win32 is personal identity across projects. Keep it off this recipe.

## Ordered stop (CLI still installed)

Run these in order. Do not uninstall first.

1. Strip Cursor failClosed hooks (disable, then leftover-free write):

```bash
directive policy:disable-host-hooks --host cursor --confirm
directive update
```

`disable-host-hooks` persists `plan.policy.hostHooks.cursor=false`. It does not write host files. The next `directive update` writes leftover-free `{}` for opted-out Directive-only deposits. That empty-file write is the strip.

? You may repeat disable for `claude`, `codex`, and `grok` for hygiene. Cursor is the failClosed host this recipe must strip.

2. Unset git hook dispatch (thin reverse of `task setup`):

```bash
git config --unset core.hooksPath
```

If `core.hooksPath` is already unset, git exits non-zero. That is already stopped.

3. Uninstall the CLI:

```bash
npm uninstall -g @deftai/directive
```

pnpm: `pnpm remove -g @deftai/directive`.

## After the CLI is gone

? Delete local-only caches beside `.deft`: `.deft-cache/`, `.deft-run-summary.json`, ignored `.deft` sidecars.

The deposit `.deft/` may remain. Opt-out and kill-switch docs forbid auto-delete. An operator may delete it by hand. That is not completeness.

⊗ Do not treat a post-uninstall `dir` listing as a completeness check.
⊗ Do not add a `directive uninstall` binary that deletes host dirs, `xbrief/`, or `package.json`.

## Related

- [Opt out](./no-deft-directive.md) — stop-using; do not auto-delete the deposit
- [Hook runtime unavailable](./hook-runtime-unavailable.md) — leftover failClosed Cursor hooks
- [Temporary kill-switch](./deft-directive-disable.md) — local test flag; not uninstall
- [Support](./SUPPORT.md) — symptom index