# Power of Ten – Adapted for Deft  
JPL/NASA-inspired rules for reliable, verifiable code  
(Original: Gerard J. Holzmann, "The Power of Ten – Rules for Developing Safety-Critical Code", IEEE Computer, June 2006)

**⚠️ See also** (load only when needed):
- [coding.md](coding.md) - General coding guidelines
- [../verification/verification.md](../verification/verification.md) - Verification practices (Holzmann ladder)

! These rules MUST be understood as the canonical high-assurance reference for Deft.
~ Apply the general intent across all languages.  
~ Put language-specific enforcement, tooling, and exceptions only in languages/*.md files.

## Notation Legend (Deft RFC 2119 compact style)
! = MUST (required, mandatory)  
~ = SHOULD (recommended, strong preference)  
≉ = SHOULD NOT (discouraged, avoid unless justified)  
⊗ = MUST NOT (forbidden, never do this)
? = MAY 

## The Adapted Rules

1. Simple control flow  
   ⊗ Use direct or indirect recursion
   ~ Use explicit iteration or stacks instead.
   ⊗ Exotic/non-local jumps (goto where supported, longjmp equivalents, setjmp). 
   ~ Restrict control flow to basic constructs: if/else, bounded for/while, switch/case/match.  
   ! Keep code analyzable and provably terminating where possible.

2. Bounded loops  
   ! Every loop MUST have a statically provable fixed upper bound or mechanically verifiable termination condition.  
   ⊗ Naked infinite loops (while True:, for {} without escape guarantee) are forbidden.  
   ~ Prefer for i in range(MAX) / for i := 0; i < MAX; i++ {} patterns wherever practical.  
   ! Termination guarantee MUST be preserved in all loops.

3. Fixed resource allocation after initialization  
   ~ Allocate/grow dynamic structures (lists, maps, slices, heaps) during startup/initialization phase only.  
   ≉ Grow structures (append, map inserts, slice appends) in hot paths or long-running loops unless bounded.  
   ⊗ Unbounded dynamic allocation/growth in steady-state operation is forbidden (where language-relevant).  
   ! Resource usage MUST remain predictable after initialization.

4. Small functions  
   ~ Functions SHOULD be ≤ 40–60 lines (aim for one screen / printed page).
   ~ Cyclomatic complexity SHOULD be ≤ 10 per function.  
   ! Small, focused functions MUST be preferred for verifiability and reviewability.

5. Runtime checks & assertions  
   ~ Every non-trivial function SHOULD include at least two explicit runtime checks/assertions.
   ~ Use preconditions, postconditions, or invariants via language-native mechanisms.  
   ! Runtime checks MUST catch violations early in non-trivial logic.

6. Minimal data scope  
   ! Mutable shared/global state MUST be minimized — prefer local, passed, or immutable data.  
   ⊗ Unnecessary module/package-level mutable variables (except constants) are forbidden.  
   ~ Dependency injection or functional style SHOULD be used where practical.  
   ! Scope reduction MUST reduce coupling and side effects.

7. Error & return checking  
   ! Non-void return values and error indicators MUST never be ignored.  
   ! In error-returning languages every error MUST be checked or explicitly propagated.  
   ⊗ Silent failure / ignored exceptions are forbidden unless explicitly documented as safe.  
   ! Explicit error handling MUST be enforced.

8. Restricted metaprogramming  
   ⊗ Complex/multi-level macros or preprocessor abuse are forbidden (C/C++).  
   ≉ Heavy decorators, metaclasses, or code generation that obscures control flow SHOULD be avoided.  
   ~ Metaprogramming SHOULD remain minimal and local in safety-critical paths.
   ! Analyzability MUST be preserved; metaprogramming MUST NOT obscure control flow.

9. Restricted indirection  
   ⊗ Multi-level pointers / double indirection are forbidden (C/C++ raw pointers).  
   ≉ Deep pointer chains or excessive indirection SHOULD be avoided in other languages.  
   ~ Prefer slices, references, or owned types (Rust, Go).  
   ! Indirection MUST be kept simple to reduce aliasing risk.

10. Maximum static checking  
    ! Compile/lint with maximum warnings enabled and treat warnings as errors.  
    ! Strictest static analysis tools available for the language MUST be used.  
    ! Static checking MUST catch issues at build time.

## Additional Holzmann-inspired Practices
~ Lightweight, interactive analysis tools SHOULD be preferred (Cobra philosophy).  
~ Consider adding task cobra target for repo-wide queries (functions >40 lines, unbounded loops).  
! Verification ladder MUST integrate with verification/ practices.  
~ Every significant PR SHOULD include a short verifiability note.

## References
~ Original paper: https://spinroot.com/gerard/pdf/P10.pdf  
~ Holzmann's SPIN model checker: https://spinroot.com

! This adaptation preserves JPL flight-software reliability philosophy for Deft's layered system.
