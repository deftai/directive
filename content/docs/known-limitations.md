# Known limitations

Accepted product decisions for the launcher + pinned-runtime install model. Documented for users; not open design questions. Catalogue source: UNIFIED §A9.

| Limitation | What you will see | Why |
| --- | --- | --- |
| **Global launcher required** | `directive` is not on PATH until `npm i -g @deftai/directive` | Avoids teaching `npx`/`pnpm exec` as day-to-day identity |
| **Launcher can disappear** | After `npm rm -g` or a Node version switch, the command is gone | Ordinary global npm package |
| **One install per repository root** | No per-package pins in a monorepo; no subfolder installs | Hosts read config from the project root |
| **npm and pnpm only** | Yarn / Bun projects are refused | Two managers we can test pre-1.0 |
| **Repair does not migrate data** | Old xbrief schemas need `directive upgrade`; repair/automatic setup do not create seed project-data files | Data migration is deliberate |
| **Setup completes local wiring on first eligible runtime invocation** | Fresh clone/worktree: run `pnpm install` / `npm install`, then first eligible runtime command or hook completes local wiring; package install alone does not activate Git hooks; passive skill reads do not run setup | Per-checkout readiness; plan/`--yes` cover launcher bookends only |
| **Passive skill reads are not version-gated** | Before PM sync after a pin bump, Markdown may show older installed instructions | Commands/hooks enforce identity when they execute |
| **Uninstall can be best-effort** | Missing or unfamiliar runtime still cleans known owned artifacts; leftovers are reported | Cleanup must not require install/repair/upgrade first |
| **Old global CLIs are not defended against** | A pre-split global CLI in a converted repo is stopped only by the generation check on supported lines; older ones may write stale files | Pre-1.0; answer is update the global launcher, then `directive install --repair` when the pin is valid |
| **New launcher never delegates to an old-style runtime** | Ordinary commands in supported old layouts name `directive upgrade`; the launcher contains no runtime code | Conversion is the path; engineers who update global must convert each old repo |
| **Initial historical support is the supported latest legacy** | Only the latest package.json-pinned / copied-core architecture converts in-product; older layouts may need uninstall/reinstall later | Full historical survey is follow-up and does not block initial release |
| **Retired verbs are gone** | `migrate`, `bootstrap`, `sync`, `install-upgrade`, `install-uninstall`, `doctor fix` → unknown command | Dead names are not redirected |
| **`update` means `upgrade`** | `directive update` moves the pin (after plan/approval) | Courtesy alias; the prompt is the guard |
| **Only package/readiness ignore entries change** | Ignore updates cover `node_modules` and `.deft/directive/wiring-ready.*.json`; `GENERATION.json` stays committed | Broader housekeeping stays where it is |
| **Node 20 is best-effort** | Warning on Node 20; gates test 22 and 24 | Broad compatibility without blocking |
| **`@deftai/directive` is the launcher** | Adding it locally does not activate a project; meaning changes from “the product” to “the launcher” at the split | Pin `@deftai/directive-runtime` via `directive install` |
| **FF alone is not tip dogfood** | On the maintainer monorepo, ordinary `task` and hooks stay on the checkout pin; workspace `packages/runtime/dist` is not a silent ordinary-verb fallback (#5805) | Run `task materialize:runtime` in the checkout that should dogfood tip; dest worktrees do not inherit primary materialize |
| **Hooks cannot run while their runtime package is absent** | Host may block edits until packages are restored | No fallback to another version; recover with `npm i -g @deftai/directive`, then `directive install --repair` |
| **No `--force`** | Conflicts are named and left | Destructive bypass is out of scope |
| **Three private packages are not consumable** | `directive-core`, `directive-content`, and `directive-types` are not on npm for external use | Bundled into the runtime; loose ranges were part of the bug |
| **Manual package add is not activation** | Dropping a runtime into a never-configured project creates no hooks/skills; reading Markdown does not run setup | Use `directive install` / `install --repair` (repair needs an unambiguous exact pin) |
| **Do not overlap mutating install commands** | Concurrent upgrade/uninstall with automatic setup is undefined | Same-pin automatic repairs may overlap; cross-version races are not guaranteed |
| **Edits to distributed content or wholly owned generated files are unsupported** | Legacy core is removed and package/generated content replaced even if edited | Disposable tool assets, unlike project data/settings and user-owned shared-file content |
| **Preapproval plans and dry runs are bounded** | Plans do not enumerate every target-specific migration or simulate all file changes | Target code returns actual outcomes after install/verify; unsafe scope → stop and start a new command |

## Standard recovery

```bash
npm i -g @deftai/directive
directive install --repair
```

Full design catalogue: UNIFIED / PROPOSAL §A9.
