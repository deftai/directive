# Refactoring Guidelines

Ten principles for improving code quality — applied during refactoring, code review,
or any time the question "what should I fix next?" comes up.

These apply to conventional source code (Python, Go, TypeScript, etc.) and to
directive's markdown files, which are the framework's executable source. For the
markdown-specific audit, see [agents-md-vs-skill-md.md](./agents-md-vs-skill-md.md).

---

## 1. Module depth

**Shallow modules — where the interface is nearly as complex as the implementation —
are the root cause of most coupling problems.**

A deep module (Ousterhout, *A Philosophy of Software Design*) has a small interface
hiding a large implementation. Callers don't need to know the internals; the module
absorbs complexity on their behalf. A shallow module offers an interface as complex
as its body — callers must understand both, so the abstraction provides no leverage.

Find places where: understanding one concept requires bouncing between many small
files; a function exists purely to rename another function; an interface has more
methods than the implementation has unique behaviors. Deepen them.

---

## 2. Naming

**Names that require a comment to understand are wrong names. Rename aggressively;
it improves every downstream read.**

A name is wrong when: you need to read the body to understand what the name means;
the name describes *how* rather than *what*; the name includes implementation details
that could change (`processDataAndWriteToFileAndLog`); or the name is so generic it
applies to everything (`manager`, `handler`, `util`, `helper`).

The test: can you read a callsite in isolation and understand what is happening? If
not, the callee's name is wrong.

---

## 3. Function length / single responsibility

**A function that does two things should be two functions. The tell: if the function
has "and" in its name, or a blank line separating unrelated logic.**

Long functions are rarely the problem in isolation — they become a problem when
length comes from mixing responsibilities. A function that builds a menu, parses
input, and dispatches navigation is three functions jammed together. When one
responsibility changes, the reader must untangle all three.

The blank-line heuristic: a blank line inside a function usually marks the boundary
between two distinct tasks. Each is a candidate for extraction.

---

## 4. Duplication

**Not just copy-paste duplication — also conceptual duplication, where two different
code paths encode the same decision separately. When the decision changes, one gets
updated and one doesn't.**

Copy-paste duplication is visible. Conceptual duplication is not: the same business
rule expressed in two different functions, the same validation applied independently
at two layers, the same configuration value hard-coded in two places. When the rule
changes, one instance is found and updated; the other becomes a latent bug.

Ask: "if this decision were to change, how many places would I need to update?" More
than one is duplication.

---

## 5. Error handling completeness

**Errors handled at the wrong layer, swallowed silently, or inconsistently surfaced
are where the hardest bugs live.**

Find every `catch` / `except` that: does nothing (`pass`, `{}`, swallow); logs and
continues without propagating the signal; converts a specific, actionable error into
a generic one; or handles the error at a layer that has no context to do anything
useful with it.

Silent error swallowing is the worst case — it makes failures invisible to callers,
to CI, and to operators. An error that surfaces as a wrong result five steps later
is far harder to debug than one that fails loudly at the source.

---

## 6. State boundaries

**Mutable state that leaks across module boundaries is almost always a refactoring
target. Pure functions and narrow owned-scope mutation are the goal.**

Global or singleton mutable state means any code anywhere can change the world at
any time. Test isolation becomes impossible. Reasoning about behavior requires
holding the entire program in your head. Side effects at a distance cause bugs that
are nearly impossible to reproduce reliably.

The fix is not always immutability — sometimes mutation is right. The fix is
*narrowing the scope*: mutation that is owned by a specific module, that cannot
be observed from outside, that is encapsulated behind a clean interface.

---

## 7. Test quality, not just coverage

**Tests that test implementation details break when code is refactored even when
behavior is unchanged. Find and replace them with boundary tests.**

A test that mocks every internal call is coupled to the implementation, not the
behavior. When the implementation is restructured, the test breaks — even though
nothing the user observes has changed. The test is an obstacle to refactoring
rather than a safety net for it.

Good tests assert on observable outcomes at the module boundary: API responses,
return values, file contents, events emitted. They survive internal refactors
because they don't know or care how the internals are organized.

Coverage measures how many lines were executed. It says nothing about whether
the tests would catch a regression. A 90% covered test suite full of mocked
internals can miss real bugs that a 60% covered boundary-test suite would catch.

---

## 8. Abstraction level consistency

**A function that mixes high-level logic with low-level detail forces the reader to
context-switch constantly. Each function should operate at one level of abstraction.**

Business rules alongside SQL. Domain logic alongside HTTP header parsing. High-level
orchestration interleaved with string manipulation. These are the signs. The reader
cannot understand the function without holding two mental models simultaneously.

The fix is extraction: pull the low-level detail into a function at the right
abstraction level, give it a name that communicates its purpose at the caller's
level, and let the high-level function read as a clean orchestration of named concepts.

---

## 9. Dependency direction

**High-level modules importing low-level modules is correct. The reverse is an
inversion that should be fixed. Circular dependencies are always wrong.**

Draw the dependency graph. In a healthy codebase, it is a DAG flowing in one
direction: domain logic at the top, infrastructure and I/O at the bottom. Low-level
modules should not know about high-level ones — they should expose interfaces that
high-level modules depend on, not the other way around.

Circular dependencies mean no part of the cycle can be understood or tested
independently. They are a signal that boundaries have not been drawn correctly.
Introduce an interface, invert a dependency, or merge the modules.

---

## 10. Dead code and dead paths

**Unreachable code, always-on feature flags, parameters that are never passed,
branches that are never taken — these add cognitive load without contributing
behavior and make the true code path harder to trace.**

Dead code is not just unused functions. It is also: `if false` branches, flags
that are always `true`, parameters accepted but never used, `else` branches that
can never be reached given invariants established earlier, and legacy format
handling that the validator already rejects before the code is reached.

Every dead path is a question a reader must ask — "when does this run?" — and then
answer — "apparently never" — before they can move on. Multiply that by dozens of
dead paths and the cognitive overhead is significant. Delete dead code; version
control preserves it if it is ever needed again.

---

## Prioritization

When everything is a candidate, fix in this order:

1. **Naming** — cheapest, highest leverage on readability, improves everything downstream
2. **Module depth** — architectural, but quickly reveals what else needs fixing
3. **Error handling** — most likely to contain latent bugs
4. **Duplication** — reduces maintenance surface
5. **Single responsibility / abstraction level** — improve incrementally during normal work
6. **Dead code** — safe to remove, reduces noise
7. **State boundaries** — highest-effort, highest-impact for testability
8. **Test quality** — improve as you touch existing test files
9. **Dependency direction** — usually requires architectural decisions; address deliberately
