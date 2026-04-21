---
name: deft-article-review
description: >
  Evaluate an article, paper, or post for lessons that could improve directive.
  Analyzes two axes: how concepts improve directive's own implementation, and how
  they improve the projects directive creates. Produces filtered suggestions,
  iterates with the user, and optionally creates GitHub issues on the directive
  repo. Use when evaluating an article, paper, post, or URL for directive
  improvements, or when the user says "analyze this article", "evaluate this
  article", or "what can we learn from this for directive".
triggers:
  - evaluate article
  - analyze article
  - review article for directive
  - extract lessons
  - what can we learn from this
  - article for directive
metadata:
  clawdbot:
    requires:
      bins: ["gh"]
---

# Deft Article Review

Evaluate an article, paper, or blog post for lessons that could improve directive —
both how directive itself is implemented and what directive helps create.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## When to Use

- User shares a URL, local file path, or pasted text to analyze for directive improvements
- User says "what can we learn from this for directive" or "evaluate this article"
- After reading a research paper, practitioner post, or technical write-up that seems relevant

## Prerequisites

- ! If a URL is provided, fetch and read the full content before beginning analysis
- ! If a local file path is provided, read the file
- ! If pasted text, work from the provided content
- ⊗ Begin analysis before reading the full content

---

## Process

### Step 1: Ingest the article

- ! Read the full content — do not skim or skip sections
- ~ Note the source type (research paper, practitioner blog, product docs, etc.) as it affects how much weight to give conclusions

### Step 2: Evaluate Axis 1 — How can this improve directive's own implementation?

Look for lessons applicable to how directive itself is built, structured, and maintained:

- ! Skills and strategies: are there new skills, strategies, or workflow patterns directive should adopt?
- ! Framework architecture: does this suggest changes to lazy loading, vBRIEF, AGENTS.md structure, or the patterns/ directory?
- ! Agent safety and reliability: does this reveal new failure modes or defenses directive should encode?
- ! Tooling: does this suggest new tasks, task patterns, or SCM conventions directive should add?
- ~ Naming, directory structure, or documentation conventions worth adopting

### Step 3: Evaluate Axis 2 — How can this improve the projects directive creates?

Look for lessons applicable to projects that directive-guided agents build:

- ! Coding standards: new rules for languages/, coding/, or patterns/ that would improve project quality
- ! Security: new vulnerabilities or defenses projects should implement (e.g., agent trap defenses, LLM application security)
- ! Architecture patterns: new patterns/ content for multi-agent, LLM apps, safety-critical, or other system types
- ! Testing, observability, or deployment practices worth encoding as directive standards
- ~ Stack recommendations or technology choices with clear rationale

### Step 4: Filter and prioritize

- ! Discard ideas that are not genuinely actionable or relevant — not everything in an article applies to directive
- ! Rate each suggestion: **High** (actionable now, clear value), **Medium** (worth considering, needs evaluation), **Low/Speculative** (interesting but hypothetical)
- ! Note which existing directive files or issues each suggestion would affect
- ⊗ Present every idea uncritically — only surface ideas with real directive relevance

### Step 5: Present suggestions to the user

Present a structured summary organized by axis. For each suggestion:
- Brief description of the idea
- Why it's relevant to directive specifically
- Which file(s) or directory it would affect
- Confidence rating (High / Medium / Low)

! After presenting, explicitly ask:
> "Does any of this resonate? Do you want to modify, combine, or drop any of these before we decide what to file?"

Allow the user to comment, change framing, merge suggestions, or remove any. Iterate until the user is satisfied with the set.

### Step 6: Offer issue creation

! Ask the user:
> "Should I create GitHub issues for any of these? I can create one per suggestion or group related ones."

- ! If yes: create issues on `deftai/directive` using `gh issue create` with:
  - A clear title following conventional commit style (`feat(area):`, `refactor(area):`, `research(area):`, etc.)
  - Body that describes the suggestion, the source article, and the specific directive files affected
  - A note if the suggestion is speculative/research-grade vs. immediately actionable
- ! After creating issues, print the issue URLs
- ⊗ Create issues without explicit user confirmation

### Step 7: Offer further exploration

! After completing the above, ask:
> "Is there anything else from this article worth exploring — related tools, referenced papers, or follow-on questions?"

If yes, follow the thread. This may include fetching related URLs, evaluating referenced work, or researching specific concepts mentioned in the article.

---

## Anti-Patterns

- ⊗ Treating every idea in the article as directive-relevant — filter aggressively
- ⊗ Creating issues before the user approves the suggestion set
- ⊗ Skipping the user feedback step and going straight to issue creation
- ⊗ Summarizing without reading the full content
- ⊗ Presenting unrated suggestions — every suggestion needs a confidence level
- ⊗ Filing a single giant issue for all suggestions — one issue per distinct suggestion or related group
