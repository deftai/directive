# Getting Started with Deft Directive

Deft Directive is a Taskfile-first framework for AI-assisted software work. It combines agent guidance, deterministic gates, xBRIEF lifecycle metadata, installer/doctor handoff, and cache-backed backlog workflows. This guide walks through installation, preferences, project setup, and the first scope workflow.

> **Note**: This guide is an orientation layer. For a single-picture mental model of how Directive turns an idea into shipped work, see [the Directive lifecycle](./directive-lifecycle.md); for command behavior, see [commands.md](../commands.md); for current architecture details, see [ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## The shape of the workflow

Before the mechanics below, it helps to see the whole loop. Directive is two connected phases that repeat: an **inception** phase (Concept → Strategy Analysis → Specification + Artifacts) that feeds a recurring **per-session** phase (Session Start → Triage/Refine → Slice → Swarm → Review/Fix → Ship), where shipping surfaces new issues and features that flow back into the queue. The full picture, with a stage-to-real-command mapping table, lives in [the Directive lifecycle overview](./directive-lifecycle.md).

## Deft & Directive (naming)

**Deft is the company; Directive is the product.** *Deft* names the organization and the on-disk footprint (`.deft/`, `@deftai/*` npm scope, user config under `~/.config/deft/`). *Directive* names the framework you install and run: the npm package is `@deftai/directive`, and the primary CLI is `directive` (`deft` is an alias). Legacy `deft-install` / `deft` paths in this guide refer to the same product during the staged transition ([#423](https://github.com/deftai/directive/issues/423)).

---

## Prerequisites

- **Node 20+** and **pnpm** for live gates and the npm distribution channel (see `.nvmrc` in the framework payload).
- **Go 1.22+** only if you use the bootstrap Go installer or build from source.
- **Python 3.11+**, **uv**, **task**, **git**, and **gh** for full framework workflows — run `directive toolchain:check` (or `deft toolchain:check`) after install.

---

## Installation

### npm (coming soon — not yet published)

> ⚠️ **The `@deftai/directive` npm package is not yet published** to the registry (provisioning tracked by [#1909](https://github.com/deftai/directive/issues/1909)). **Until it goes live, install via the [Go installer](#go-installer-bootstrap) below.** The commands shown here are what the install will become once the package is published.

<!-- TODO(#1909): flip to npm-canonical and remove this "coming soon" notice when @deftai/directive is published -->

Once published, when Node is already available you will install Directive globally:

```bash
npm i -g @deftai/directive
directive --version    # primary command
deft --version         # alias — same binary
```

One-shot without a global install (also once published):

```bash
npx @deftai/directive doctor
npx @deftai/directive session:start
```

This npm path is the emerging primary distribution channel under `@deftai/directive` ([#11](https://github.com/deftai/directive/issues/11)); the Go installer below remains the install/bootstrap option today and during the staged retire window.

### Go installer (bootstrap)

Download a platform installer from the [Directive release page](https://github.com/deftai/directive/releases) and run it from the project you want to adopt:

```bash
deft-install --yes --repo-root . --json
```

For existing consumer projects, the headless upgrade path is:

```bash
deft-install --yes --upgrade --repo-root . --json
```

Those consumer flows intentionally project Deft-managed files into your project
root (`AGENTS.md`, skills pointers, gitignore entries, xbrief scaffolding, and
related guard configuration). Framework maintainers working inside a
`deftai/directive` checkout should instead follow
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) and use `--maintainer`; maintainer setup
checks tools without rewriting consumer-managed files.

---

## First Project

<!-- TODO: Walk through deft-setup phases: USER.md, PROJECT.md, SPECIFICATION.md -->

---

## Working an existing backlog

If you are adopting Deft on a project that already has an issue tracker (existing repo, brownfield migration, an upstream bug list that has been accumulating), you do not have to start from an empty `xbrief/proposed/`. The refinement skill's **Phase 0 triage workflow** lets you walk an existing backlog locally, decide what to keep, and let only the **accepted** items land in `xbrief/proposed/`. Trigger words: **"triage"**, **"work the cache"**, **"pre-ingest"**, **"action menu"**.

### Step 1 — Scoped first populate

A real-sized backlog can drain the shared GitHub GraphQL bucket if you fetch everything at once (see [#976](https://github.com/deftai/directive/issues/976) for the recurring symptom). Scope the first populate so it lands in seconds rather than minutes:

```bash
task triage:bootstrap -- --limit 50 --state open
```

Flag surface (shared by `task triage:bootstrap` and `task cache:fetch-all`):

- `--limit <N>` caps the number of issues fetched (start with `50` and widen as needed).
- `--state {open|closed|all}` selects the issue state (default `open`).
- `--batch-size <N>` caps the per-page fetch (default `10`).
- `--delay-ms <N>` inserts a sleep between batches so a populate against a large repo does not trip the rate limiter (default `500`; a `429` retries automatically using the upstream `Retry-After` header).
- `--repo OWNER/NAME` is optional; when omitted, the bootstrap infers the slug from `git remote get-url origin`.

The unbounded no-flag form remains the default for small backlogs. For real-sized repos, prefer the scoped first run; you can always re-enter triage later to widen the slice.

### Step 2 — Walk the action menu

After the cache is populated, ask your agent to triage. For each cached candidate the agent presents a numbered action menu and waits for your decision:

```
1. Accept         -- task triage:accept <issue>          (writes proposed/ xBRIEF + audit-log entry)
2. Reject         -- task triage:reject <issue>          (audit-log entry only; closes the upstream issue)
3. Defer          -- task triage:defer <issue>           (non-terminal; resurfaces on the next pass)
4. Needs-AC       -- task triage:needs-ac <issue>        (non-terminal; flags missing acceptance criteria)
5. Mark duplicate -- task triage:mark-duplicate <a> <b>  (terminal; cross-links the duplicate target)
6. Discuss
7. Back
```

Only **accepted** items become scope xBRIEFs in `xbrief/proposed/`. Rejected, deferred, and duplicate decisions are recorded in the audit log so the backlog stays focused. Bulk verbs (`task triage:bulk-accept` / `bulk-reject` / `bulk-defer` / `bulk-needs-ac`) handle predictable patterns (e.g. "reject every `wontfix`-labelled candidate") without walking the menu N times.

### Step 3 — Understand the three-tier model

Phase 0 reads and writes three distinct stores; they never collapse into one:

- **Cache** — `.deft-cache/github-issue/<owner>/<repo>/<N>/` is the local mirror of fetched issue bodies, labels, and state. Populated by `task cache:fetch-all`; read via `task cache:get -- github-issue OWNER/NAME/<N>`. The directory is gitignored — your local mirror is private to your machine. The cache is the **read** surface for triage so decisions are reproducible across re-runs (no live `gh issue view` per decision).
- **Audit log** — `xbrief/.eval/candidates.jsonl` is an append-only JSONL recording every candidate you have ever seen plus the action taken (`accept | reject | defer | needs-ac | mark-duplicate`) and a timestamp. Re-running triage against the same cache short-circuits items that already have a terminal entry, so deferred / Needs-AC items resurface and rejected ones do not.
- **Accepted backlog** — `xbrief/proposed/` is the standard scope-xBRIEF lifecycle folder. **Writes flow only through `task triage:accept`**, which delegates the actual xBRIEF authoring to `task issue:ingest` so slug, reference, and schema rules stay in one place. Hand-authored proposed/ xBRIEFs are still allowed; what changed is that triage no longer writes there silently.

### Step 4 — Why this avoids the GraphQL drain

The shared GitHub GraphQL bucket (5000 points/hour per identity) is the operational bottleneck under multi-agent / shared-identity workflows, not the REST `core` bucket. The triage cache is **REST-backed** (`gh api` reads, not `gh issue view --json`), and the populate uses **batched delays** plus automatic 429 retries with the upstream `Retry-After` header. There is no live `gh issue view` per accept / reject / defer decision — every decision reads from the local cache. This is why the scoped flags exist: they let you keep the populate inside the REST budget and well clear of the GraphQL bottleneck (see [#976](https://github.com/deftai/directive/issues/976) for the recurrence pattern). Refresh the cache on demand with `task cache:fetch-all` (idempotent — fresh entries are skipped) or audit drift against `xbrief/active/*.xbrief.json` with `task triage:refresh-active`.

Full command reference for every triage and cache verb lives in [`commands.md` § Backlog triage & cache tasks](../commands.md#backlog-triage--cache-tasks); the canonical agent-facing description of the workflow lives in `skills/deft-directive-refinement/SKILL.md` Phase 0.

---

## Using Strategies

<!-- TODO: Introduce strategy selection, chaining gate, and common workflows (interview, rapid, enterprise) -->

---

## Agent Configuration

<!-- TODO: Cover AGENTS.md, skill routing, Warp Drive integration, and cloud agent dispatch -->
