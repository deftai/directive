# Known limitations

Accepted product decisions for the launcher + pinned-runtime install model. Documented for users; not open design questions.

| Limitation | What you will see | Why |
| --- | --- | --- |
| **Global launcher required** | `directive` is not on PATH until `npm i -g @deftai/directive` | Avoids teaching `npx`/`pnpm exec` as day-to-day identity |
| **Launcher can disappear** | After `npm rm -g` or a Node version switch, the command is gone | Ordinary global npm package |
| **One install per repository root** | No per-package pins in a monorepo | Hosts read config from the project root |
| **npm and pnpm only** | Yarn / Bun projects are refused | Two managers we can test pre-1.0 |
| **Repair does not migrate data** | Old xbrief schemas need `directive upgrade` | Data migration is deliberate |
| **PM install before hooks activate** | Fresh clone/worktree: run `pnpm install` / `npm install`, then first eligible runtime command or hook completes local wiring | Packages and readiness are per-checkout |
| **Passive skill reads are not version-gated** | Before PM sync after a pin bump, Markdown may show older installed instructions | Commands/hooks enforce identity when they execute |
| **Uninstall can be best-effort** | Missing runtime still cleans known owned artifacts; leftovers are reported | Cleanup must not require install/repair first |
| **Retired verbs are gone** | `migrate`, `bootstrap`, `sync`, `install-upgrade`, `install-uninstall`, `doctor fix` → unknown command | Dead names are not redirected |
| **`update` means `upgrade`** | `directive update` moves the pin (after plan/approval) | Courtesy alias; the prompt is the guard |
| **Node 20 is best-effort** | Warning on Node 20; gates test 22 and 24 | Broad compatibility without blocking |
| **`@deftai/directive` is the launcher** | Adding it locally does not activate a project | Pin `@deftai/directive-runtime` via `directive install` |
| **Manual package add is not activation** | Dropping a runtime into a never-configured project creates no hooks/skills | Use `directive install` / `install --repair` |
| **Do not overlap mutating install commands** | Concurrent upgrade/uninstall with automatic setup is undefined | Same-pin automatic repairs may overlap; cross-version races are not guaranteed |
| **No `--force`** | Conflicts are named and left | Destructive bypass is out of scope |

Full design catalogue: UNIFIED / PROPOSAL §A9.
