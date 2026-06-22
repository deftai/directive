I want to build uptop, a CLI+TUI that has all or nearly all of the features of btop, but in addition to being a TUI can be a useful CLI by 1. outputting collected data repeatedly at an interval specified by the user, defaulting to once per second 2. supporting output formats including --json and --markdown. uptop should also support a plug-in architecture that allows people to add new "panes" or types of information to be collected and to output. The plug-in architecture requirement may affect the choice of programming language used.

Use Claude AskInterviewQuestion (or if you are not claude, a simulation of that process) to interview me in depth and detail to create a complete project specification.

At each step, ask one focused, non‑trivial question with clear numbered answer options when appropriate. Include an "other" option that lets users specify what'd they'd rather do or say they don't know what to do.

Ask detailed, non‑obvious questions about missing decisions, edge cases, implementation details, requirements, architecture, UX, constraints, and tradeoffs. Keep asking until you are confident there is little ambiguity left and you could generate a comprehensive spec.

Then generate the spec as SPECIFICATION.md. Break the implementation plan up into different phases, subphases, and tasks so that multiple coding agents can work on the project in parallel. Make it clear if any phases, subphases, or tasks depend on others. Only plan, don't write any code.
