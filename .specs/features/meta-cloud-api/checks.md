# Meta Cloud API sessions (doc 32, F1 + F2) - checks

Profile: standard
Plan: `.specs/features/meta-cloud-api/plan.md`

83 checks in 5 slices plus governance · 11 one-way doors · 2 open, of which 0 block building (both block go-live)

Proof commands, from `package.json` and `.github/workflows/ci.yml`:

- unit lane: `npx jest <file> -t "<title>"`
- docs/governance lane (excluded from the unit lane): `npx jest <file> --testPathIgnorePatterns=/node_modules/`, flag last
- e2e lane (CI runs `npm run test:e2e`): `npx jest --config ./test/jest-e2e.json <file> -t "<title>"`
- Test titles start with the check id (`C12 ...`), as the campaign feature's specs do. A selector is scoped by its
  file, so ids from earlier features do not collide.

The e2e suites point the real adapter at a fake Graph server: a local `http` server on 127.0.0.1 whose port goes
into `META_GRAPH_BASE_URL` before `AppModule` is imported. The server records every request (method, path, headers,
body) and answers from a per-test script. The webhook suite calls `configureApp(app)`, so the raw body is captured
the way `main.ts` captures it.

## Checks

### S1 - Per-session engine, QR sessions unchanged · 20 files · ~240 KB · ~60k

**C1** - `GET /api/sessions` and `GET /api/sessions/:id` return `engine: "baileys"` for a row whose `engine` is NULL under `ENGINE_TYPE=baileys`, and `engine: "meta-cloud"` for a `meta-cloud` row (ENG-01, AC 1) ✅
Proof: `npx jest src/modules/session/dto/session-response.dto.spec.ts -t "C1 "`
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C1 "`

**C2** - Starting a session whose `engine` is NULL creates its engine from the `ENGINE_TYPE` plugin, and the lifecycle passes the row's `engine` (here `undefined`) to `EngineFactory.create` (ENG-01, AC 2) ✅
Proof: `npx jest src/engine/engine.factory.spec.ts -t "C2 "`
Proof: `npx jest src/modules/session/session-engine-lifecycle-engine-select.spec.ts -t "C2 "`

**C3** - With `ENGINE_TYPE=baileys`, a row whose `engine` is `meta-cloud` gets its engine from the `meta-cloud` plugin's `createEngine`, and the Baileys plugin's `createEngine` is not called (ENG-01, AC 3) ✅
Proof: `npx jest src/engine/engine.factory.spec.ts -t "C3 "`
Proof: `npx jest src/modules/session/session-engine-lifecycle-engine-select.spec.ts -t "C3 "`

**C4** - `POST /api/sessions` with `engine` set to each of `baileys`, `whatsapp-web.js`, `META-CLOUD` and `""` answers 400 and the `sessions` table count is unchanged (ENG-01, AC 4) ✅
Proof: `npx jest src/modules/session/dto/create-session.dto.spec.ts -t "C4 "`
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C4 "`

**C5** - With `META_CLOUD_ENABLED` unset, and again with it set to `false`, `POST /api/sessions` with a complete `meta-cloud` body answers 400 with `code: "META_CLOUD_DISABLED"` and the `sessions` table count is unchanged (ENG-01, AC 5) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-disabled.e2e-spec.ts -t "C5 "`

**C6** - On `onModuleInit` with `META_CLOUD_ENABLED=true` and `ENGINE_TYPE=baileys`, both `baileys` and `meta-cloud` are enabled; with `META_CLOUD_ENABLED` unset, `meta-cloud` is registered but not enabled (ENG-01, AC 6) ✅
Proof: `npx jest src/engine/engine.factory.spec.ts -t "C6 "`

**C7** - With `META_CLOUD_ENABLED=true`, `PluginsService.disablePlugin('meta-cloud')` returns `success: false` and `isPluginEnabled('meta-cloud')` stays `true`; the existing refusal for the `ENGINE_TYPE` plugin is unchanged (ENG-01, AC 7) ✅
Proof: `npx jest src/modules/plugins/plugins.service.spec.ts -t "C7 "`

**C8** - `AddSessionEngine` adds `sessions.engine` as nullable `varchar(30)` with no default; after `up` on a database holding two session rows, both rows have `engine` NULL; `down` removes the column and keeps the rows (ENG-01, AC 8 · door 1) ✅
Proof: `npx jest src/database/migrations/__tests__/1791300000000-AddSessionEngine.spec.ts -t "C8 "`

**C9** - `ENGINE_TYPE=meta-cloud` fails boot validation, and `whatsapp-web.js` and `baileys` still pass (door 2) ✅
Proof: `npx jest src/config/env.validation.spec.ts -t "C9 "`

**C10** - `GET /api/infra/engines` (`getAvailableEngines()`) lists `meta-cloud` with `enabled: true` and `library.name: "whatsapp-cloud-api"` when `META_CLOUD_ENABLED=true` (door 11) ✅
Proof: `npx jest src/engine/engine.factory.spec.ts -t "C10 "`

### S2 - Connect a Cloud session · 18 files · ~260 KB · ~65k

**C11** - `POST /api/sessions` with `engine: "meta-cloud"` and a complete `metaCloud` answers 201 with `engine: "meta-cloud"`; one `sessions` row and one `meta_cloud_accounts` row exist with the given `phoneNumberId` and `wabaId` (MCA-01, AC 9) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C11 "`

