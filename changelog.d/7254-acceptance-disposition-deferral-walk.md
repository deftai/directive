section: Fixed

- Honour acceptance-disposition deferrals in the scope:complete clause walk: refuse when the grant store is unreadable or plan identifiers disagree, and require every matching clause cover to enter grantedClauses so clause-walk-failed cannot hide a missed deferral (#7254).
