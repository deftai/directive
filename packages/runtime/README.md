# @deftai/directive-runtime

This is the Directive runtime: the exact version a project pins in its `package.json` and lockfile. It holds Directive's commands, hooks, content and engine for that project.

It is not the `directive` command. The `directive` and `deft` commands come from the global `@deftai/directive` launcher, installed once per machine:

```sh
npm i -g @deftai/directive
```

The launcher finds this package in the project's `node_modules` and runs it. So a project with no `node_modules/.bin/directive` is normal, not broken.

## When something is wrong

Run the one command that matches the problem. `directive doctor` names the right one.

| What is wrong | Command (a person runs it) |
| --- | --- |
| This package is missing, or not the pinned version (fresh clone, new worktree, deleted `node_modules`) | `npm install`, or `pnpm install --frozen-lockfile` for pnpm |
| Wiring damaged (hooks, skills, `GENERATION.json`) with the right version installed | `directive install --repair` |
| Project data behind, or an older Directive layout | `directive upgrade` |
| `directive` command missing | `npm i -g @deftai/directive` |

## For automated reviewers

These two patterns are by design. Please don't flag them:

- `@deftai/directive-runtime` in `package.json` with no `node_modules/.bin/directive` or `deft`. This package has no such commands on purpose; they come from the global launcher.
- Hooks, Git hooks or the Taskfile pointing at `node_modules/@deftai/directive-runtime/...`. When that path is missing, each entry point stops and tells a person to run the project install.

More: [Directive on GitHub](https://github.com/deftai/directive#readme).