**C12** - When the account insert throws inside the create, no `sessions` row is left behind (MCA-01, AC 9) ✅
Proof: `npx jest src/modules/meta-cloud/meta-cloud-account.service.spec.ts -t "C12 "`

**C13** - The cipher writes `v1.<iv>.<tag>.<ciphertext>` (four dot-separated parts, base64url, 12-byte IV, 16-byte tag), never equal to and never containing the plaintext; it decrypts back to the plaintext; changing one byte of the tag, IV or ciphertext throws; decrypting with another 32-byte key throws (MCA-01, AC 10 · door 4) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-crypto.spec.ts -t "C13 "`

**C14** - The stored `accessTokenEnc` of the C11 row differs from the submitted token and decrypts to it with the suite's key (MCA-01, AC 10) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C14 "`

**C15** - With `META_CLOUD_ENCRYPTION_KEY` unset, non-base64, decoding to 31 bytes, and decoding to 33 bytes, the create answers 400 with `code: "META_CLOUD_NOT_CONFIGURED"` and no row is written (MCA-01, AC 11) ✅
Proof: `npx jest src/modules/meta-cloud/meta-cloud-account.service.spec.ts -t "C15 "`
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C15 "`

**C16** - With `engine: "meta-cloud"`, the cases `metaCloud` missing, `phoneNumberId: ""`, `wabaId: ""` and `accessToken: ""` each answer 400 and write no row (MCA-01, AC 12) ✅
Proof: `npx jest src/modules/session/dto/create-session.dto.spec.ts -t "C16 "`

**C17** - `metaCloud` present with no `engine` answers 400 and writes no row (MCA-01, AC 13) ✅
Proof: `npx jest src/modules/session/dto/create-session.dto.spec.ts -t "C17 "`

**C18** - A second create with a `phoneNumberId` already bound answers 409 with `code: "META_PHONE_NUMBER_IN_USE"` and the `sessions` count is unchanged (MCA-01, AC 14 · door 3) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C18 "`

**C19** - Two creates for the same `phoneNumberId` sent at once end with exactly one 201 and one 409 `META_PHONE_NUMBER_IN_USE`, and exactly one `meta_cloud_accounts` row (MCA-01, AC 14 · door 3) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C19 "`

**C20** - Across the bodies of create, `GET /api/sessions`, `GET /api/sessions/:id`, `GET /api/sessions/:id/config`, `GET` and `PUT .../meta/account`, no body contains the token or any 8-character substring of it (MCA-01, AC 15) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C20 "`

**C21** - When Graph answers 401 with code `190` and an error body that echoes the request, and when it times out, every logger call made by the Graph client and the account service carries no 8-character substring of the token (MCA-01, AC 15) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-graph.client.spec.ts -t "C21 "`

**C22** - `initialize()` against a Graph that answers `GET /<PHONE_NUMBER_ID>` with `display_phone_number: "+55 11 99999-0000"` and `verified_name: "Acme"` calls `POST /<WABA_ID>/subscribed_apps` once, then `onReady("5511999990000", "Acme")` (MCA-02, AC 16) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C22 "`

**C23** - Starting the C11 session moves it to `READY` with `phone: "5511999990000"` and `pushName: "Acme"` (MCA-02, AC 16) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C23 "`

**C24** - During `initialize()` the adapter never calls `onQRCode` and never reports `EngineStatus.QR_READY`, and `getQRCode()` resolves `null` (MCA-02, AC 17) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C24 "`

**C25** - For each Graph error code `190`, `10` and `200`, answered to `initialize()` and to `probeLiveness()` (6 cases), the adapter calls `onActionRequired("META_TOKEN_INVALID")` and reports `EngineStatus.ACTION_REQUIRED`, and does not call `onReady` (MCA-02, AC 18) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C25 "`

**C26** - With no stored token, `initialize()` calls `onActionRequired("META_TOKEN_MISSING")`, reports `ACTION_REQUIRED`, and the fake Graph records zero requests (MCA-02, AC 19) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C26 "`

**C27** - When Graph refuses the connection, and when it answers 500, `initialize()` rejects with an `EngineTransportError` and never calls `onReady`; through the API the session ends in a status other than `READY` with `lastError` set (MCA-02, AC 20) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C27 "`
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C27 "`

**C28** - `probeLiveness()` returns `true` for a 200 and `false` for a refused connection, a 500 and a 503 (MCA-02, AC 21) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C28 "`

**C29** - `POST /api/sessions/:id/pairing-code` on a `meta-cloud` session answers 501 (MCA-02, AC 22) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C29 "`

**C30** - `GET /api/sessions/:id/meta/account` answers 200 with exactly the keys `phoneNumberId`, `wabaId`, `displayPhoneNumber`, `verifiedName`, `qualityRating`, `messagingLimitTier`, `accessTokenLast4`, `webhookUrl`; `accessTokenLast4` equals the token's last 4 characters, and `webhookUrl` ends with `/api/meta-webhook` (MCA-03, AC 23) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C30 "`

**C31** - `GET` and `PUT /api/sessions/:id/meta/account` on a session whose `engine` is NULL answer 501, and on an unknown session id answer 404 (MCA-03, AC 24) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C31 "`

**C32** - `PUT .../meta/account` with a new `accessToken` answers 200 with the new `accessTokenLast4`, and the session's next Graph request, recorded by the fake server, carries `Authorization: Bearer <new token>` (MCA-03, AC 25) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C32 "`

