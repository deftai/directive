section: Fixed
- one-pr-unit-merge-group builds the queue entry list from merge_group.head_ref plus the base..head range, loads each PR over REST, and names real API or parse failures instead of "missing constituent PR". Tracking #6424.
