# R Standards

Legend (from RFC2119): !=MUST, ~=SHOULD, ≉=SHOULD NOT, ⊗=MUST NOT, ?=MAY.

**⚠️ See also**: [main.md](../main.md) | [PROJECT.md](../PROJECT.md)

**Stack**: R 4.3+, tidyverse; Packages: devtools/usethis; Testing: testthat 3; Docs: roxygen2; Lint: lintr; Style: styler

## Standards

### Documentation
- ! roxygen2 comments (`#'`) for all exported functions, classes, and datasets
- ! Document `@param`, `@return`, `@examples`, `@export` for public functions
- ! Include a `README.Rmd` or `README.md` for packages
- ~ Use `@seealso` and `@family` to cross-reference related functions

### Testing
See [testing.md](../coding/testing.md).

- ! Use testthat 3 (`test_that()`, `expect_*()`)
- ! Place tests in `tests/testthat/`; files: `test-*.R`
- ~ Use snapshot tests (`expect_snapshot()`) for complex output

### Coverage
- ! ≥85% coverage (measured via covr)
- ! Count R/\*
- ! Exclude entry points, generated files, vignettes

### Style
- ! Follow [Tidyverse Style Guide](https://style.tidyverse.org/)
- ! Use lintr for static analysis (project `.lintr` config checked in)
- ! Use styler for auto-formatting
- ! 2-space indentation, no tabs
- ! Line length ≤80 characters

### Naming Conventions
- ! `snake_case` for functions, variables, and file names: `read_data()`, `user_count`
- ! `PascalCase` for R6/S4 class names: `DataProcessor`, `ModelConfig`
- ! `UPPER_SNAKE_CASE` for true constants
- ! Prefix internal/non-exported functions with `.`: `.validate_input()`
- ⊗ Dots in function names for new code (`read.csv` style): use `snake_case`
- ⊗ Single-letter variable names except in math/formula contexts (`x`, `y`, `n`)

### Types & Data
- ! Use tibbles (`tibble`/`data.frame`) over lists for tabular data
- ! Use explicit types: `integer(1)`, `character(0)`, `logical(1)` for scalars
- ~ Use `rlang::check_required()` / `rlang::abort()` for argument validation
- ~ Use named lists or S3/R6 classes for structured non-tabular data
- ⊗ Use `T`/`F` — always spell out `TRUE`/`FALSE`
- ⊗ Rely on partial argument matching

### Functions
- ! Pure functions preferred: same inputs → same outputs, no side effects
- ! One function per purpose; keep under 50 lines where practical
- ! Use `...` (dots) deliberately; document what they pass to
- ⊗ Modify global state from inside functions (`<<-`, `assign()` to `.GlobalEnv`)
- ~ Use `invisible()` for functions called for side effects that return invisibly
- ~ Use `tryCatch()` / `withCallingHandlers()` for error handling

### Dependencies
- ! Minimize dependencies; use `Imports` not `Depends` in DESCRIPTION
- ! Pin major versions in `renv.lock` for reproducibility
- ! Use `renv` for project-level dependency isolation
- ⊗ Use `library()` inside package code — use `::` or `@importFrom`
- ~ Use `Suggests` for test/vignette-only dependencies

### Vectorization & Performance
- ! Prefer vectorized operations over explicit loops
- ~ Use `purrr::map()` family for functional iteration
- ~ Use `data.table` or `dplyr` for data manipulation (not base `for` loops on data frames)
- ≉ Use `apply()` family when `purrr` or vectorized alternatives exist
- ≉ Grow vectors in a loop (`c(vec, new_elem)`) — pre-allocate instead

### Pipelines
- ! Use native pipe `|>` (R 4.1+) or `%>%` from magrittr
- ! Keep pipe chains readable (one operation per line)
- ≉ Pipe chains longer than 10 steps — extract into named intermediate variables or functions
- ~ Use `.data` and `.env` pronouns in tidy evaluation for clarity

### Reproducibility
- ! Use `renv` for project dependency snapshots
- ! Set `set.seed()` before any stochastic operation; document seed in reports
- ! Use relative paths; ⊗ absolute paths or `setwd()`
- ~ Use `here::here()` for project-relative paths
- ~ Use Quarto or R Markdown for reproducible reports

### Security
- ⊗ Hardcode secrets or credentials in source
- ! Validate/sanitize all external inputs (file paths, user data, API responses)
- ~ Use `.Renviron` for secrets; load via `Sys.getenv()`

### Telemetry
- ~ Structured logging (logger, futile.logger) for production
- ? OpenTelemetry (via REST/Python bridge) for distributed tracing

## Commands

See [commands.md](./commands.md).

## Patterns

### Testing (testthat 3)
```r
test_that("calculate_mean returns correct mean", {
  expect_equal(calculate_mean(c(1, 2, 3)), 2)
  expect_equal(calculate_mean(c(10, 20)), 15)
})

test_that("calculate_mean errors on non-numeric input", {
  expect_error(calculate_mean("abc"), "must be numeric")
})

test_that("calculate_mean handles NA with na.rm", {
  expect_equal(calculate_mean(c(1, NA, 3), na.rm = TRUE), 2)
  expect_equal(calculate_mean(c(1, NA, 3), na.rm = FALSE), NA_real_)
})
```

### roxygen2 Documentation
```r
#' @param x Numeric vector. @param weights Numeric vector (same length). @param na.rm Remove NAs?
#' @return Single numeric. @export
weighted_mean <- function(x, weights, na.rm = FALSE) {
  stopifnot(is.numeric(x), is.numeric(weights), length(x) == length(weights))
  if (na.rm) { keep <- !is.na(x) & !is.na(weights); x <- x[keep]; weights <- weights[keep] }
  sum(x * weights) / sum(weights)
}
```

### Tidy Pipeline
```r
summary_by_group <- raw_data |>
  filter(!is.na(value)) |> group_by(category) |>
  summarise(mean_val = mean(value), n = n(), .groups = "drop") |>
  arrange(desc(mean_val))
```

### Error Handling (rlang)
```r
read_config <- function(path) {
  if (!file.exists(path)) rlang::abort(paste0("Config not found: ", path), class = "config_not_found_error")
  tryCatch(yaml::read_yaml(path), error = function(e) rlang::abort("Failed to parse config", parent = e))
}
```

## Anti-Patterns

Items marked ⊗ in Standards above are not repeated here.

- ≉ **Dot-separated names** (`my.function`): Use `snake_case`
- ≉ **`sapply()`**: Use `vapply()` or `purrr::map_*()`
- ≉ **Pipe chains >10 steps**: Extract named intermediates

## Compliance Checklist

- ! roxygen2 docs on all exported functions
- ! See [testing.md](../coding/testing.md) for testing requirements
- ! testthat 3 for unit tests; ≥85% coverage via covr
- ! lintr + styler configured and enforced
- ! Tidyverse style; `snake_case` naming; `TRUE`/`FALSE` spelled out
- ! `renv` for dependency reproducibility
- ⊗ `T`/`F`, `<<-`, `setwd()`, `library()` in packages, absolute paths
- ! Run `task check` before commit