**C33** - `PUT .../meta/account` with no `accessToken`, with an empty one, and with an extra `phoneNumberId` key each answers 400 and leaves the stored token unchanged (MCA-03, Surface) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C33 "`

**C34** - `logout()` sets the account's `accessTokenEnc` to NULL and reports `EngineStatus.DISCONNECTED` (MCA-03, AC 26) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C34 "`

**C35** - `DELETE /api/sessions/:id` on a `meta-cloud` session with one contact row leaves zero `meta_cloud_accounts` and zero `meta_cloud_contacts` rows for that id (MCA-03, AC 27 · doors 3, 5) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C35 "`

**C36** - `AddMetaCloudTables` creates `meta_cloud_accounts` (PK `sessionId`, FK to `sessions(id)` `ON DELETE CASCADE`, unique index `UQ_meta_cloud_accounts_phoneNumberId`) and `meta_cloud_contacts` (FK `ON DELETE CASCADE`, unique index `UQ_meta_cloud_contacts_sessionId_waId`); `down` drops both (doors 3, 5) ✅
Proof: `npx jest src/database/migrations/__tests__/1791400000000-AddMetaCloudTables.spec.ts -t "C36 "`

### S3 - Send through the Cloud API · 10 files · ~180 KB · ~45k

**C37** - `sendTextMessage("5511988887777@c.us", "hi")` posts to `/v26.0/<PHONE_NUMBER_ID>/messages` the body `{ messaging_product: "whatsapp", recipient_type: "individual", to: "5511988887777", type: "text", text: { body: "hi", preview_url: false } }` and returns `{ id: <wamid> }` (MCS-01, AC 28 · door 10) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C37 "`

**C38** - `POST .../messages/send-text` on a `READY` Cloud session answers with `messageId` equal to the fake Graph's `wamid`, the stored message has that `waMessageId` and status `sent`, and `WebhookService.dispatch` is called with `message.sent` exactly once for it (MCS-01, AC 28, 29) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-send.e2e-spec.ts -t "C38 "`

**C39** - For each of image, video, audio, document and sticker (5 cases), the adapter first posts multipart to `/<PHONE_NUMBER_ID>/media`, then sends `type: <kind>` with `<kind>.id` equal to the returned media id, and no request body contains a `link` key; a voice note (PTT) is sent as `type: "audio"` (MCS-01, AC 30) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C39 "`

**C40** - `send-image` on a Cloud session reaches the fake Graph as one `/media` upload followed by one `/messages` call (MCS-01, AC 30) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-send.e2e-spec.ts -t "C40 "`

**C41** - `sendLocationMessage` sends `type: "location"` with `latitude`, `longitude`, `name` and `address`; `sendContactMessage` sends `type: "contacts"`; `replyToMessage` sends the reply's type with `context.message_id` set to the quoted `wamid`; `reactToMessage` sends `type: "reaction"` with `message_id` and `emoji` (4 cases) (MCS-01, AC 31) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C41 "`

**C42** - With `SEND_PACING_ENABLED=true` and a daily cap of 1, `assertSendAllowed` admits a `meta-cloud` session a second time and records nothing against it, while a NULL-engine session is refused with `SEND_PACING_LIMITED` (MCS-01, AC 32) ✅
Proof: `npx jest src/modules/message/send-pacing.service.spec.ts -t "C42 "`

**C43** - With `SEND_PACING_ENABLED=true` and a daily cap of 1, two `send-text` calls on a Cloud session both answer 201 (MCS-01, AC 32) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-send.e2e-spec.ts -t "C43 "`

**C44** - The Graph client maps each of the 16 Meta error codes in the plan's table (`190`, `10`, `200`, `131005`, `131047`, `131048`, `131049`, `131056`, `130429` after retries, `131026`, `131021`, `131008`, `131009`, `133010`, `131031`, an unlisted `100`) plus a bare Graph 500 (17 cases) to the row's HTTP status and `code`, with `metaCode` and `fbtraceId` in the response body (MCS-02, AC 33 · door 9) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-graph.client.spec.ts -t "C44 "`

**C45** - `send-text` against a fake Graph answering `131047` returns 409 with `code: "META_OUTSIDE_SERVICE_WINDOW"` and `metaCode: 131047` (MCS-02, AC 33) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-send.e2e-spec.ts -t "C45 "`

**C46** - On `130429`, the client makes exactly 3 attempts in total and then raises 429 `META_RATE_LIMITED`; when the second attempt succeeds, it makes exactly 2 attempts and returns the `wamid` (MCS-02, AC 34) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-graph.client.spec.ts -t "C46 "`

**C47** - With `META_CLOUD_MAX_RPS=2` and fake timers, three calls for one phone number all resolve; the third starts no earlier than 1000 ms after the first; a call for a second phone number in the same second is not delayed (MCS-02, AC 35) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-graph.client.spec.ts -t "C47 "`

**C48** - A call that outlives `META_CLOUD_TIMEOUT_MS` is aborted and raises an `EngineTransportError` (503); a refused connection raises the same (MCS-02, AC 36) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-graph.client.spec.ts -t "C48 "`

### S4 - Receive through the Meta webhook · 12 files · ~170 KB · ~43k

**C49** - `GET /api/meta-webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=1158201444` answers 200 with `Content-Type: text/plain` and body exactly `1158201444` (MCW-01, AC 37) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C49 "`

**C50** - `hub.mode=unsubscribe` with the right token, a wrong token, and the right token while `META_WEBHOOK_VERIFY_TOKEN` is unset (3 cases) each answer 403 (MCW-01, AC 38) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C50 "`

