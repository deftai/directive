 QUICK-START

You are reading this because a user told you to. Follow these steps exactly.

## Step 1 â€” Who are you?

Ask the user: **"Are you (1) using deft in your project, or (2) working on deft itself?"**

- If **(2)**: Tell the user: "Read `./AGENTS.md` in this directory instead â€” it has contributor instructions." **Stop here.**
- If **(1)**: Continue to Step 2.

## Step 2 â€” Set up AGENTS.md

Check whether `../AGENTS.md` exists (one directory up â€” the user's project root).

**Case A â€” File does not exist:**
1. Read `./templates/agents-entry.md` (this directory).
2. Write that content to `../AGENTS.md`.
3. Tell the user: "âœ“ Created AGENTS.md at your project root."

**Case B â€” File exists and contains the string `deft/main.md`:**
1. Tell the user: "âœ“ Deft is already configured in your AGENTS.md."

**Case C — File exists but does NOT contain `deft/main.md`:**
1. Tell the user: "Your project has an AGENTS.md with existing instructions. OK to append deft entries? Your existing content won't be changed."
2. If the user approves: read `./templates/agents-entry.md` and **append** it to `../AGENTS.md` (add two blank lines before the appended content).
3. Tell the user: "✓ Appended deft entries to your AGENTS.md."
4. If `../SPECIFICATION.md` or `../PROJECT.md` exist at the user's project root **and** neither contains the `<!-- deft:deprecated-redirect -->` sentinel, tell the user: "Your project has pre-v0.20 Deft docs. See `deft/docs/BROWNFIELD.md` for the migration path (`task migrate:vbrief`); I can run the migration when you're ready."

## Step 3 — Continue setup

Read and follow `../AGENTS.md`. This starts the normal first-session flow (user preferences, project definition, specification).

**Brownfield note:** If the user's project already has existing docs/code, point them to [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) for the brownfield adoption guide (submodule/installer options, `task migrate:vbrief` flow, pre-cutover detection, post-migration checklist).
