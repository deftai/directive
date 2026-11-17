section: Added
- `pr:wait-mergeable-and-merge --wait`: in merge-queue mode, after enqueue or with `--resume`, the verb reads the queue every 60 seconds until the PR merges or leaves the queue, three reads in a row fail, or `--cap-minutes` passes, and reports the stop reason. Without `--wait` nothing changes (#6423).