**C51** - The signature check accepts `sha256=<hex HMAC-SHA256 of the raw body under META_APP_SECRET>` and rejects: no header, a header without the `sha256=` prefix, an HMAC under another secret, an HMAC of the re-serialized JSON, and a header of different length (5 cases) (MCW-01, AC 39) ✅
Proof: `npx jest src/modules/meta-cloud/meta-cloud-webhook-signature.spec.ts -t "C51 "`

**C52** - A `POST /api/meta-webhook` with no signature, and one signed with another secret, each answer 401 and `WebhookService.dispatch` is not called (MCW-01, AC 39) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C52 "`

**C53** - With `META_APP_SECRET` unset, two `POST /api/meta-webhook` requests both answer 503, and the controller's logger records the cause exactly once (MCW-01, AC 40) ✅
Proof: `npx jest src/modules/meta-cloud/meta-cloud-webhook.controller.spec.ts -t "C53 "`

**C54** - With `META_CLOUD_ENABLED` unset, `GET` and `POST /api/meta-webhook` each answer 404 (MCW-01, AC 41) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-disabled.e2e-spec.ts -t "C54 "`

**C55** - With a router whose `handle()` returns a promise that never settles, and with one that rejects, a signed POST still answers 200, and the rejection reaches no unhandled-rejection listener (MCW-01, AC 42) ✅
Proof: `npx jest src/modules/meta-cloud/meta-cloud-webhook.controller.spec.ts -t "C55 "`

**C56** - 30 signed POSTs from one client within one second all answer 200 (the global `short` tier allows 10) (door 6) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C56 "`

**C57** - A signed inbound-text fixture for the live session's `phone_number_id` leads to one `message.received` dispatch whose payload has `id` the fixture's `wamid`, `chatId` and `from` `"5511988887777@c.us"`, `body` the text, and the sender name from `contacts[0].profile.name` (MCW-02, AC 43 · door 10) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C57 "`

**C58** - The inbound mapper turns each of the 14 fixtures into the expected neutral message: `text` → text; `image`, `video`, `audio`, `document`, `sticker` → the same type with the media id kept for download; `location` → location; `contacts` → contact; `reaction` → a reaction event; `interactive.button_reply`, `interactive.list_reply` and `button` → `button: { id, text }`; `unsupported`, and a message carrying `errors`, → type `unknown` with the reason in `metadata`. Every `chatId` ends in `@c.us` (MCW-02, AC 43, 44, 45, 46, 47) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-inbound.mapper.spec.ts -t "C58 "`

**C59** - An inbound image is fetched with `GET /<MEDIA_ID>` and then from the returned URL, both with `Authorization: Bearer <token>`; an image whose `file_size` exceeds `MEDIA_DOWNLOAD_MAX_BYTES` is delivered without a download, through the existing `capInboundMedia` path (MCW-02, AC 44) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-media.spec.ts -t "C59 "`

**C60** - A signed `reaction` fixture leads to one `message.reaction` dispatch for the reacted `wamid` with the emoji (MCW-02, AC 45) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C60 "`

**C61** - The mapper turns `statuses[]` entries `sent`, `delivered`, `read` and `failed` (4 cases) into `onMessageAck(wamid, status, "<recipient_id>@c.us")`, the `failed` one carrying `errors[0].code` (MCW-02, AC 48, 49) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-inbound.mapper.spec.ts -t "C61 "`

**C62** - After the C38 send, a signed `delivered` status for its `wamid` leads to one `message.ack` dispatch with `delivered`, and the row's status becomes `delivered` (MCW-02, AC 48) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C62 "`

**C63** - A signed `failed` status with `errors[0].code: 131026` sets the row to `failed` and leads to one `message.failed` dispatch carrying `131026` (MCW-02, AC 49) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C63 "`

**C64** - The same signed inbound fixture posted twice leaves one `messages` row and one `message.received` dispatch (MCW-02, AC 50) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C64 "`

**C65** - A `read` status posted before the `delivered` status of the same `wamid` leaves the row at `read` (MCW-02, AC 51) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C65 "`

**C66** - A signed body whose `phone_number_id` matches no live session answers 200 and dispatches nothing; the router logs a warning naming that `phone_number_id` (MCW-02, AC 52 · door 7) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C66 "`
Proof: `npx jest src/modules/meta-cloud/meta-cloud-router.service.spec.ts -t "C66 "`

**C67** - A body with 2 `entry[]` of 2 `changes[]` each, all for live sessions, leads to 4 adapter deliveries in order; a change whose `field` is `account_update` is skipped without stopping the rest (MCW-02, AC 53) ✅
Proof: `npx jest src/modules/meta-cloud/meta-cloud-router.service.spec.ts -t "C67 "`

**C68** - After one inbound message, `meta_cloud_contacts` holds one row for the session and `wa_id` with the profile name, `lastInboundAt` and `lastInboundWamid`; a second message from the same `wa_id` updates that row and adds none (MCW-02, AC 54 · door 5) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-chat-store.service.spec.ts -t "C68 "`

### S5 - Read side and refusals · 12 files · ~260 KB · ~65k

**C69** - With stored messages in 3 chats, `getChats()` returns 3 summaries, each with `kind: "direct"`, the last message text, the chat name and `unreadCount` equal to the inbound messages newer than that chat's last `sendSeen` (a chat never seen counts all its inbound; a chat seen after its last inbound counts 0) (MCR-01, AC 55) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-chat-store.service.spec.ts -t "C69 "`

