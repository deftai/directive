# The Directive launcher

`@deftai/directive` is a small **global launcher**. It finds the project, reads the exact `@deftai/directive-runtime` pin, and either runs an installation-management bookend (`install` / `upgrade` / `uninstall` / `doctor`) or hands ordinary commands to the pinned runtime in `node_modules`.

## Who installs it

Install once per machine:

```bash
npm i -g @deftai/directive
# or: pnpm add -g @deftai/directive
```

npm puts the `directive` / `deft` binaries on the global npm prefix `bin` directory. pnpm uses `PNPM_HOME` (run `pnpm setup` if that directory is not on your `PATH`).

## What it does on each run

1. Checks Node (≥20 required; tested on 22 and 24).
2. Discovers the project root (Git toplevel, or `--root`).
3. Reads the exact runtime pin and installed package metadata (Contract 1).
4. For `install` / `upgrade` / `uninstall` / `doctor`: runs the launcher bookend (plan → one approval → PM change → verify → runtime middle when needed).
5. For ordinary product commands: spawns the verified pinned runtime. No launcher allowlist of product verbs.

Aliases (accepted, undocumented in primary help rows): `init`→`install`, `update`→`upgrade`, `remove`→`uninstall`.

## Without the launcher

Committed skill pointers and host hooks resolve under `node_modules/@deftai/directive-runtime/` after a project package install. The `directive` command by name is unavailable until the global launcher is installed. Standard recovery:

```bash
npm i -g @deftai/directive
directive install --repair
```

## Maintainer dogfood (this repository)

On the Directive monorepo, ordinary unprefixed `task <verb>` paths and Git hooks both execute the **checkout pin** at `node_modules/@deftai/directive-runtime/dist/bin.js` (#5805 / AC9.9). Fast-forwarding `master` alone does not run tip source. Tip without a public publish:

```bash
task materialize:runtime
```

That stages and packs tip via `packages/runtime/scripts/stage-bundle.mjs` + `pack-staged-runtime.mjs`, then replaces **this checkout's** pin only (no `package.json` / lockfile location-spec rewrite; primary materialize does not update dest worktree pins). CI tip probes that call `packages/runtime/dist/bin.js` directly stay carved out.

## Related

- [Known limitations](./known-limitations.md)
- [Getting started](./getting-started.md)
- [UPGRADING](../UPGRADING.md)
