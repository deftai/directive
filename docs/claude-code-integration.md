# Using Deft with AI Assistants (Claude Code & clawd.bot)

This guide explains how to integrate the deft framework with AI assistants using the AgentSkills specification.

## AgentSkills Specification

Deft's SKILL.md follows the **AgentSkills specification**, making it compatible with:
- **Claude Code** - AI-powered IDE assistant
- **clawd.bot** - Personal AI assistant (WhatsApp, Telegram, Discord, etc.)
- Any other AgentSkills-compatible system

## What is a Skill?

<cite index="1-1">A Claude Code Skill is a SKILL.md file with YAML frontmatter that tells Claude when to use the skill, and markdown content with instructions Claude follows when the skill is invoked.</cite>

## Installation Options

### Option 1: Personal Skill (Recommended)

Install deft as a personal skill to use across all your projects:

```bash
# Create personal skills directory
mkdir -p ~/.claude/skills/deft

# Copy SKILL.md to personal skills
cp /path/to/deft-0.2.0/SKILL.md ~/.claude/skills/deft/

# Optional: Symlink for easier updates
ln -sf /path/to/deft-0.2.0/SKILL.md ~/.claude/skills/deft/SKILL.md
```

### Option 2: Project-Specific Skill

Install deft for a specific project only:

```bash
# In your project directory
mkdir -p .claude/skills/deft

# Copy or link SKILL.md
cp ./deft/SKILL.md .claude/skills/deft/
```

### Option 3: Use Both

You can have both personal and project-specific installations. Claude Code will automatically discover and load skills from both locations.

## How It Works

### Automatic Invocation

<cite index="1-14,1-15">By default, both you and Claude can invoke any skill. Claude can load it automatically when relevant to your conversation.</cite>

The deft skill has `user-invocable: false`, which means:
- <cite index="1-19,1-20">Only Claude can invoke the skill, used for background knowledge that isn't actionable as a command.</cite>
- Claude automatically applies deft standards when you work in deft-enabled projects
- You don't need to type `/deft` to activate it

### When It Activates

Claude Code will automatically apply deft standards when:
- You're in a directory with `./deft/` subdirectory
- You mention deft, project standards, or coding guidelines
- You run tests, make commits, or perform quality checks
- You ask about project structure or best practices

### File Discovery

<cite index="1-23,1-24,1-25">When you work with files in subdirectories, Claude Code automatically discovers skills from nested .claude/skills/ directories, supporting monorepo setups where packages have their own skills.</cite>

## What the Skill Teaches Claude

The deft SKILL.md teaches Claude Code about:

1. **Rule Precedence** - How USER.md > PROJECT.md > language.md hierarchy works
2. **Lazy Loading** - Only read deft files as needed, not all at once
3. **Task-Centric Workflow** - Use `task` commands for all operations
4. **Test-Driven Development** - Write tests before implementation
5. **Quality Standards** - Always run `task check` before commits
6. **Conventional Commits** - Proper commit message format
7. **Coverage Requirements** - Maintain ≥85% test coverage
8. **Language Standards** - Python, Go, TypeScript, C++ specific conventions

## Verification

To verify the skill is installed:

```bash
# Check personal skills
ls -la ~/.claude/skills/deft/

# Check project skills (in project directory)
ls -la .claude/skills/deft/

# In Claude Code, the skill will automatically load when relevant
```

## Usage Examples

### Starting a New Project

You: "I want to start a new Python CLI project with deft"

Claude will:
1. Auto-load the deft skill
2. Initialize deft structure
3. Set up Python with pytest, ruff, mypy
4. Create Taskfile with standard tasks
5. Apply ≥85% coverage requirement

### Working on Existing Code

You: "Let's add a new feature to this module"

Claude will:
1. Read `./deft/main.md` for general guidelines
2. Check for `~/.config/deft/USER.md` and `./PROJECT.md`
3. Read `./deft/languages/python.md` (if Python)
4. Write tests first (TDD)
5. Implement feature
6. Run `task check` before suggesting commit

### Making a Commit

You: "commit this"

Claude will:
1. Run `task check` to verify all quality checks pass
2. Use Conventional Commits format
3. Ensure coverage threshold is met
4. Create properly formatted commit message

## Customization

### Per-Project Overrides

Create `.claude/skills/deft/SKILL.md` in your project to override the personal skill with project-specific variations.

### Combining with Other Skills

Deft skill works alongside other Claude Code skills. For example:
- Use deft for standards and workflows
- Use other skills for specific tasks (e.g., AWS deployment)
- Skills are modular and work together

## Troubleshooting

### Skill Not Loading

1. **Check file location**:
   ```bash
   ls -la ~/.claude/skills/deft/SKILL.md
   ```

2. **Verify YAML frontmatter** - Must be between `---` markers

3. **Restart Claude Code** - Skills are loaded at startup

### Conflicting Instructions