**C70** - `GET /api/sessions/:id/chats` on a Cloud session, after the C57 inbound message, returns one chat for `5511988887777@c.us` with `unreadCount: 1` (MCR-01, AC 55) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-webhook.e2e-spec.ts -t "C70 "`

**C71** - With 5 stored messages in a chat, `getChatHistory(chatId, { limit: 3 })` returns the 3 newest, ordered oldest first (MCR-01, AC 56) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-chat-store.service.spec.ts -t "C71 "`

**C72** - `getContactById` returns the stored profile name for a known `@c.us` id and `null` for an unknown one (MCR-01, AC 57) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-chat-store.service.spec.ts -t "C72 "`

**C73** - `sendSeen(chatId)` posts `{ messaging_product: "whatsapp", status: "read", message_id: <lastInboundWamid> }` and records the chat as seen (MCR-01, AC 58) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C73 "`

**C74** - `sendChatState(chatId, 'typing')` with a recorded `lastInboundWamid` posts `status: "read"`, that `message_id` and `typing_indicator: { type: "text" }`; with none recorded it resolves and the fake Graph records zero requests (MCR-01, AC 59) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C74 "`

**C75** - For every method the matrix's `cloud` column marks `not-available` (table-driven over the column, size asserted equal to the column's count), the adapter rejects with `EngineNotSupportedError`; `engine-parity.spec.ts` holds for the `cloud` key with prefix `meta-cloud-` (MCR-01, AC 60 · door 2) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C75 "`
Proof: `npx jest src/engine/engine-parity.spec.ts -t "throws ⇔ not-available|every adapter file is attributed to an engine|matrix keys exactly match" --testPathIgnorePatterns=/node_modules/`

**C76** - `GET /api/sessions/:id/groups` on a Cloud session answers 501 (MCR-01, AC 60) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-session.e2e-spec.ts -t "C76 "`

**C77** - `POST /api/sessions/:id/campaigns` on a `meta-cloud` session answers 400 with `code: "CAMPAIGN_ENGINE_UNSUPPORTED"` and the `campaigns` table count is unchanged (MCR-01, AC 61) ✅
Proof: `npx jest src/modules/campaign/campaigns.controller.http.spec.ts -t "C77 "`

**C78** - `docs/29` publishes the `cloud` column with counts equal to the matrix, and its inventory marks hold (MCR-01, AC 62) ✅
Proof: `npx jest src/engine/docs-29-counts.spec.ts -t "docs/29 counts match the capability matrix" --testPathIgnorePatterns=/node_modules/`
Proof: `npx jest src/engine/engine-inventory-parity.spec.ts -t "exposure mark" --testPathIgnorePatterns=/node_modules/`

### Governance - what the repo's gates require of each new route, table and variable · 25 files · ~150 KB · ~38k

**C79** - Every new route has a `#### METHOD /api/...` heading in `docs/06` whose `**Errors:**` names each declared 409/429/5xx; `openapi.json` is regenerated and current; `@Public()` webhook routes are in `PUBLIC_PATHS` and both lists of `swagger.config.spec.ts`; the account routes carry `@RequireUnscopedKey()` (Surface, doors 6, 8, 9) ✅
Proof: `npx jest src/common/openapi/docs-06-contract.spec.ts -t "documents every contract operation|documents every route-specific status code" --testPathIgnorePatterns=/node_modules/`
Proof: `npx jest src/modules/auth/global-route-fence-coverage.spec.ts -t "no real controller exposes an unfenced deployment-global route" --testPathIgnorePatterns=/node_modules/`
Proof: `npx jest src/config/swagger.config.spec.ts -t "EXPECTED_PUBLIC_CONTROLLERS|PUBLIC_PATHS is exactly the expected"`
Proof: `npm run openapi:export && git diff --exit-code openapi.json`

**C80** - SDK coverage and routes pass with `meta` and `meta-webhook` in the "Deliberately not exposed" list of `sdk/README.md` and `docs/18`; the `engine` field on the session shape is in each SDK's hand-written types (Surface, door 8) ✅
Proof: `npm run check:sdk-routes`
Proof: `npm run check:sdk-coverage`
Proof: `npm run check:contract-shapes` (fails on Windows with or without this change, per `AGENTS.md`; settled on Ubuntu CI or against a stashed-tree baseline)

**C81** - Both new tables are excluded from the `/infra` export with a reason, and the export registry, importers and DTO keys still agree (Impact - stored data) ✅
Proof: `npx jest src/modules/infra/export-tables.parity.spec.ts -t "exports or explicitly excludes every data-connection entity table|gives every exclusion a one-line reason"`

**C82** - Both migrations are listed under "Migration Files" in `docs/05`, and the entity DDL (`engine` column, both tables, both named unique indexes) matches the migrations exactly (doors 1, 3, 5) ✅
Proof: `npx jest src/database/migrations/__tests__/migration-drift.spec.ts -t "data connection: drift is EXACTLY the pinned set" --testPathIgnorePatterns=/node_modules/`
Proof: `npx jest src/database/docs-schema-accuracy.spec.ts -t "lists every migration file under Migration Files"`

**C83** - The 8 new variables are in `.env.example` (commented out), as `- KEY=${KEY:-}` in `docker-compose.yml` and `docker-compose.dev.yml`, and in `BLANK_SHADOWED_ENV_KEYS` (Impact - configuration) ✅
Proof: `npx jest src/config/docs-env-example.spec.ts -t "lists every key the validator, the precedence list or compose knows about" --testPathIgnorePatterns=/node_modules/`
Proof: `npx jest src/config/env-precedence.spec.ts -t "C83 "`

