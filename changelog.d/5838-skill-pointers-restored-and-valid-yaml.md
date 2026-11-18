section: Fixed
- Install, repair and upgrade now write the `deft-directive-tutorial` and `deft-directive-feedback` skill pointers again (12 pointers, as in 0.126). Upgrades rewrite the old ones that pointed at the deleted `.deft/core/skills/` folder, and uninstall removes them (#5838).
- The `deft-directive-refinement` skill pointer now has valid YAML front matter: its description is quoted because it contains `: `. The other pointers keep the same bytes (#6165).
