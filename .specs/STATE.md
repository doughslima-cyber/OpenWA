# Project state

## Decisions

| ID     | Decision                                                                                                                                                                                                 | Rationale                                                                                                                          | Status | Date       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| AD-001 | A session's engine is `sessions.engine`; NULL means the deployment's `ENGINE_TYPE`. Only `meta-cloud` is ever written; Baileys vs whatsapp-web.js stays per deployment                                   | existing rows keep following `ENGINE_TYPE`, and the two QR engines share on-disk credential handling (`purgeSessionData`)          | active | 2026-10-11 |
| AD-002 | Engine credentials that are not files (Cloud API tokens) live in their own table, encrypted with AES-256-GCM under a key from `.env`, never in `sessions.config`, and are excluded from `/infra` backups | `sessions.config` is served by `GET /api/sessions/:id/config` and exported; a backup must not carry a permanent sending credential | active | 2026-10-11 |
| AD-003 | A `@Public()` route that receives a provider's callbacks takes a first path segment of its own (e.g. `/api/meta-webhook`), never one shared with an SDK-covered resource                                 | `scripts/check-sdk-coverage.mjs` groups routes into resources by first path segment                                                | active | 2026-10-11 |
| AD-004 | Meta errors reach callers as fork `code` values (`META_*`) with Meta's number in `metaCode`; a send whose outcome is unknown answers 502/503, never 4xx                                                  | n8n flows branch on `code`; the send-idempotency interceptor releases a key only on 4xx/501                                        | active | 2026-10-11 |

## Handoff

**Feature**: meta-cloud-api
**Where**: S1-S5 and governance built - C1-C83 closed and committed (S5 and governance: `d3ff0df3`, `e6d5ba6b`, `f2b8b0e4`, `63526302`, `e31be1eb`)
**In progress**: none
**Next step**: orchestrator dispatches the Verifier over all 83 checks of `.specs/features/meta-cloud-api/checks.md`
**Blockers**: none for verifying; go-live waits on plan open questions 1 and 2. C69 says `kind: "direct"`, which `ChatKind` does not have; the build returns `individual` (see checks.md Handoff) and the wording needs the user's decision
**Uncommitted**: none
**Branch**: claude/tlc-spec-lean-meta-cloud-api-5902e1
