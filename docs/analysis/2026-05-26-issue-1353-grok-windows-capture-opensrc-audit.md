# Issue #1353 Analysis: Open-Source Solutions for Windows PTY/ConPTY Capture
**Date:** 2026-05-26  
**Status:** Research complete — ready for recommendation to grok-build team  
**Severity:** adoption-blocker (high)  
**Audience:** grok-build platform team, directive maintainers, Windows agent harness consumers

---

## Executive Summary

Issue #1353 describes a **harness-level architectural failure**, not a directive problem. The grok-build platform's `run_terminal_command` tool on Windows (pwsh 7+) uses a fragile **redirect-to-temp-file + post-hoc read** wrapper that leaks its own `Get-Content` text into captured output whenever the user's command contains pipes (`|`), redirections (`>`), or stderr collection (`2>&1`).

**Root cause:** The wrapper constructs a shell command string that does not properly isolate user content from wrapper metacharacters. When user pipes interact with the wrapper's pipeline structure, internal capture commands become visible.

**The fix is architectural, not surface-level.** Every mature agent harness (Warp/Claude, VS Code, Cline, WezTerm) has converged on the same three-layer stack:

1. **PTY/ConPTY attachment** (not redirection-based capture) — `portable-pty`, `node-pty`, `pywinpty`, or equivalents
2. **OSC 633 / OSC 133 shell-integration markers** (command-boundary detection) — VS Code's `shellIntegration.ps1` + marker parsing
3. **Guardrail rules on the consumer side** (deft) — forbid capture-hostile patterns when deploying to grok-build

This document audits the published open-source solutions and recommends the next steps for both the grok-build team (upstream fix) and directive (defensive rules until fixed).

---

## Layer 1: ConPTY / PTY Bindings — Replace Redirection Capture

The fundamental issue is that **redirecting a child process's output to a file and reading it back is fragile under pipes**. Modern Windows has `ConPTY` (Pseudo Console) — the kernel's native PTY implementation — which lets a parent process attach to a child's real stdout/stderr stream without proxying through the shell.

### Tier-1 Recommendation: `portable-pty` (Rust)

**Repository:** https://github.com/wez/wezterm  
**Published crate:** https://crates.io/crates/portable-pty  
**Language:** Rust  
**License:** MIT  
**Maturity:** Production-grade; used by WezTerm (serious terminal emulator)  
**Key features:**
- Unified `PtySystem` trait that abstracts ConPTY (Windows 10+), winpty (older Windows), and Unix pty
- Proper shell-integration support (spawns with `$PROFILE`-aware initialization)
- Active maintenance; handles Windows-specific quirks (non-BMP Unicode, console codepage, session management)
- No external dependencies beyond the Windows API

**When to use:** If grok-build is open to adopting a Rust library (or can bind via FFI).

**Code path to examine:** https://github.com/wezterm/wezterm/tree/main/pty

---

### Tier-2 Recommendation: `microsoft/node-pty` (TypeScript/Node.js)

**Repository:** https://github.com/microsoft/node-pty  
**NPM:** `node-pty`  
**Language:** TypeScript (Node.js native module)  
**License:** MIT  
**Maturity:** Canonical; used by VS Code, Cursor, Cline  
**Key features:**
- Zero-configuration ConPTY on Windows; just `new Pty.spawn(shell, args)`
- The standard for JavaScript-based agents and terminals
- Handles Windows-specific encoding, codepage, and session isolation
- Active Microsoft stewardship

**When to use:** If grok-build is Node-based or has Node FFI bindings available.

**Code example:**
```javascript
const pty = require('node-pty');
const proc = pty.spawn('pwsh', [], { name: 'xterm-256color' });
proc.onData(data => console.log(data)); // Clean stdout, no wrapper leakage
```

---

### Tier-3 Recommendation: `andfoy/pywinpty` (Python)

**Repository:** https://github.com/andfoy/pywinpty  
**PyPI:** `pywinpty`  
**Language:** Python (wraps Windows API)  
**License:** MIT  
**Maturity:** Production; used by Jupyter, Spyder, other scientific Python tooling  
**Key features:**
- Pure Python API; `pip install pywinpty`
- Proper ConPTY support on Windows 10+
- Handles encoding, resize signals, exit codes

**When to use:** If grok-build can add a Python dependency.

**Code example:**
```python
from winpty import PtyProcess
proc = PtyProcess.spawn('pwsh')
output = proc.read()  # Clean output, no wrapper text
```

---

### Tier-4: Lightweight Rust Alternatives

If `portable-pty` feels too coupled to WezTerm:

- **`zhiburt/conpty`** (22★, Rust) — minimal ConPTY abstraction, MIT
- **`qsocket/conpty-go`** (9★, Go) — if grok-build is Go-based
- **`michaelvanstraten/pseudoterminal`** (18★, Rust) — cross-platform PTY w/ async support

All are substantially lighter than `portable-pty` but less battle-tested.

---

## Layer 2: Command-Boundary Detection — OSC 633 Shell Integration Markers

