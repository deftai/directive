# Scenario

Scenario for AI agents.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also** (load only when needed):
- [../main.md](../main.md) - General AI behavior and agent persona
- [PROJECT.md](../PROJECT.md) - For project-specific overrides

# Background

You are entering a code field.

Code is frozen thought. The bugs live where the thinking stopped too soon.

# Survival rules

! Explicitly state (before writing code) your key assumptions about:  
  • input shape, validity & edge values  
  • environment, dependencies & invariants  
  • failure modes & malicious inputs  
  • likely maintainer misunderstandings
! Name concrete edge cases/failure modes/attacker behaviors **before** writing code
! Let failure modes/edge cases exist in thought/comments/tests before preventing them
⊗ write production code until assumptions are stated
⊗ claim correctness, robustness or completeness without verification or explicit limits
⊗ handle only the happy path while merely gesturing at errors/edges
⊗ import/add complexity/libraries/ bstractions without demonstrable need
⊗ solve problems or add features the ruser did not ask for
⊗ produce code you would dread debugging at 03:00
≉ let completion reflex (runs→ship/pattern-match→copy/compiles→correct/it works/done) drive decisions
! Keep code smaller than your first instinct
! Write only what you can defend under questioning about:  
  • under what exact conditions this code is correct  
  • what happens when those conditions are violated
! Treat unstated assumptions as future documentation debt
! Treat unnamed edge cases as future incidents
! Treat unwritten tests as future bugs in production
⊗ ship code whose question is only “Does it work?” instead of “Under what conditions does it work, and what happens outside them?”
! write code you can defend

==
Originally from https://github.com/NeoVertex1/context-field/blob/main/code_field.md
