section: Added
- `deft release:run` now finishes the cut on its own after the tag: it waits for the npm publish, publishes the draft release and, only with its up-front grant, promotes `latest`. A stopped run continues with `--resume` and never repeats a finished step. The release runbook now describes this command (#6878).
