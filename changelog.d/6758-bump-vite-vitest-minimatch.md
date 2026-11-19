section: Fixed
- Updated `vite` to 7.3.8, `vitest` and `@vitest/coverage-v8` to 4.1.12, and `minimatch` to 11 (including the copy `archiver` uses through `readdir-glob`) to clear nine open Dependabot alerts. The Node 20 glob fallback now reads minimatch 11's segment matcher objects, so its results still match `fs.globSync`. Refs #6758.
