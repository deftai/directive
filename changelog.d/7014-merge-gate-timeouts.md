section: Fixed
- A hung merge-gate run no longer holds the merge queue for 6 hours: the `task check:merge` step times out at 20 minutes, the job at 30, an ordinary run cancel now stops the lanes, and the merge-gate resolver stops at a 35-minute budget and retries transient jobs-API errors (#7014).
