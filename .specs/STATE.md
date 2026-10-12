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
**Where**: S1-S4 built - C1-C68 closed and committed (S4: `082154ec`, `7384a2fd`)
**In progress**: none
**Next step**: next builder starts S5 (C69-C78) and the governance checks (C79-C83): the read side of `meta-cloud-chat-store.service.ts` (getChats, getChatHistory, getContactById), sendSeen and typing from `meta_cloud_contacts.lastInboundWamid`, the matrix `cloud` column, the campaigns refusal and docs/29
**Blockers**: none for building; go-live waits on plan open questions 1 and 2
**Uncommitted**: none
**Branch**: claude/tlc-spec-lean-meta-cloud-api-5902e1
