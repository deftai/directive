section: Fixed
- Upgrades and repairs keep the `generation` number in `.deft/GENERATION.json`. Only converting an old project raises it. Projects that already lost the number are not repaired. Refs #6012.
- `directive upgrade` deletes the retired `.github/workflows/deft-core-guard.yml` when it is the file Directive wrote, and keeps any other file at that path. The plan says so, and the result reminds you to remove a `deft-core-guard` required check from branch protection. Directive no longer contains code that writes this workflow. Refs #5835, #6012.
