# Contributing to Deft

Guide for setting up a development environment, running tests, and building the project.

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

## Prerequisites

The following tools must be installed before working on Deft:

- **Go 1.22+** — required for building the installer (`cmd/deft-install/`)
- **Python 3.11+** — required for the CLI (`run`) and test suite
- **uv** — Python package manager and task runner ([docs.astral.sh/uv](https://docs.astral.sh/uv))
- **task** — Taskfile runner ([taskfile.dev](https://taskfile.dev))

Verify your toolchain:

```bash
go version        # go1.22 or later
python --version  # Python 3.11 or later
uv --version      # any recent version
task --version    # any recent version
```

## Dev Environment Setup

1. Clone the repository:

```bash
git clone https://github.com/deftai/directive.git
cd directive
```

2. Install Python dependencies:

```bash
uv sync
```

3. Verify everything works:

```bash
task check
```

## Running Tests

Run the test suite:

```bash
task test
```

Run tests with coverage reporting:

```bash
task test:coverage
```

### The `task check` Gate

! `task check` is the **authoritative pre-commit gate**. It runs validation, linting, and the full test suite in sequence:

```bash
task check    # runs: validate + lint + test
```

! A passing `task check` is the **definition of ready-to-commit**. Do not commit unless `task check` passes.

⊗ Commit code that has not passed `task check`.

## Running CLI Locally

The Deft CLI is a Python script at the repo root. Run it with:

```bash
uv run python run
```

Available CLI commands:

```bash
uv run python run bootstrap    # Set up user preferences
uv run python run project      # Configure project settings
uv run python run spec         # Generate specification via AI interview
uv run python run validate     # Check deft configuration
uv run python run doctor       # Check system dependencies
```

## Building the Go Installer

The Go installer lives in `cmd/deft-install/`. Build it with:

```bash
go build ./cmd/deft-install/
```

This produces a `deft-install` binary (or `deft-install.exe` on Windows) in the current directory.

To run the installer directly without building first:

```bash
go run ./cmd/deft-install/
```

To run the installer's tests:

```bash
go test ./cmd/deft-install/
```
