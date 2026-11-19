section: Fixed
- "Review and commit" also lists files Directive removed (for example an old `.deft/core`), so the deletions get committed too (#6006).
- `task materialize:runtime` refuses a runtime link it cannot follow instead of overwriting it, and removes its temporary folders when a tip build fails (#6220).
