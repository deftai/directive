section: Changed
- Refuse a one-story `scope:complete` when another merged story is still active; use live PR reads, delivery lookup for unstamped product PRs, and repo-aware `swarm:finalize-cohort` hints instead (#7252 / #7258).

- Fail closed on unstamped delivery-lookup read failures (unparseable JSON, HTTP 502, and other non-confirmed-missing errors) so one-story complete cannot under-count merged actives (#7252 / #7258).
