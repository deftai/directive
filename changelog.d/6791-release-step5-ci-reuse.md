section: Changed
- Release Step 5 reuses green CI, with no flag or citation, when the clean release tree is identical to the fetched delivery-branch tip and the latest required checks on that tip succeeded; it prints the tip SHA and check-run URLs and runs only a short host smoke check, with no host coverage (#6791).