## Coverage

| Set (size)                                                                | Member -> proof                                                                                                                                                                       | Unproven |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `POST /api/sessions` statuses (3)                                         | 201 C11 · 400 C4, C5, C15, C16, C17 · 409 C18, C19                                                                                                                                    | -        |
| `GET /api/sessions`, `GET /api/sessions/:id` statuses (2)                 | 200 C1 · 404 C31 (unknown id, existing lookup)                                                                                                                                        | -        |
| `GET /api/sessions/:id/meta/account` statuses (3)                         | 200 C30 · 404 C31 · 501 C31                                                                                                                                                           | -        |
| `PUT /api/sessions/:id/meta/account` statuses (4)                         | 200 C32 · 400 C33 · 404 C31 · 501 C31                                                                                                                                                 | -        |
| `GET /api/meta-webhook` statuses (3)                                      | 200 C49 · 403 C50 · 404 C54                                                                                                                                                           | -        |
| `POST /api/meta-webhook` statuses (4)                                     | 200 C55, C56, C57 · 401 C52 · 404 C54 · 503 C53                                                                                                                                       | -        |
| `/api/sessions/:id/messages/send-*` statuses added for Cloud sessions (6) | 400 C44 · 409 C44, C45 · 429 C44, C46 · 501 C75 · 502 C44 · 503 C48                                                                                                                   | -        |
| `POST /api/sessions/:id/campaigns` status added (1)                       | 400 C77                                                                                                                                                                               | -        |
| Meta error table (17 cases)                                               | C44, table-driven over all 17; boundary row 131047 C45                                                                                                                                | -        |
| `engine` request values (5)                                               | `meta-cloud` C11 · `baileys` C4 · `whatsapp-web.js` C4 · `META-CLOUD` C4 · `""` C4                                                                                                    | -        |
| `metaCloud` field presence (4)                                            | missing C16 · `phoneNumberId` empty C16 · `wabaId` empty C16 · `accessToken` empty C16                                                                                                | -        |
| encryption key shapes (5)                                                 | valid C11 · unset C15 · non-base64 C15 · 31 bytes C15 · 33 bytes C15                                                                                                                  | -        |
| token-invalid Graph codes x entry point (6)                               | `190` start C25 · `10` start C25 · `200` start C25 · `190` probe C25 · `10` probe C25 · `200` probe C25                                                                               | -        |
| `probeLiveness` outcomes (5)                                              | 200 C28 · refused C28 · 500 C28 · 503 C28 · 190 C25                                                                                                                                   | -        |
| session states a Cloud session enters (4)                                 | `READY` C22, C23 · `ACTION_REQUIRED` C25, C26 · `DISCONNECTED` C34 · not `READY` on start failure C27                                                                                 | -        |
| outbound kinds (11)                                                       | text C37 · image C39, C40 · video C39 · audio C39 · PTT C39 · document C39 · sticker C39 · location C41 · contacts C41 · reply C41 · reaction C41                                     | -        |
| inbound message types (14)                                                | C58, table-driven over all 14 fixtures                                                                                                                                                | -        |
| inbound status values (4)                                                 | C61, table-driven; boundary `delivered` C62 · `failed` C63 · `read` C65                                                                                                               | -        |
| webhook signature outcomes (6)                                            | valid C51 · no header C51, C52 · no prefix C51 · other secret C51, C52 · re-serialized body C51 · length mismatch C51                                                                 | -        |
| verify-handshake outcomes (4)                                             | match C49 · other mode C50 · wrong token C50 · token unset C50                                                                                                                        | -        |
| webhook change routing (3)                                                | live session C57 · unknown `phone_number_id` C66 · non-`messages` field C67                                                                                                           | -        |
| read-side methods served from the store (5)                               | `getChats` C69, C70 · `getChatHistory` C71 · `getContactById` C72 · `sendSeen` C73 · `sendChatState` C74                                                                              | -        |
| not-available methods of the `cloud` column (1 table)                     | C75, one `it.each` over the whole column, its size asserted equal to the matrix's count                                                                                               | -        |
| Landing doors (11)                                                        | 1 C8, C82 · 2 C3, C9, C75 · 3 C18, C19, C35, C36 · 4 C13, C14 · 5 C36, C68 · 6 C49, C56, C79 · 7 C52, C53, C54, C66 · 8 C1, C11, C80 · 9 C44, C79 · 10 C37, C57, C58 · 11 C6, C7, C10 | -        |
| Relations entities (3)                                                    | `Session.engine` C8 · `MetaCloudAccount` C36, C35 · `MetaCloudContact` C36, C68                                                                                                       | -        |
| startup config: `META_CLOUD_ENABLED` read at boot (2 places)              | factory `onModuleInit` C6 · webhook/create gate C5, C54                                                                                                                               | -        |
| startup config: raw request body (1 shared assembly)                      | `configureApp`, used by `main.ts:156` and by the webhook e2e suite, C52, C57                                                                                                          | -        |
| startup config: new variables (4 places)                                  | `.env.example` C83 · `docker-compose.yml` C83 · `docker-compose.dev.yml` C83 · `BLANK_SHADOWED_ENV_KEYS` C83                                                                          | -        |

