# Category decision aid

**What job is Directive?** Use this page before you compare tools by stars or marketing labels.

Related research and naming (do not replace this map):

- [#1597](https://github.com/deftai/directive/issues/1597) — Superpowers vs Directive capability gap (peer deep-dive)
- [#878](https://github.com/deftai/directive/issues/878) — practices vs processes content split
- [#392](https://github.com/deftai/directive/issues/392) — Deft brand vs Directive product namespace

---

## Four-way fit table

| Need | Fit | Examples (illustrative) |
|------|-----|-------------------------|
| Run the agent in an editor or CLI | **Coding host** | Cursor, Claude Code, Codex, OpenClaw, Grok Bot, Grok Build |
| Improve methodology inside one session | **Skill pack** | Superpowers-class host plugins / skill sets |
| Shared standards + durable work state + hard gates **in this repo** | **Directive practice layer** | `@deftai/directive` (this product) |
| Multi-agent product / swarm runtime **in app code** | **Orchestrator** | LangGraph, CrewAI, AutoGen, Ruflo-class |

Pick the row that matches the job. Do not buy three products that claim the same row.

---

## What Directive is

**One sentence:** Directive is an installable practice layer for a git repository so humans and coding agents share the same rules, durable work items, and automated checks.

It deposits practice **with the code**:

1. **Standards** — versioned rules and guidance agents load on demand  
2. **Work state** — durable vBRIEF/xBRIEF lifecycle records (not chat memory alone)  
3. **Gates** — Taskfile/CI checks that fail closed before merge or release  

**Deft** is the company and on-disk footprint (`.deft/`, `@deftai/*`). **Directive** is the product you install and run. See the [README naming note](../README.md#deft--directive-naming).

---

## What Directive is not

| Not this | Why |
|----------|-----|
| A **coding host** | Hosts run the agent UI/runtime. Directive **feeds** hosts; it does not replace Cursor, Claude Code, Codex, Grok Bot, Grok Build, or similar. Grok Bot is not Grok Build. |
| Only a **skill pack** | Skill packs improve one session or one host. Directive is a **repo deposit** with lifecycle state and hard gates. |
| An app **orchestrator** | Orchestrators run multi-agent products **inside application code**. That is a different job from repo practice. |
| A substitute measured by **star count peers** | Category demand is not the same as substitute size. See [Star-count misuse](#star-count-misuse). |

---

## How the four categories relate

```text
Skill packs ──stack with──► Coding hosts ◄──practice deposit── Directive
                                      │
                                      │  different job
                                      ▼
                               Orchestrators (agent apps / in-app swarms)
```

### Skill packs stack

You can use a skill pack **and** Directive. A pack improves session methodology on a host. Directive still owns shared standards, durable work state, and gates in the repository. Closest methodology peers are complementary, not automatic replacements.

### Hosts are runtimes

Hosts are where the agent runs. Directive does not compete to be your editor or agent CLI. Install Directive in the project; keep the host you already use.

### Directive swarm skills ≠ multi-agent app orchestrators

Directive ships work-ops skills (including swarm-style allocation of GitHub/repo work). Those skills coordinate **how humans and agents ship this repository**.

They are **not** the same class as multi-agent application runtimes or host meta-harness orchestrators (LangGraph, CrewAI, AutoGen, Ruflo-class). “Swarm” in Directive docs means work-ops allocation, not “build an agent product runtime.”

---

## Star-count misuse

**Category demand ≠ substitute size.**

Large star counts on skill packs, spec kits, or orchestrators show that buyers want structure for AI coding. They do **not** mean those tools are like-for-like substitutes for a repo practice layer, or that star rank equals the same job.

When you compare tools:

1. Match **job** first (table above).  
2. Then compare depth inside that job.  
3. Do not rank a skill pack against Directive by stars alone.

This page does not claim commercial traction, seat counts, or revenue. Re-check public metrics on the date of your decision.

---

## See also

| Doc | Role |
|-----|------|
| [README.md](../README.md) | Install and product entry |
| [CONCEPTS.md](./CONCEPTS.md) | Operating concepts (vBRIEF, gates, triage) |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Technical architecture |
| [glossary.md](../content/glossary.md) | Canonical vocabulary (host, skill pack, practice layer, orchestrator) |
| [content/docs/writing-ste100.md](../content/docs/writing-ste100.md) | Controlled-English bar for product prose |
