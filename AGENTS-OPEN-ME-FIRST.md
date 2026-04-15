# AGENTS-OPEN-ME-FIRST

You are reading this because a user told you to. Follow these steps exactly.

## Step 1 — Who are you?

Ask the user: **"Are you (1) using deft in your project, or (2) working on deft itself?"**

- If **(2)**: Tell the user: "Read `./AGENTS.md` in this directory instead — it has contributor instructions." **Stop here.**
- If **(1)**: Continue to Step 2.

## Step 2 — Set up AGENTS.md

Check whether `../AGENTS.md` exists (one directory up — the user's project root).

**Case A — File does not exist:**
1. Read `./templates/agents-entry.md` (this directory).
2. Write that content to `../AGENTS.md`.
3. Tell the user: "✓ Created AGENTS.md at your project root."

**Case B — File exists and contains the string `deft/main.md`:**
1. Tell the user: "✓ Deft is already configured in your AGENTS.md."

**Case C — File exists but does NOT contain `deft/main.md`:**
1. Tell the user: "Your project has an AGENTS.md with existing instructions. OK to append deft entries? Your existing content won't be changed."
2. If the user approves: read `./templates/agents-entry.md` and **append** it to `../AGENTS.md` (add two blank lines before the appended content).
3. Tell the user: "✓ Appended deft entries to your AGENTS.md."

## Step 3 — Continue setup

Read and follow `../AGENTS.md`. This starts the normal first-session flow (user preferences, project definition, specification).
