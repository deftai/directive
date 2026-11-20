section: Fixed
- Every runtime verb now accepts a lone `--` right after the verb, so `deft review-monitor:register -- --pr N` and `deft occupancy:release -- --session-id ...` work like the forms without `--` (#6887).
