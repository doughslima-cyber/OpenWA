# LESSONS - auto-maintained by scripts/lessons.py

> Machine-owned. Do NOT hand-edit. Changes are overwritten on the next `lessons.py` write.
> Canonical state lives in `.specs/lessons.json`. Edit lessons only via the script.
> promote_threshold=2 distinct features · window_days=45 · quarantine_threshold=2

## Confirmed (load these at Plan/Checks)

Corroborated across multiple features. Safe to apply as guidance.

### L-002 - Prove every check that names an HTTP status with a test that crosses the HTTP boundary

- signal: `ac_gap` · recurrence: 2 feature(s) · scope: `routes` · harmful: 0
- features: meta-cloud-api, meta-cloud-dashboard
- evidence: verification.md C16, C17 - create-session.dto.spec.ts:159 (routes) (+1 more)
- last seen: 2026-10-12T17:56:11Z

## Candidates (under observation - do NOT load as guidance yet)

Seen once or not yet corroborated. Tracked, not trusted.

### L-001 - Settle a proof marked as failing on Windows by running it on an LF checkout, never by exempting it

- signal: `gate_fail` · recurrence: 1 feature(s) · scope: `sdk` · harmful: 0
- features: meta-cloud-api
- evidence: verification.md C80 - sdk/python/openwa/types.py:269 (sdk)
- last seen: 2026-10-12T02:57:01Z

### L-003 - Give every decision branch the code adds a coverage member, including default branches and errors a service raises on update routes

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `coverage` · harmful: 0
- features: meta-cloud-api
- evidence: verification.md gaps 3-7 - meta-cloud-account.service.ts:74, meta-cloud-inbound.mapper.ts:192 (coverage)
- last seen: 2026-10-12T02:57:01Z

### L-004 - Assert every column a backup or restore claims to carry, by comparing the whole restored row

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `infra` · harmful: 0
- features: meta-cloud-api
- evidence: verification.md round 3 gap 1 - src/modules/infra/meta-cloud-backup.spec.ts:126 (infra)
- last seen: 2026-10-12T04:31:23Z

### L-005 - Reclassify a file in the Test policy evidence when a fix adds a conditional to it

- signal: `spec_precision_gap` · recurrence: 1 feature(s) · scope: `coverage` · harmful: 0
- features: meta-cloud-api
- evidence: verification.md round 3 gap 2 - meta-cloud-account.controller.ts:67 (coverage)
- last seen: 2026-10-12T04:31:23Z

### L-006 - Build test fixtures from values the API can actually send, never from the database's null

- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `dashboard` · harmful: 0
- features: meta-cloud-dashboard
- evidence: verification.md fault 1 - dashboard/src/utils/sessionActions.test.ts:230 (dashboard)
- last seen: 2026-10-12T17:56:03Z

### L-007 - Prove a chat fence with an in-scope and an out-of-scope restricted key on the route itself

- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `routes` · harmful: 0
- features: meta-cloud-dashboard
- evidence: verification.md fault 2 - meta-cloud-templates.controller.ts:60 (routes)
- last seen: 2026-10-12T17:56:04Z

### L-008 - Give every fallback branch a check of its own before building it

- signal: `surviving_mutant` · recurrence: 1 feature(s) · scope: `coverage` · harmful: 0
- features: meta-cloud-dashboard
- evidence: verification.md fault 3 - meta-cloud-templates.service.ts:79 (coverage)
- last seen: 2026-10-12T17:56:04Z

### L-009 - Prove every HTTP status at the boundary

- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `routes` · harmful: 0
- features: meta-cloud-dashboard
- evidence: verification.md gap 5 - send-template 404/429/502/503 (routes)
- last seen: 2026-10-12T17:56:04Z

## Quarantined (failed when applied - ignore)

A confirmed lesson that recurred alongside failure. Kept for the maintainer to review.

_none_