- Claims naming a status code, route or response shape: C1, C4, C5, C11, C15, C18, C19, C20, C29, C30, C31,
  C32, C33, C38, C40, C43, C45, C49, C50, C52, C54, C56, C57, C60, C62, C63, C64, C65, C66, C70, C76, C77. Each has
  a proof that crosses the HTTP boundary. C53 and C55 are proven at the controller with a real Nest testing
  module, because the log count and the never-settling router are not reachable from supertest.
- C44 (17 rows) and C58 (14 rows) are decision tables proven at their own layer, each with one boundary row
  (C45; C57, C60) that crosses HTTP. No other check claims more than the cases its proof lists.

## Test policy

`docs/09-testing-strategy.md` §9.7 answers which level proves which code: business logic and error mapping
in unit specs, wiring, guards, pipes and route-level behaviour in e2e. It does not say how much of a decision
table a proof must assert, so these rows are the bar this build runs under.

| Code                                   | Required proofs                                  | Coverage expectation                                                                           |
| -------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Decides, reached across a boundary     | one at the boundary **and** one at its own layer | the contract at the boundary; one asserted case per row of the decision table at its own layer |
| Decides, not reached across a boundary | one at its own layer                             | one asserted case per row of the decision table                                                |
| Entry point that decides nothing       | one at the boundary                              | accepted input, each rejected input, each error path                                           |
| Instrumentation, pass-throughs         | none of its own                                  | covered by its consumer's proof                                                                |

Evidence (planned files, classified by the shape the plan fixes):

- `meta-cloud-graph.client.ts`: maps 16 Meta codes plus a 5xx onto 8 outcomes, plus retry, rate limit and
  timeout branches, about 12 branch points -> decides, reached across a boundary (C44 at its layer, C45 at HTTP)
- `meta-cloud-inbound.mapper.ts`: dispatches over 14 message types and 4 status values -> decides, reached
  across a boundary (C58, C61 at its layer; C57, C60, C62, C63 at HTTP)
- `meta-cloud-webhook.controller.ts` with its signature check: 4 verify outcomes, 6 signature outcomes, 2 gates
  (enabled, secret set) -> decides, reached across a boundary (C49-C54)
- `meta-cloud-router.service.ts`: 3 routing outcomes -> decides (C66, C67)
- `meta-cloud-chat-store.service.ts`: grouping and unread rule, 3 branch points -> decides, not reached by a
  boundary proof except C70
- `meta-cloud-crypto.ts`: format and tamper detection -> decides (C13)
- `meta-cloud-adapter.ts` send bodies: one payload shape per kind, 11 kinds -> decides (C37, C39, C41)
- the account controller's GET: maps a row onto a DTO, no conditional -> instrumentation (proven through C30)
- closest analogues in the repo: `src/engine/adapters/baileys-message-mapper.spec.ts` (`it.each` over message
  types, 91 cases) and `src/modules/integration/ingress-signature.spec.ts` (signature outcomes at their own layer,
  plus `test/integration-fabric.e2e-spec.ts` at HTTP)

Cost: 7 unit spec files at their own layer. Without these rows, the error table, the inbound mapper and the
signature check are proven only by the one path each e2e test happens to take.

## Swept

- validation: C4, C15, C16, C17, C33, C51
- failure modes: C12, C27, C48, C55
- idempotency: C64, C65; a 4xx/501 send releases its idempotency key and a 502/503 is kept as unknown (existing -
  `send-idempotency.interceptor.ts:31`, which the 4xx/429/502/503 statuses of C44 and C48 were chosen to fit)
- authorization: C51, C52, C50 (webhook); existing - `@RequireUnscopedKey()` on create and on the account routes
  (C79 holds the fence)
- concurrency: C19 (two creates for one number), C47 (per-number rate limiter), C65 (status order)
- data lifecycle: C34 (logout clears the token), C35 (delete cascades), C81 (backup exclusion)
- dependency failure: C27, C28, C46, C48
- state transitions: C22, C25, C26, C27, C34
- observability: C53 (secret unset, logged once), C66 (dropped change logged); metrics are doc 32 F5

## Handoff

Intended split, with the arithmetic, written before any code. Budget 150k tokens (default; `AGENTS.md`
declares none). Each slice estimate is the `wc -c` of the files it reads or edits, with partial reads counted
for the large files (`session-engine-lifecycle.service.ts` 83 KB read at ~20 KB, `docs/06` 546 KB and
`docs/29` 146 KB edited by section, `openapi.json` 956 KB generated, never read), divided by four.

