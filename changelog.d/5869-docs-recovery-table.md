section: Changed
- Docs and recovery messages now name one command per problem: the project install (`npm install` / `pnpm install --frozen-lockfile`) when the runtime is missing or not the pinned version, `directive install --repair` for damaged wiring, `directive upgrade` for old data or layouts. Printed `deft update` advice is gone (#5977).
- Managed `AGENTS.md`: the pin is not the launcher, and a new "Directive hook can't run" card tells agents to warn the operator once and never install anything themselves (#5869, #3785).
- `directive doctor` no longer suggests the retired `directive bootstrap` on a project with no scope yet (#5867).
- README rewritten for first-time readers, with a Windows note (#5867, #4662). The runtime package has a README and a clearer npm description; both packages point their homepage at the GitHub README instead of the dead docs site (#5869, #4750).
- Known limitations and the hook-runtime page describe the current `.mjs` hook files, what each host does when a hook can't start, and the Codex/Grok subfolder limit (#5809, #5959).
