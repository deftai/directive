# The Directive Lifecycle (Conceptual Overview)

A single-picture mental model of how Deft Directive turns an idea into shipped,
auditable work — and keeps doing so as the project grows. It is **not** a one-and-done
pipeline; it is two connected phases that loop.

> **See also**: [getting-started.md](./getting-started.md) | [commands.md](../commands.md) | [strategies/README.md](../strategies/README.md) | [CONCEPTS.md](../../docs/CONCEPTS.md) | [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
>
> The `CONCEPTS.md` / `ARCHITECTURE.md` links resolve in the framework source repo; in an installed `.deft/core/docs/` they are maintainer-side references that may not be present.

![Deft Directive lifecycle: an inception phase (Concept → Strategy Analysis → Specification + Artifacts) feeding a recurring per-session phase (Session Start → Triage/Refine → Slice → Swarm → Review/Fix → Ship) that loops back through new issues and features](./assets/directive-lifecycle-diagram.png)

> This diagram is a **conceptual overview**, not a command reference. The bubble labels are
> plain-language stages; the [stage → real surface](#stage--real-surface) table below maps
> each one to the actual strategy, skill, or `task` command that implements it.

## The two phases

### 1. At inception (run once, re-run as needed)

A project starts with a **Concept**. That concept passes through **Strategy Analysis** — an
iterative loop of *looking* at the terrain and *deep thinking* about the approach — until it
produces a **Specification + Artifacts** (the project definition and the first proposed scope
xBRIEFs).

Strategy analysis is deliberately a loop, not a step: you can map, then probe, then discuss,
then map again before the spec stabilizes. It is also re-entered later "as needed" when a piece
of work turns out to be big or fuzzy enough to need rethinking rather than just refining.

### 2. Resume (the usual entry, every session)

Once a specification exists, the everyday on-ramp is **Session Start** — the session-start
ritual answering "what's next?". From there work flows through the queue:

- **Triage + Refine/Rethink** — the queue of candidate work. New **issues** and **features**
  both enter here. Each item is either sliced forward, or — when it needs more thought —
  escalated back up to Strategy Analysis (the *rethink* path).
- **Slice** — break refined scope into independently-grabbable vertical slices.
- **Swarm** — dispatch parallel agents against the sliced stories.
- **Review/Fix** — a tight, skill-driven loop that resolves reviewer findings until the work is
  merge-ready. Review comes **after** the swarm, not before.
- **Ship** — merge and release.

Shipping is not the end: it **surfaces new issues and features**, which flow back into the
Triage queue. The specification and artifacts produced at inception also feed proposed scopes
into the same queue. Every pass is iterative.

## Stage → real surface

The diagram's labels are conceptual. Here is what each one actually corresponds to in the
framework:

| Diagram label | What it really is |
|---|---|
| **Concept** | The initial idea / project framing — entry into [`deft-directive-setup`](../skills/deft-directive-setup/SKILL.md) or a `/deft:change`. |
| **Look** | Mapping and exploring the terrain — [`strategies/map.md`](../strategies/map.md) (`/deft:run:map`), codebase structure. |
| **Deep Think** | Adversarial / alignment analysis — [`strategies/probe.md`](../strategies/probe.md), [`strategies/discuss.md`](../strategies/discuss.md), [`strategies/research.md`](../strategies/research.md), and `deft-directive-gh-arch`. |
| **Strategy Analysis** | The preparatory strategies cycling through the [strategy chaining gate](../strategies/README.md) before spec generation. |
| **Spec / Specification + Artifacts** | Output of the spec-generating strategies (interview, speckit, …): `xbrief/PROJECT-DEFINITION.xbrief.json` plus dated `xbrief/proposed/` scope xBRIEFs. |
| **Resume / Session Start** | The session-start ritual — `task session:start` and the `task triage:welcome` "what's next" one-liner. |
| **Triage + Refine/Rethink** | The triage cache and refinement loop — `task triage:*`, [`deft-directive-triage`](../skills/deft-directive-triage/SKILL.md), [`deft-directive-refinement`](../skills/deft-directive-refinement/SKILL.md). "Rethink" = escalate back to Strategy Analysis. |
| **Slice** | Vertical-slice decomposition — [`deft-directive-gh-slice`](../skills/deft-directive-gh-slice/SKILL.md) and [`deft-directive-decompose`](../skills/deft-directive-decompose/SKILL.md). |
| **Swarm** | Parallel local agent orchestration — [`deft-directive-swarm`](../skills/deft-directive-swarm/SKILL.md), `task swarm:*`. |
| **Review/Fix** | Bot-reviewer response loop — [`deft-directive-review-cycle`](../skills/deft-directive-review-cycle/SKILL.md) and [`deft-directive-pre-pr`](../skills/deft-directive-pre-pr/SKILL.md). |
| **Ship** | PR merge and release — `task pr:*` and [`deft-directive-release`](../skills/deft-directive-release/SKILL.md). |
| **Issues / Features** | GitHub issues and feature requests mirrored into `.deft-cache/` and surfaced as triage candidates. |

## Why it loops

The central claim of the picture is that Directive is **reiterative**. Strategy analysis is
front-loaded but re-entrant. Triage either slices work forward or rethinks it. Review/fix
cycles until merge-ready. And shipping generates the next round of issues and features. The
framework is built to be re-entered every session, not walked once.