- S1 ~60k + S2 ~65k = 125k; adding S3 (~45k) reaches 170k -> builder A: S1, S2 (engine per session, then the
  Cloud session's lifecycle and account routes)
- S3 ~45k + S4 ~43k = 88k; adding S5 (~65k) reaches 153k -> builder B: S3, S4 (send and receive)
- S5 ~65k + governance ~38k = 103k -> builder C: S5 and C79-C83, the matrix, docs/29 and every repo gate

Builder A's first commit brings `docs/32-meta-cloud-api.md` into this branch from the
`meta-official-api-plan-32d1eb` worktree, with the five corrections listed in the plan's Sources.

- Boundary: C1-C10 closed at `8ebe86fd` (S1 done; S2 starts at C11).
- Settled mid-build: nothing by the user. Builder decisions below the Landing bar: `POST /api/sessions` already declares `metaCloud` (`MetaCloudCredentialsDto`, three non-empty strings) because C5 sends a complete body through `forbidNonWhitelisted`; the cross-field rules of C16/C17 and the account insert are still S2. The create path with `META_CLOUD_ENABLED=true` writes a `meta-cloud` row and drops `metaCloud`, and the plugin returns a `MetaCloudAdapter` placeholder that answers 501 to every method. The factory refuses to start a `meta-cloud` row while the flag is off. `SessionResponseDto.engine` reads `ENGINE_TYPE` the way `configuration.ts` does (`src/engine/session-engine.ts`). `meta-cloud-adapter.ts` is attributed to no QR engine in `engine-parity.spec.ts` until S5 adds the `cloud` column. Landing row 12 (SDK names) added; the five SDK hand types already carry `engine`/`metaCloud`.
- Abandoned: none.
- Boundary: C11-C36 closed at `39036f01` (S2 done; S3 starts at C37).
- Settled mid-build: nothing by the user. Builder decisions below the Landing bar: the Graph client (`meta-cloud-graph.client.ts`) has only what S2 needs: `request()` over `fetch` with `AbortSignal.timeout`, EngineTransportError on no answer, `MetaGraphError` (httpStatus, metaCode, subcode, type, fbtraceId) on a non-2xx, and `redactSecret` scrubbing the token from Meta's message; config read per call (`resolveMetaGraphConfig`), so tests point it at `src/engine/adapters/__fixtures__/fake-graph-server.ts`. The adapter reads the account through `MetaCloudAccountStore` (engine module, `MetaCloudAccountPort`) on every Graph call, so a rotated token reaches the next call with no cache to invalidate; an unreadable token (key unset or changed) counts as missing. A non-token Graph 4xx at start rejects with 502 `META_UPSTREAM_ERROR`; a refused token on probe answers `true` (ACTION_REQUIRED, not dead). The create transaction lives in `MetaCloudAccountService.createSession` (fork module, imported by SessionModule, injected `@Optional` into SessionService); `webhookUrl` is built from the request host. The pairing code 501 is a check in `SessionService.requestPairingCode`. Landing row 13 (columns of both tables, incl. `meta_cloud_contacts.lastSeenAt` for S5). `export-tables.parity.spec.ts` "flags exactly the tables with an FK to sessions" now skips excluded tables; its two campaign failures are pre-existing and still red.
- Abandoned: none.
- Boundary: C37-C48 closed at `ecc5ed86` (S3 done; S4 starts at C49).
- Settled mid-build: nothing by the user. Builder decisions below the Landing bar: sends go through `MetaGraphClient.send()` (per-number sliding one-second window of `maxRps` starts that delays, `130429` retried after `[1000, 3000]` ms, every Graph error mapped by `toSendError`); `initialize`/`probeLiveness` keep S2's unmapped `request()` (a non-token 4xx at start is still 502, a 5xx 503). A refusal Meta names (the 400/409/429 rows) is a new generic `EngineRejectedSendError` (`src/common/errors/`), which `send-idempotency.interceptor.ts` now frees like `EngineNotSentError` (AD-004: the engine-send marker had kept every engine 4xx as unknown); 502 stays `BadGatewayException`. `SendPacingService.assertSendAllowed` reads the session row before the breaker, so a Cloud session is neither counted nor refused by the cap or the breaker. Media goes through `loadRemoteMediaBuffer` with the session's `proxyUrl` (the plugin now passes it), base64 decoded locally; only phone-number chats (`<digits>@c.us`) are accepted, others answer 400; `customLinkPreview` answers 501 through the registered `sendTextMessage(customPreview)` site; a reaction calls no `onMessageCreate`. The Cloud send codes are documented once in docs/06 (6.4.2, "Sends on a WhatsApp Cloud API session") with no new route decorators, so `openapi.json` is unchanged. `META_CLOUD_MAX_RPS` is wired in `.env.example`, both compose files, `BLANK_SHADOWED_ENV_KEYS` and the positive-integer list of `env.validation.ts`.
- Abandoned: none.
- Boundary: C49-C68 closed at `7384a2fd` (S4 done; S5 starts at C69).
- Settled mid-build: nothing by the user. Builder decisions below the Landing bar: Landing row 14 added (`IncomingMessage.metadata` carrying `{ reason, errors }` on an `unknown` Cloud message; `onMessageAck`'s 4th argument `errorCode`, carried as `errorCode` in the `message.ack`/`message.failed` payloads of a failed status). The router finds a session through `MetaCloudNumberRegistry` (engine module, exported), which the adapter fills when it reaches READY and empties on disconnect, logout and destroy; an old adapter cannot unregister a successor. The pure mapper is `mapCloudChange` (`meta-cloud-inbound.mapper.ts`); interactive and button replies are `type: "text"` with `button`, as on Baileys; a shared contact's `body` is a vCard. Inbound media goes through `fetchCloudMedia` (`meta-cloud-media.ts`) under the global media gate, `MEDIA_DOWNLOAD_ENABLED` and the declared and streamed byte cap; a failed download delivers the message with the `omitted` marker. `MetaCloudChatStore.recordInbound` (update, then insert, then update again on a racing insert) is written before each message and reaction is handed on; S5 adds its read methods. The controller answers after `setImmediate`, so the router never holds the 200; 503 and 401 carry no `code`. The webhook fixtures are TypeScript (`__fixtures__/meta-cloud-webhooks.ts`) so they can say where they come from. The e2e webhook suite runs `configureApp` with `RATE_LIMIT_SHORT_LIMIT=10` and polls the database, not the API.
- Abandoned: none.
