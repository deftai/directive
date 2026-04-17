# QUICK-START

You are reading this because a user told you to, or because a stale `AGENTS.md` (or a `skills/deft-*/SKILL.md` redirect stub) sent you here. Follow these steps exactly, in order.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Step 1 — Who are you?

Ask the user: **"Are you (1) using deft in your project, or (2) working on deft itself?"**

- If **(2)**: Tell the user: "Read `./AGENTS.md` in this directory instead — it has contributor instructions." **Stop here.**
- If **(1)**: Continue to Step 2.

## Step 2 — Detect project state

Before touching `../AGENTS.md`, inspect the user's project root to decide whether this is a fresh install, a re-run, a stale-AGENTS.md upgrade, or a pre-cutover project that needs migration.

Run these deterministic checks, in order:

### 2a. Does `../AGENTS.md` exist?

- **No:** treat as fresh install — jump to Case F ("No AGENTS.md") in Step 3.
- **Yes:** continue to 2b.

### 2b. Does `../AGENTS.md` reference any `deft/skills/` path that does not exist on disk?

Parse `../AGENTS.md` and extract every token matching `deft/skills/<name>/SKILL.md`. For each extracted path, verify the file exists under `./skills/<name>/SKILL.md` (relative to this QUICK-START.md).

- ! If any referenced path does not exist on disk, treat `../AGENTS.md` as **stale** — jump to Case G ("Stale AGENTS.md") in Step 3.
- ! If the referenced path exists but its first 200 characters contain `<!-- deft:deprecated-skill-redirect -->`, also treat as stale. These stubs exist to keep v0.19 `AGENTS.md` files working until QUICK-START can refresh them. (The 200-character window matches the same budget used in 2c and is guaranteed to cover the sentinel position in every stub this repo ships -- see `tests/content/test_deprecated_skill_redirects.py::test_stub_has_sentinel`.)
- If all referenced paths exist and none are redirect stubs, continue to 2c.

### 2c. Are there pre-v0.20 artifacts at the user's project root?

Check both of these files at `../` (the user's project root):

- `../SPECIFICATION.md` — exists and the first 200 characters do **not** contain `<!-- deft:deprecated-redirect -->`.
- `../PROJECT.md` — exists and the first 200 characters do **not** contain `<!-- deft:deprecated-redirect -->`.

- If **either** holds (real pre-v0.20 content present), treat as **pre-cutover** — jump to Case H ("Pre-cutover migration") in Step 3.
- If both contain the sentinel (or neither exists), continue to 2d.

### 2d. Partial migration?

Check whether `../vbrief/` exists. If it does, inspect for the 5 lifecycle subfolders (`proposed/`, `pending/`, `active/`, `completed/`, `cancelled/`). If `vbrief/` exists but any lifecycle subfolder is missing, treat as **partial migration** — jump to Case I ("Partial migration repair") in Step 3.

### 2e. Everything clean

If none of 2a–2d triggered, `../AGENTS.md` is current and the project is on v0.20+. Jump to Case J ("Everything clean") in Step 3.

## Step 3 — Act on detected state

Pick exactly one case from Step 2 and follow its instructions. Do not mix cases.

### Case F — No AGENTS.md (fresh install)

1. Read `./templates/agents-entry.md` (this directory).
2. Write that content to `../AGENTS.md`.
3. Tell the user: "✓ Created AGENTS.md at your project root."
4. Continue to Step 4.

### Case G — Stale AGENTS.md (v0.19 → v0.20 upgrade)

1. Read `../AGENTS.md` and identify the **Deft-managed section** — bounded by the `deft/main.md` sentinel marker.
2. If the `deft/main.md` sentinel is **absent**, treat the entire existing file as user-authored and do NOT rewrite it. Instead, read `./templates/agents-entry.md` and **append** its content to `../AGENTS.md` with two blank lines between the existing content and the appended block. This matches the idempotent append behavior documented in `setup.go::WriteAgentsMD` for brownfield projects with a pre-existing AGENTS.md.
3. If the `deft/main.md` sentinel is **present**, replace only the sentinel-bounded section with the current content of `./templates/agents-entry.md`. Preserve everything outside that region verbatim.
4. Tell the user: "✓ Refreshed Deft-managed section of AGENTS.md. Your existing additions outside that region were preserved."
5. ! Instruct the user: **"Framework updated. Start a new agent session to pick up the changes. The current session has stale context."** Do not continue past this instruction in the current session.

### Case H — Pre-cutover migration (SPECIFICATION.md / PROJECT.md without sentinel)

1. Tell the user: "Your project uses the pre-v0.20 document model. Shall I run `task migrate:vbrief` to upgrade? This replaces SPECIFICATION.md and PROJECT.md with deprecation redirect stubs and creates the `vbrief/` lifecycle folders."
2. ! Wait for explicit user approval (`yes`, `approve`, `confirmed`). ⊗ Run migration on a broad "proceed" or "go ahead".
3. On approval: run `task migrate:vbrief` from the project root. See [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) for what migration does and how it preserves existing content.
4. After migration completes, re-run Step 2 of this QUICK-START — the project state has changed. Most likely you land in Case G (AGENTS.md still references old paths) or Case J.
5. When AGENTS.md is refreshed, ! instruct the user: **"Framework updated. Start a new agent session to pick up the changes. The current session has stale context."**

### Case I — Partial migration repair

1. Tell the user: "Your project has a partial vBRIEF layout. Missing lifecycle folders: <list the absent ones>. Shall I complete the migration by running `task migrate:vbrief`? It is idempotent and safe to re-run."
2. On approval, run `task migrate:vbrief`. Re-run Step 2 afterwards.
3. If the user declines, point them at [docs/BROWNFIELD.md](./docs/BROWNFIELD.md) §Troubleshooting and stop.

### Case J — Everything clean

1. Tell the user: "✓ Deft is already configured and current in your AGENTS.md."
2. Continue to Step 4.

## Step 4 — Continue setup

Read and follow `../AGENTS.md`. This starts the normal first-session flow (user preferences, project definition, specification). If you reached Case G or completed Case H/I and rewrote AGENTS.md, you have already told the user to start a new session — do not keep going yourself.

**Brownfield pointer:** For users retrofitting Deft onto an existing project (existing code, existing docs, or pre-v0.20 Deft layout), the authoritative adoption guide is [docs/BROWNFIELD.md](./docs/BROWNFIELD.md). It covers install options, migration, post-migration checks, and troubleshooting in more depth than the Case H flow above.

**Upgrade pointer:** Users moving between framework versions should also read [UPGRADING.md](./UPGRADING.md) in the repo root for the version-by-version guide.
