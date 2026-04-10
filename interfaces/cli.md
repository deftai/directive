# CLI Best Practices

Opinionated patterns for command-line interfaces with AI agents.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.
Tags: Py=Python; TS=TypeScript; Node=Node.js

## Framework Selection

**Python:**
- ! Use Typer (except: existing Click+plugins, simple argparse scripts)

**TypeScript/Node.js:**
- ! Use commander (except: existing codebases, simple scripts)
- ⊗ Use `readline` for complex CLIs (use TUI libraries instead)

## Output

- ~ Support multiple formats for data CLIs (JSON, tree, markdown, HTML)
- ! Enforce format flag mutual exclusivity
- ~ Default to human-readable (tree, table); JSON for machines/LLMs
- Use individual flags (`--json`, `--tree`) not `--format=json`

## Commands

- ! One command = one action
- ~ Use subcommands for related actions
- ~ Keep names short and clear
- ! Provide `--help` / `-h` with clear descriptions
- ~ Provide `--ai-help` for LLM-detailed guidance
- ! Provide rich error messages with actionable suggestions

## Architecture

- ~ Separate concerns: cli.py (parsing), client.py (logic), formatters.py (output)
- ~ Use enums for options
- ! Validate before execution
- Config hierarchy: CLI flags > env vars > config file > defaults

## UX

- ~ Show help (not error) when no args
- ~ Support flexible input parsing (natural language where practical)
- ~ Support shell completion (Typer/commander provide this)
- ! Version info available

## Authentication

- ⊗ Hardcode credentials
- ! Use environment variables or secure stores
- ~ Support multiple auth methods
- ! Clear error when auth fails

## Output Handling

- ≉ Buffer large outputs
- ~ Stream when possible
- ~ Consider pagination for large results

## Testing

See [testing.md](../coding/testing.md) for universal requirements.

- ! Test all command paths, format options, error conditions
- ~ Snapshot test output formats (CLI output, help text)

## Common Patterns

**Config priority:**
1. CLI flags (highest)
2. Environment variables
3. Config file
4. Defaults (lowest)

**Dual mode**:
- ? Switch to TUI when interactive, CLI otherwise
```python
if sys.stdout.isatty() and not format_flags:
    run_tui()
else:
    run_cli()
```

**Plugin architecture**:
- ? Support plugin discovery via entry points
- ? Validate plugins before use
- ? Define protocol/interface for plugins

## Documentation

- ! Module docstrings with usage examples
- ! Command docstrings with descriptions and examples
- ~ README: quick start, commands, config, dev setup

## Anti-patterns

- ⊗ Assume user timezone (document behavior)
- ⊗ Allow multiple format flags simultaneously
- ⊗ Buffer large outputs without streaming
- ⊗ Provide unclear error messages

---

**See also**: [python.md](../languages/python.md) | [typescript.md](../languages/typescript.md) | [tui.md](../interfaces/tui.md)
