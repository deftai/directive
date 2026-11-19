section: Changed
- CI: a master push whose commit the merge queue already passed in this workflow now skips the heavy jobs, and the two required aggregators report success citing that queue run and attempt. Any lookup doubt runs the full stack as before. Refs #6584.
