section: Fixed
- `directive doctor` no longer writes `xbrief/.triage-cache/doctor-state.json` (or any other file). Session start keeps its own "doctor ran recently" record in `.deft/orientation-state.json`, and a skipped run no longer extends the window. Refs #6617.
- `deft doctor --fix` no longer writes `Taskfile.yml` or the OpenClaw soft re-bind and product-command skills; doctor reports them and names `directive install --repair`. Refs #6622.
- Doctor warns when a Directive file that must be committed is hidden from git by `.git/info/exclude`, a global excludes file, a `.gitignore`, or a skip-worktree / assume-unchanged flag. Refs #6618, #6163.
- Doctor names one next command per problem: the project install (`npm install` or `pnpm install --frozen-lockfile`) when the runtime is missing or not the pinned version, `directive install --repair` for wiring, and never `npm i -g @deftai/directive, then directive install --repair`. Refs #5967.
- Doctor accepts the `node_modules/@deftai/directive-runtime/Taskfile.yml` include and no longer suggests `.deft/core/Taskfile.yml`. Refs #5967.
- `.gitignore` advice names the lines setup writes and `directive install --repair`, never `directive update --allow-dirty-no-stage`. Setup now also adds the per-checkout runtime files named in AC8.5, including the pre-PR signing secret folder. Refs #6618, #5967.
- `directive doctor --json` prints exactly one JSON document; the install-sync result is under `install_sync`. Refs #6004.
- The human report says `Install sync: …` at the top and ends with one overall line (`directive doctor: OK` or `directive doctor: problems found (see above)`). Missing hook configs and skill pointers show "not present", not "ok". Refs #5967.
- A dangling link elsewhere in `node_modules` (for example pnpm's links to optional packages) is a warning; a dangling Directive package link still fails. Refs #5967.
