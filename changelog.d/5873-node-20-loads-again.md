section: Fixed
- The runtime loads on Node 20 again (best effort, AC16). Five files imported `globSync` from `node:fs`, which Node 20 lacks, so every hook and `deft` command crashed at load. They now use a helper that calls `fs.globSync` on Node 22+ and a matching fallback on Node 20. `engines` stays `>=20`. Refs #5873.
