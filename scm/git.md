# Git Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md) | [github.md](../scm/github.md)

**Stack**: git 2.30+, Conventional Commits, `git --no-pager`, task-based workflows

## Standards

**Commits**: ! use Conventional Commits format: `type(scope): description`
**Changelog**: ! follow [Keep a Changelog](./changelog.md) format
**Versioning**: ~ follow [Semantic Versioning](../core/versioning.md)
**Safety**: ⊗ use `git reset --hard` or force-push without explicit permission
**Workflow**: ! make small, reversible changes; ⊗ introduce silent breaking behavior
**History**: ~ maintain linear history; ~ rebase over merge for feature branches (with permission)
**Branches**: ~ use descriptive names: `feat/feature-name`, `fix/bug-name`, `refactor/scope`

## Commit Types

**Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`

```bash
feat(auth): add JWT token refresh mechanism
fix(api): handle null response in user endpoint
docs(readme): update installation instructions
refactor(db): extract connection pool logic
test(parser): add edge cases for malformed input
chore(deps): upgrade golang.org/x/crypto to v0.17
```

**Format**:

- **type(scope)**: ! include type; ~ include scope
- **description**: ! be lowercase, no period, imperative mood ("add" not "added")
- **body**: ? be included; ~ wrap at 72 chars if present
- **footer**: ? include `BREAKING CHANGE:` or `Closes #123`

## Workflow Best Practices

**Before committing**:
1. ! Review changes with `git diff` and `git diff --cached`
2. ! Run `task check` (MUST run pre-commit checks)
3. ! Use interactive staging (`git add -p`) for complex changes
4. ! Write descriptive commit messages following Conventional Commits

**Branching**:
- ~ Use descriptive branch names: `feat/feature-name`, `fix/bug-name`
- ~ Create feature branches from latest `main`
- ~ Delete branches after merge

**Syncing**:
- ~ Use `git pull --rebase` to maintain linear history
- ! Always use `git --no-pager` for scripted/programmatic operations
- ~ Keep feature branches up to date with `main`

## .gitignore Patterns

```gitignore
# Dependencies
node_modules/
vendor/
.venv/
__pycache__/

# Build outputs
dist/
build/
*.o
*.so
*.dylib

# IDE
.idea/
.vscode/
*.swp
*.swo
.DS_Store

# Secrets (CRITICAL)
secrets/
*.env
*.pem
*.key
.envrc

# Generated
coverage/
htmlcov/
*.log
.task/

# OS
Thumbs.db
```

## Safety Rules

**MUST NOT do without explicit permission**:

- `git reset --hard` - destroys uncommitted work
- `git push --force` - rewrites published history
- `git rebase` on published branches
- `git clean -fd` - deletes untracked files

**Always safe (MAY use freely)**:

- `git revert` - creates new commit undoing changes
- `git restore` - discards unstaged changes (affects working tree only)
- `git restore --staged` - unstages files
- `git stash` - temporarily saves work

**SHOULD prefer**:

- Small commits over large ones
- Descriptive commit messages over terse ones
- `--force-with-lease` over `--force` (if force push needed)
- New commits over history rewriting
- Temp branches for experiments


## Changelog & Versioning

! Maintain CHANGELOG.md following [Keep a Changelog](./changelog.md) format
! Use [Semantic Versioning](../core/versioning.md) for releases:
- **MAJOR** (X.0.0): Breaking changes
- **MINOR** (0.X.0): New features (backward compatible)
- **PATCH** (0.0.X): Bug fixes (backward compatible)

## Compliance

- ! Use Conventional Commits for all commits: `type(scope): description`
- ! Maintain CHANGELOG.md following Keep a Changelog format
- ! Use Semantic Versioning for releases
- ⊗ Force-push or `reset --hard` without explicit permission
- ! Run `task check` before committing
- ! Use `git --no-pager` for programmatic/scripted operations
- ! Keep secrets in `secrets/` dir; ⊗ commit them
- ~ Prefer safe alternatives (`revert`, temp branches) over history rewriting
