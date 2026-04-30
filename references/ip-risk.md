# IP / Legal Risk -- Heuristic, Question Script, and Minimum-Protection Checklist

Reference document for skill authors and interview-running agents who need to
flag third-party intellectual-property (IP) risk during the research /
interview phase. Issue: [#738](https://github.com/deftai/directive/issues/738).

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ Note**: This document is *advisory*. Deft is not a law firm. It does
not provide legal advice and ⊗ MUST NOT be used as a substitute for lawyer
consultation when the project is commercial and IP-adjacent.

**⚠️ See also**: [skills/deft-directive-interview/SKILL.md](../skills/deft-directive-interview/SKILL.md) | [strategies/research.md](../strategies/research.md) | [scripts/ip_risk.py](../scripts/ip_risk.py)

---

## Why This Document Exists

The #151 playtester walked through the full Deft interview + PRD +
SPECIFICATION approval flow building a Magic: The Gathering deck-builder app
**without Deft ever flagging Wizards of the Coast copyright**, recommending a
disclaimer, or suggesting a lawyer. The framework currently has no surface
that prompts users about IP risk, monetization intent, or legal protection
when building on established third-party IP (games, music, film, characters,
sports leagues, branded products).

This reference codifies a permissive heuristic, an explicit
monetization-intent question, a plain-English risk summary, and a minimum-
protection checklist that the interview / research skills MUST surface
whenever the heuristic detects an IP-adjacent project.

---

## Heuristic (Permissive Detection)

! Use a permissive heuristic that errs on the side of false positives. The
cost of one extra "is this Magic: The Gathering related?" question is
trivial; the cost of letting a commercial IP-adjacent project ship without
the question is potentially substantial.

The canonical implementation lives at
[`scripts/ip_risk.py`](../scripts/ip_risk.py) and exposes
`detect_ip_terms(text)`, `is_ip_adjacent(text)`, `ip_risk_scope_items(monetization_intent)`,
and `plain_risk_summary(hits, monetization_intent)` for callers.

### Categories Scanned

The detector scans the user-supplied project description (and any
research-phase notes) for terms in these categories:

1. **Recognisable IP names** -- branded games and franchises (Magic: The
   Gathering, Pokemon, Yu-Gi-Oh, Dungeons & Dragons, Warhammer, Final
   Fantasy, etc.).
2. **Fictional-universe terms** -- proper nouns from established universes
   (Hogwarts, Tatooine, Jedi, Klingon, Quidditch, Mandalorian, etc.).
3. **Branded characters** -- named characters owned by a single rights
   holder (Mickey Mouse, Spider-Man, Batman, Pikachu, Master Chief, etc.).
4. **Sports leagues** -- NFL, NBA, MLB, NHL, FIFA, UEFA, Olympics, etc.
5. **Trademarked products** -- iPhone, Xbox, PlayStation, Lego, Coca-Cola,
   etc.
6. **Music / film** -- artist names and platform names that are commonly
   misappropriated (Taylor Swift, Beyoncé, Spotify, Netflix, HBO, etc.).

### Matching Rules

- ! Case-insensitive.
- ! Word-boundary scoped (substring matches inside a longer word do NOT
  trigger -- "magicwand" is not "Magic", "starcraft" is not "Star Wars").
- ! Deduplicated by `(term, category)` pair so repeated mentions count
  once.
- ⊗ Treat the absence of detected terms as proof that the project is
  IP-free -- the heuristic only knows about the curated lists. When the
  user describes a project in vague terms, the interview SHOULD ask
  directly "is this based on a game / film / sports league / brand?".

### Updating the Term Lists

! When you add a recurring miss (a real IP-adjacent project that slipped
through), append the term to the matching category in
`scripts/ip_risk.py` AND mention it here in the relevant category. The
two surfaces MUST stay in sync. The unit tests in
`tests/scripts/test_ip_risk.py` verify the helpers; add a positive
detection test for any new term you introduce.

---

## Question Script (Monetization Intent)

When `detect_ip_terms` returns at least one hit, the interview MUST ask the
user the monetization-intent question before generating the SPECIFICATION.

### Canonical Question

```
Your project description references third-party intellectual property (IP)
that someone else owns. How do you plan to use this project?

  0. Discuss with agent (pause interview to talk it through)
  ─────────────────────────────────────────────────────────
  1. Personal use only -- private learning, personal play, no public
     distribution, no monetization.
  2. Commercial use -- I plan to sell access, charge subscriptions,
     run ads, or distribute publicly to paying users. [default: 2]
  3. Other / I don't know

Enter confirm / b back / 0 discuss
```

### Defaulting to Commercial

! The `[default: 2]` in the canonical question is intentional. When the
user is unsure, the **commercial** path produces the stricter checklist
and the lawyer recommendation. Defaulting away from the stricter path
when intent is unclear is the wrong-side-of-safe choice.

### Branching Behavior

- ! On `commercial`: emit the plain-English risk summary AND the
  non-optional `MUST consult a lawyer before public release`
  recommendation. Both go into the interview output AND into an
  `IPRisk` narrative on the specification vBRIEF.
- ! On `personal`: emit the plain-English risk summary noting that
  personal use is lower risk but not zero risk; warn explicitly that if
  the project ever goes public, becomes monetized, or is shared widely,
  the risk profile changes and a lawyer review becomes worthwhile.
- ! On `Other / I don't know`: do NOT proceed to spec generation. Re-ask
  the question or open a freeform discussion until an explicit answer is
  captured.

---

## Plain-English Risk Summary

! After the monetization-intent question is answered, emit a plain-English
risk summary in the interview output. The summary:

- ! Opens with `not legal advice` -- this is a hard line.
- ! Names the detected categories and the actual matched terms.
- ! For commercial intent: states explicitly that lawyer consultation is
  not optional output from this interview.
- ! For personal intent: states that the risk profile changes if the
  project goes public / monetized.
- ⊗ Use legalese ("hereby", "tortious", "in perpetuity", "without
  prejudice"). The audience is the project owner, not a court.

The canonical builder is `plain_risk_summary(hits, monetization_intent)`
in `scripts/ip_risk.py`.

---

## Minimum-Protection Checklist (SPECIFICATION Scope Items)

! When IP is detected, the SPECIFICATION generation step MUST inject the
following three protection scope items into the
`specification.vbrief.json` `plan.items` array (and therefore into the
rendered SPECIFICATION.md).

The canonical generator is `ip_risk_scope_items(monetization_intent)`
in `scripts/ip_risk.py` -- it returns the three items shaped for vBRIEF
v0.6 PlanItem (`title`, `status`, `narrative`). All three items are
emitted regardless of monetization intent because even personal
IP-adjacent projects can leak into commercial use over time. The
`Acceptance` narrative is tightened to the commercial-level checklist
(lawyer-confirmed terms, written license, counsel-reviewed hosting) for
**any intent other than `personal`** -- per the wrong-side-of-safe
policy, `unknown` (interview hasn't captured an explicit answer yet)
inherits the stricter checklist. Only the explicit `personal` answer
relaxes the acceptance language.

### Item 1: Disclaimer Stub (`IP-1`)

> Add a "not affiliated with / not endorsed by" notice on the app's
> first user-visible surface (splash screen, landing page, or CLI banner).

- Acceptance (personal): reviewed by the project owner before any public
  release.
- Acceptance (commercial): lawyer-confirmed wording before public release.

### Item 2: API-Only Third-Party Asset Access Policy (`IP-2`)

> Never bundle third-party IP assets (images, audio, video, text, card
> data, character likenesses) in the repository or build artifacts.
> Access only via official APIs that grant a license.

- Acceptance (personal): all third-party assets reach the app via
  official APIs only; no assets bundled in the repository or build
  artifacts.
- Acceptance (commercial): same, plus a license that explicitly permits
  the planned use, plus lawyer-confirmed before public release.

### Item 3: Hosting Policy Gated on Monetization Intent (`IP-3`)

> Document the hosting plan and gate it on the captured monetization
> intent. Self-hosted private use is the default; commercial hosting
> requires lawyer review.

- Acceptance (personal): self-hosted private use only; do not deploy
  publicly until a monetization decision is made and re-reviewed
  against this rule.
- Acceptance (commercial): hosting plan reviewed by counsel; written
  license terms cover the deployment region and audience; revenue model
  documented.

### Why These Three?

- The disclaimer is the cheapest defense -- a single line of text on the
  splash / landing surface meaningfully reduces consumer confusion about
  endorsement.
- The API-only-asset policy is the structural defense -- it prevents the
  most common copyright incidents (bundling sprite sheets, card images,
  audio clips) from being possible at all.
- The hosting policy is the deployment-time gate -- self-hosted private
  use is a different legal posture than a publicly-marketed commercial
  service, and the spec should make the gate explicit so it is not
  forgotten when the project drifts toward "let's just put it online".

---

## Out of Scope

⊗ Do not attempt to:

- Provide legal advice.
- Catalogue specific IP holders or trademark owners.
- Run automated trademark / copyright lookups against external services.
- Make a "is this fair use?" determination.

The heuristic exists to **surface the question**, not to answer it.

---

## Workflow Summary (for Interview / Research Skills)

```
1. Capture project description (and research notes if research strategy ran).
2. Run scripts/ip_risk.py:detect_ip_terms(text).
3. If empty -> proceed normally.
4. If non-empty:
   a. Ask the monetization-intent question (Personal / Commercial / Other).
   b. Loop on the freeform follow-up if "Other" is chosen until intent is captured.
   c. Emit plain_risk_summary(hits, intent) into the interview output.
   d. Inject ip_risk_scope_items(intent) into the spec vBRIEF.
   e. On commercial intent, surface the non-optional lawyer-consultation
      recommendation in the interview output AND in the IPRisk narrative.
5. Continue to the rest of the interview flow.
```