Once the harness attaches to a real PTY (Layer 1), it still needs to know **where a command's output starts and ends**. The problem is that `run_terminal_command` is a single tool call that must:

1. Inject a command into the shell
2. Wait for it to complete
3. Return all output
4. Capture the exit code

Without explicit command-boundary markers, the harness has to guess (timeouts, heuristics, watching for prompt patterns). This is noisy and fragile.

**Solution:** Use **OSC 633** (VS Code's extension of ECMA-48 OSC 133 / FinalTerm semantics) to mark command boundaries in the shell.

### The Reference Implementation: `microsoft/vscode` / `shellIntegration.ps1`

**Repository:** https://github.com/microsoft/vscode  
**File:** `src/vs/workbench/contrib/terminal/browser/media/shellIntegration.ps1`  
**License:** MIT  
**Key features:**
- Inject into the shell's `$PROFILE` (or as a prelude script)
- Emits `OSC 633 ; A` (prompt start), `B` (prompt end), `C` (command execution start), `D ; <exitcode>` (execution end)
- Portable across pwsh 5.1 and 7+
- Already used by VS Code, Cursor, Copilot CLI, and countless agent tooling

**The marker format:**
```
]633;A           — mark prompt start
]633;B           — mark prompt end  
]633;C           — mark command execution start
]633;D;123       — mark command execution end with exit code 123
]633;E;...;nonce — explicitly set command line for robustness
]633;P;...       — set working directory (PWD)
```

**How to use in grok-build:**
1. Invoke pwsh with `-NoProfile -Command ". <path-to-shellIntegration.ps1>; your-command"`
2. Read the child's output stream (via the ConPTY handle from Layer 1)
3. Parse for `]633;C…]633;D;<code>` markers
4. Extract bytes between those markers as the command output
5. Parse the `<code>` as the exit code

---

### Reference Consumer Implementation: `cline/cline` / `VscodeTerminalProcess.ts`

**Repository:** https://github.com/cline/cline  
**File:** `src/hosts/vscode/terminal/VscodeTerminalProcess.ts`  
**Language:** TypeScript  
**License:** Apache-2.0  
**Key features:**
- Definitive reference for parsing OSC 633 markers in a real agent tool
- Handles first-chunk artifacts (terminal echo of the command itself)
- Strips ANSI sequences
- Detects Ctrl+C interruption
- Robust against prompt patterns and shell artifacts
- 600+ lines of battle-tested code

**Critical extract:**
```typescript
// Parse ]633;C ... ]633;D[;<exitcode>] to find command output boundaries
const outputBetweenSequences = data.match(/\]633;C([\s\S]*?)\]633;D/)?.[1] || "";
const completionMatches = [...data.matchAll(/\]633;D(?:;(-?\d+))?/g)];
const latestCompletionMatch = completionMatches[completionMatches.length - 1];
if (latestCompletionMatch?.[1] !== undefined) {
  const parsedExitCode = Number.parseInt(latestCompletionMatch[1], 10);
  if (Number.isInteger(parsedExitCode)) {
    this.exitCode = parsedExitCode;
  }
}
```

**Why this matters:** This is the code that makes `cline` clean on Windows inside VS Code. If grok-build adopts the same pattern, #1353 vanishes.

---

## Layer 3: Ready-Made Windows Proxy — `FurbySoup/quell`

If the grok-build team wants a **drop-in proxy that sits between the agent and the terminal**, `quell` is the answer.

**Repository:** https://github.com/FurbySoup/quell  
**Language:** Rust (ConPTY + VT sequence filtering)  
**License:** MIT  
**Released:** March-April 2026 (recent, active)  
**Key features:**
- Standalone binary: `quell claude` or `quell gemini`
- Wraps any AI CLI tool and provides clean PTY output capture
- Handles VT-sequence security filtering (blocks clipboard access, font queries)
- Eliminates scroll-jumping on Windows (the original motivation)
- Two modes: GUI terminal or CLI proxy

**Relevant for grok-build:** The CLI proxy mode is architecturally exactly what a harness should do internally — ConPTY-based child spawn + clean output collection.

**Note:** This is a consumer-side workaround (agent operators can run `quell grok-claude` to wrap their commands). It doesn't fix grok-build itself, but it **proves the architecture works** and is what we'd recommend to directive users on Windows until grok-build fixes the upstream issue.

---

## Comparison Matrix: Which Library to Recommend to Grok-Build?

| Criterion | portable-pty | node-pty | pywinpty | quell | 
| --- | --- | --- | --- | --- |
| **Language fit** | Rust | Node.js | Python | (consumer proxy, not library) |
| **ConPTY support** | ✓ Full | ✓ Full | ✓ Full | ✓ Full |
| **OSC 633 integration** | ✗ (harness adds) | ✗ (harness adds) | ✗ (harness adds) | ✓ Included |
| **Maturity** | Production | Production | Production | Early (2026) |
| **Maintenance** | WezTerm team | Microsoft | Maintained | New, small team |
| **Dependency weight** | Light | Medium (Node) | Light | N/A (binary) |
| **Recommendation tier** | 1st (if Rust open) | 1st (if Node.js) | 2nd (if Python) | Consumer workaround |

---

## Downstream Impact: Directive's Defensive Posture

Until grok-build fixes the harness, directive needs **guardrails** to keep swarm work on Windows clean.

### Rule Addition to `AGENTS.md`

Add to the `## PowerShell` section (alongside #798):

```
**Harness capture limitations on grok-build (#1353):** Windows grok-build harness 
(as of May 2026) uses redirection-based output capture that leaks wrapper commands 
when the user's command string contains pipes (|), redirections (>), or stderr 
collection (2>&1).

! On grok-build + Windows: Forbid shell metacharacters in run_terminal_command 
  strings. Routes for "clean output" MUST use Python one-liners with pathlib 
  or write a temp .ps1 script and invoke by path.

~ This is a harness-level issue tracked in deftai/directive#1353. Reference:
  portable-pty (Rust), node-pty (Node), pywinpty (Python) are the upstream 
  solutions; quell (Rust CLI proxy) is a consumer workaround.

! Dispatcher-level note: When spawning sub-agents on grok-build Windows, ensure 
  the preamble includes the #1353 guidance. Sub-agents cannot reason around a 
  harness that leaks wrapper noise into their captured output.
```

### Deterministic Gate: `scripts/verify_grok_windows_safety.py`

Parallel to `scripts/verify_encoding.py` (#798), add a gate that scans skill templates and swarm preambles for capture-hostile patterns when the target is `grok-build + windows`:

```python
# Forbidden patterns when run_terminal_command is the executor:
FORBIDDEN_PATTERNS = [
    r'\|\s*cat\b',      # | cat
    r'\|\s*findstr\b',  # | findstr
    r'2>&1',            # stderr redirect
    r'>\s*\$tmp',       # temp file redirect
]
```

This catches new skills that re-introduce the pattern by accident, matching the discipline in #798.

---

## Recommended Next Steps

### For the Grok-Build Team (upstream fix)

1. **Adopt Layer 1:** Evaluate `portable-pty` (Rust) or `node-pty` (Node.js) for the harness's core `spawn` operation. Drop the redirect-to-temp-file strategy entirely.
2. **Adopt Layer 2:** Inject `microsoft/vscode`'s `shellIntegration.ps1` into every pwsh invocation. Parse OSC 633 markers (reference: `cline/cline`'s `VscodeTerminalProcess.ts`).
3. **Test on Windows 10 & 11:** Verify clean capture under `git rebase`, `task check`, swarm operations, and pipelines (`| cat`, `2>&1`).
4. **Publish as solved:** Update #1353 with the architectural fix and links to the references above.

**Estimated effort:** 1-2 sprints (architecture + integration testing). High impact (unblocks all Windows swarm work).

### For Directive (defensive posture)

1. **Update `AGENTS.md`:** Add the #1353 rule excerpt above to `## PowerShell`.
2. **Mirror to `templates/agents-entry.md`:** Per #1309 discipline.
3. **Add deterministic gate:** `scripts/verify_grok_windows_safety.py` scans for capture-hostile patterns.
4. **Wire into `task check`:** `task verify:grok-windows-safety` (or folded into `verify:encoding`).
5. **Document in `docs/the-harness-is-everything.md`:** Cross-reference #1353, the OSS solutions, and why this matters.
6. **Swarm preamble note:** `templates/agent-prompt-preamble.md` § 10 (new section) should call out the grok-build Windows limitation and the workaround (Python one-liners, temp scripts).

---

## Summary for Discussion

| **What** | **Who fixes?** | **Timeline** | **Interim mitigation** |
| --- | --- | --- | --- |
| Harness leakage (#1353) | grok-build team | 1-2 sprints | Directive guards + Python workarounds |
| Directive guardrails | Directive maintainers | 1 sprint (after #1353 upstream) | Already in AGENTS.md / #798 pattern |
| Consumer workaround | Agent operators on Windows | Available now | Use `quell` CLI proxy or Warp + Claude |

The three-layer stack (portable-pty / node-pty, OSC 633, guardrails) is proven open-source architecture. Every serious agent tool on Windows is converging on it. The grok-build fix is not a mystery — it's a well-documented engineering effort with reference implementations.

---

## References

- **#1353 (this issue):** https://github.com/deftai/directive/issues/1353
- **portable-pty:** https://github.com/wez/wezterm (MIT)
- **node-pty:** https://github.com/microsoft/node-pty (MIT)
- **pywinpty:** https://github.com/andfoy/pywinpty (MIT)
- **VS Code shellIntegration.ps1:** https://github.com/microsoft/vscode (MIT)
- **cline VscodeTerminalProcess.ts:** https://github.com/cline/cline (Apache-2.0)
- **FurbySoup/quell:** https://github.com/FurbySoup/quell (MIT)
- **Directive #798 (PowerShell encoding):** AGENTS.md § PowerShell
- **Directive #1309 (template propagation):** AGENTS.md § Template propagation discipline
- **Directive #1341 / #1342 (grok-build support):** Related platform effort