If deft conflicts with another skill:
1. Deft respects `~/.config/deft/USER.md` as highest precedence
2. Edit your USER.md to specify preferences
3. Consider disabling conflicting skills

### Skill Not Activating Automatically

The deft skill should auto-activate, but if not:
- Make sure you're in a directory with `./deft/`
- Explicitly mention "deft" or "project standards" in your request
- Check that `user-invocable: false` is set in SKILL.md

## Best Practices

1. **Use personal skill for consistency** across all projects
2. **Keep SKILL.md updated** - Pull latest from deft repository
3. **Symlink for easy updates** rather than copying
4. **Let Claude auto-invoke** - Don't manually trigger unless needed
5. **Trust the hierarchy** - USER.md > PROJECT.md > language.md

## Advanced: Skill Structure

The deft SKILL.md follows this structure:

```markdown
---
name: deft
description: Apply deft framework standards...
user-invocable: false
---

# Deft Framework
[Core instructions]

## Rule Precedence
[Hierarchy explanation]

## File Reading Strategy
[Lazy loading guide]

[Additional sections...]
```

<cite index="1-12">Keep SKILL.md under 500 lines. Move detailed reference material to separate files.</cite> The deft SKILL.md is optimized at ~327 lines with references to actual `./deft/*.md` files for details.

## Using with clawd.bot

clawd.bot is a personal AI assistant that works across WhatsApp, Telegram, Discord, and other messaging platforms. It uses the same AgentSkills specification as Claude Code, so the deft SKILL.md works seamlessly.

### Installation for clawd.bot

**Option 1: Manual Install (Shared)**
```bash
# Install for all agents on this machine
mkdir -p ~/.clawdbot/skills/deft
cp /path/to/deft-0.2.0/SKILL.md ~/.clawdbot/skills/deft/

# Or symlink for auto-updates
ln -sf /path/to/deft-0.2.0/SKILL.md ~/.clawdbot/skills/deft/SKILL.md
```

**Option 2: Per-Agent Install**
```bash
# Install for a specific agent workspace
mkdir -p <workspace>/skills/deft
cp SKILL.md <workspace>/skills/deft/
```

**Option 3: Via ClawdHub (Once Published)**
```bash
# Install from the registry
clawdhub sync deft

# Update to latest
clawdhub sync deft --latest
```

### clawd.bot Requirements

The SKILL.md includes clawd.bot-specific metadata:

```yaml
metadata:
  clawdbot:
    requires:
      bins: ["task"]  # Requires taskfile binary
    homepage: "https://github.com/deftai/directive"
os: ["darwin", "linux"]  # macOS and Linux only
```

Make sure `task` is installed:
```bash
# macOS
brew install go-task

# Linux
sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b ~/.local/bin
```

### Usage with clawd.bot

Deft works the same way across messaging platforms:

**Via WhatsApp**:
```
You: "Start a new Python project with deft"
Clawd: *Auto-loads deft skill*
       *Runs initialization workflow*
       *Applies all standards*
```

**Via Telegram/Discord**:
```
You: "Fix this bug using deft standards"
Clawd: *Loads deft*
       *Writes failing test first*
       *Fixes code*
       *Runs task check*
       *Creates commit*
```

### Multi-Agent Setups

With clawd.bot, you can have multiple agents with different skill sets:

- **Shared skills** (`~/.clawdbot/skills/`) - Available to all agents
- **Per-agent skills** (`<workspace>/skills/`) - Specific to one agent

For example:
- Main coding agent: Has deft + development skills
- Ops agent: Has deft + deployment skills  
- Personal agent: No deft, just life tasks

### Publishing to ClawdHub

To share the deft skill with the clawd.bot community:

```bash
# From the skill directory
cd /path/to/deft-0.2.0

# Publish to ClawdHub
clawdhub publish

# Update version
clawdhub publish --version 0.2.4
```

Browse published skills at https://clawdhub.com

## Further Reading

**Claude Code**:
- [Skills Documentation](https://code.claude.com/docs/en/skills)
- [Skills Marketplace](https://skillsmp.com/)

**clawd.bot**:
- [Skills Documentation](https://docs.clawd.bot/tools/skills)
- [ClawdHub Registry](https://clawdhub.com)
- [GitHub Repository](https://github.com/clawdbot/clawdbot)

**Deft**:
- [Deft Framework README](../README.md)
- [Deft REFERENCES.md](../deft/REFERENCES.md)
- [GitHub Repository](https://github.com/deftai/directive)

## Cross-Platform Benefits

Using the AgentSkills specification means:

1. **Write once, use everywhere** - Same SKILL.md for Claude Code, clawd.bot, and future platforms
2. **Consistent standards** - Your deft rules apply across IDE and messaging platforms
3. **Single source of truth** - Update once, propagates everywhere
4. **Community sharing** - Publish to multiple registries simultaneously
5. **Universal workflows** - TDD, SDD, and quality standards work in any context

---

**Note**: The deft SKILL.md is designed for maximum compatibility with any AgentSkills-compatible system.
