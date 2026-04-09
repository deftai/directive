# Markdown Best Practices

Legend (from RFC2119): !=MUST, ~=SHOULD, â‰‰=SHOULD NOT, âŠ—=MUST NOT, ?=MAY.

**âš ï¸ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

**Stack**: CommonMark/GFM; Diagrams: Mermaid; Linting: markdownlint; Render targets: GitHub, GitLab, Obsidian, static site generators

## Standards

### Writing Quality
- ! Write for the reader: assume they have context on the domain but not on your specific work
- ! Lead with the most important information (inverted pyramid)
- ! One idea per paragraph; one topic per section
- ! Use active voice for instructions: "Run the script" not "The script should be run"
- ~ Keep sentences under 25 words; break complex ideas into multiple sentences
- ~ Use second person ("you") for instructions; avoid first person in technical docs
- â‰‰ Wall-of-text paragraphs >5 sentences â€” break with subheadings, lists, or diagrams
- âŠ— Ambiguous pronouns ("it", "this", "that") without clear antecedent

### Content Organization
- ! Place a summary or purpose statement within the first 3 lines after the title
- ! Use headings as scannable signposts â€” reader should understand structure from headings alone
- ! Group related content under descriptive subheadings
- ! Place prerequisites and setup instructions before usage/workflow sections
- âŠ— Include mermaid charts in document line counts
- ~ Include a table of contents for documents >300 lines
- ~ Use admonitions/callouts (`> **Note:**`, `> **Warning:**`) for important asides
- â‰‰ Documents >700 lines â€” split into multiple linked files
- âŠ— Burying critical information (breaking changes, security) deep in a document

### Links & References
- ! Use descriptive link text that makes sense out of context
- ! Use relative paths for internal project links
- ! Verify links are valid before commit (dead link checker in CI)
- ~ Use reference-style links when the same URL appears 3+ times
- ~ Link to specific headings when referencing a section: `[Setup](./guide.md#setup)`
- âŠ— Bare URLs in prose â€” always wrap in descriptive link text
- âŠ— "Click here" or "this link" as link text

### Lists & Structure
- ! Use unordered lists for items without meaningful order
- ! Use ordered lists only when sequence matters (steps, rankings)
- ! Keep list items parallel in grammar and structure
- ~ Limit nesting to 2 levels; deeper nesting signals need for restructuring
- â‰‰ Lists >15 items without grouping â€” break into categorized sublists
- â‰‰ Mixing list styles (bullets and numbers) at the same level

### Style Preferences
- ~ Prefer `_italic_` over `*italic*` (clearer visual distinction from `**bold**`)
- ~ Prefer `**bold**` over `__bold__`
- ! Ordered lists: use `1.` for all items (auto-numbering; matches markdownlint MD029)

### Code in Documentation
- ! Use fenced code blocks with language identifiers for all code
- ! Keep code examples minimal: show the concept, not the entire file
- ! Ensure all code examples compile/run (test in CI where possible)
- ~ Use inline code for identifiers, file names, commands, and values
- ~ Add comments in code blocks only when the code isn't self-explanatory
- âŠ— Screenshots of code â€” always use text-based code blocks (searchable, accessible, copyable)

### Tables
- ! Use tables only for genuinely tabular data (rows Ã— columns)
- ! Include a header row with descriptive column names
- ~ Align columns in source for readability
- ~ Keep tables under 7 columns; consider alternative formats for wider data
- â‰‰ Tables for layout or formatting purposes
- â‰‰ Tables with cells containing multi-paragraph content â€” use definition lists or sections

### Images & Media
- ! Include descriptive alt text on every image (accessibility)
- ! Use vector formats (SVG, Mermaid) over raster (PNG, JPG) for diagrams
- ! Store images in a dedicated directory (`images/`, `assets/`, `diagrams/`)
- ~ Include a caption or description below complex images
- ~ Optimize raster images for file size before committing
- âŠ— Images as the sole carrier of critical information â€” always include text equivalent
- âŠ— Screenshots of terminal output â€” use text-based code blocks

## Mermaid Diagrams

- âŠ— Use mermaid in anywhere inside deft/ *.md files
- ~ Use Mermaid liberally whenever a visual would clarify relationships, flows, or architecture
- See [mermaid.md](./mermaid.md) for all Mermaid standards, theme config, and diagram examples

## Versioning & Maintenance

- ! Date or version-stamp documents that have a shelf life (ADRs, runbooks, release notes)
- ! Review and update docs when the related code changes
- ! Mark deprecated content clearly: `> **âš ï¸ Deprecated**: ...`
- ~ Use `CHANGELOG.md` for project-level change tracking
- âŠ— Stale documentation â€” better to delete than to mislead

## README Standards

- ! Include: project name, one-line description, quick start, prerequisites
- ~ Include: badges (CI, coverage, version), architecture overview, contributing guide link
- ~ Keep README under 300 lines; link to detailed docs for depth
- ! List all required environment variables / config without exposing secrets
- âŠ— Duplicating detailed docs in README â€” link instead

## ADR (Architecture Decision Records)

- ~ Use ADRs for significant technical decisions
- ! ADR format: Title, Status, Context, Decision, Consequences
- ! Status values: Proposed, Accepted, Deprecated, Superseded
- ~ Number ADRs sequentially: `adr-001-use-postgres.md`
- ~ Store in `docs/adr/` or `docs/decisions/`

## Tooling

### .markdownlint.json

```json
{
  "default": true,
  "MD003": { "style": "atx" },
  "MD004": { "style": "dash" },
  "MD007": { "indent": 2 },
  "MD013": { "line_length": 100, "code_blocks": false, "tables": false },
  "MD024": { "siblings_only": true },
  "MD025": { "front_matter_title": "" },
  "MD029": { "style": "one" },
  "MD033": false,
  "MD036": false,
  "MD041": true,
  "MD046": { "style": "fenced" },
  "MD048": { "style": "backtick" }
}
```

Key non-defaults: MD033/MD036 disabled (allow inline HTML, emphasis-as-heading); MD013 exempts code blocks/tables.

### .markdownlintignore

`node_modules/`, `.git/`, `build/`, `dist/`, `*.min.md`, `CHANGELOG.md`

### Editor & CI Integration

- **VS Code**: `DavidAnson.vscode-markdownlint` extension; set `"extends": "./.markdownlint.json"`, `editor.rulers: [100]`, `wordWrapColumn: 100`
- **Vim**: `dense-analysis/ale` or `coc-markdownlint`
- **Pre-commit**: `igorshubovych/markdownlint-cli` hook with `--fix`
- **GitHub Actions**: `DavidAnson/markdownlint-cli2-action@v15` with `globs: "**/*.md"`

## Anti-Patterns

- âŠ— **Stale docs**: Delete or update â€” stale docs are worse than no docs
- â‰‰ **Documents >700 lines**: Split into focused, linked files
- â‰‰ **Deeply nested lists (>2 levels)**: Restructure into sections or subheadings

## Compliance Checklist

- ! Descriptive headings; summary in first 3 lines; scannable structure
- ! Alt text on all images; descriptive link text; no bare URLs
- ! Fenced code blocks with language identifiers; examples that compile
- ! Mermaid: see [mermaid.md](./mermaid.md)
- ! Documents <700 lines; README <500 lines
- âŠ— Screenshots of code, "click here" links, stale docs
- ! Run `task lint` before commit
