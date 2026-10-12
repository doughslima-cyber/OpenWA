# Meta Cloud API sessions in the dashboard (doc 32, F3) - checks

Profile: standard
Plan: `.specs/features/meta-cloud-dashboard/plan.md`

52 checks in 5 slices plus governance · 5 one-way doors · 1 open, which blocks go-live only

Proof commands, from `package.json`, `dashboard/package.json` and `.github/workflows/ci.yml`:

- backend unit lane: `npx jest <file> -t "<title>"`
- backend docs/governance lane: `npx jest <file> -t "<title>" --testPathIgnorePatterns=/node_modules/`, flag last
- backend e2e lane: `npx jest --config ./test/jest-e2e.json <file> -t "<title>"`
- dashboard: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="<title>" <file>`
- Test titles start with the check id and a space (`C12 ...`). Dashboard render tests follow `dashboard/src/pages/Users.test.ts`
  and `Sessions.test.ts`: stubbed `fetch`, jsdom globals, `i18nReady`, `QueryClientProvider` + `ToastProvider`, role and
  engine seeded through `sessionStorage`. Backend e2e suites point the real adapter at the fake Graph server
  (`src/engine/adapters/__fixtures__/fake-graph-server.ts`), as the F2 suites do.

## Checks

### S1 - Create and manage a Cloud session from the Sessions page · 8 files · ~150 KB · ~38k

**C1** - `sessionActions` reads the session's `engine`: `awaitsPairing` returns `false` for a `meta-cloud` session in `initializing` with no phone and in `qr_ready`, and keeps its current answers for a NULL-engine session; `canUnlinkSession` returns `false` for any `meta-cloud` session (MCD-01, AC 1 · MCD-02, AC 7) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C1 " src/utils/sessionActions.test.ts`

**C2** - The New session form shows the choices "Linked device (QR)" (checked) and "Official Meta API", and no Cloud field until the second is chosen (MCD-01, AC 2) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C2 " src/pages/Sessions.metaCloud.test.ts`

**C3** - With "Official Meta API" chosen, the form shows Phone Number ID, WABA ID and access token inputs, each reachable by its label, the token input of `type="password"` (MCD-01, AC 3) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C3 " src/pages/Sessions.metaCloud.test.ts`

**C4** - Submitting the Cloud form sends exactly one `POST /api/sessions` with body `{ name, engine: "meta-cloud", metaCloud: { phoneNumberId, wabaId, accessToken } }` and no `proxyUrl` key (MCD-01, AC 4) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C4 " src/pages/Sessions.metaCloud.test.ts`

**C5** - With any one of the three Cloud fields empty (3 cases), the submit button is disabled and clicking it sends no request (MCD-01, AC 5) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C5 " src/pages/Sessions.metaCloud.test.ts`

**C6** - A create answered with 400 `META_CLOUD_DISABLED`, 400 `META_CLOUD_NOT_CONFIGURED` and 409 `META_PHONE_NUMBER_IN_USE` (3 cases) shows the English catalog text for that code, and not the response `message` (MCD-01, AC 6) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C6 " src/pages/Sessions.metaCloud.test.ts`

**C7** - A `meta-cloud` session's card in `initializing` with no phone, and again in `ready`, shows the "Official API" badge and no QR placeholder, no **Show QR** and no **Unlink**; a NULL-engine card in `qr_ready` still shows **Show QR** (MCD-02, AC 7) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C7 " src/pages/Sessions.metaCloud.test.ts`

**C8** - Clicking **Start** on a `meta-cloud` card sends the start request and no QR modal appears, and no `/qr` request is made (MCD-02, AC 8) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C8 " src/pages/Sessions.metaCloud.test.ts`

**C9** - A `meta-cloud` card in `action_required` with `lastError` `META_TOKEN_INVALID`, and with `META_TOKEN_MISSING`, shows the catalog's "change the token" hint (MCD-02, AC 9) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C9 " src/pages/Sessions.metaCloud.test.ts`

**C10** - Opening a `meta-cloud` session's detail requests `GET /api/sessions/:id/meta/account` and shows the display phone number, verified name, quality rating, messaging limit tier, `•••• 1234` for `accessTokenLast4: "1234"`, the `webhookUrl` with a **Copy** button, and the text naming `META_WEBHOOK_VERIFY_TOKEN` (MCD-03, AC 10) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C10 " src/pages/Sessions.metaCloud.test.ts`

**C11** - The `meta-cloud` detail shows no auto-reject-calls toggle (MCD-03, AC 11) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C11 " src/pages/Sessions.metaCloud.test.ts`

**C12** - Submitting **Change token** with `new-token-5678` sends `PUT /api/sessions/:id/meta/account` with exactly `{ accessToken: "new-token-5678" }`, shows a success toast, empties the field and then shows `•••• 5678`; with the field empty the button is disabled (MCD-03, AC 12) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C12 " src/pages/Sessions.metaCloud.test.ts`

**C13** - When `GET .../meta/account` answers 404, and when the PUT answers 400 `META_CLOUD_NOT_CONFIGURED`, the detail shows the error text (catalog text for the coded one, the message otherwise) and the session's name, status and id rows stay visible (MCD-03, AC 13) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C13 " src/pages/Sessions.metaCloud.test.ts`

**C14** - Opening a NULL-engine session's detail makes no `meta/account` request and shows no Cloud section, and still shows the auto-reject-calls toggle (MCD-03, AC 14) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C14 " src/pages/Sessions.metaCloud.test.ts`

### S2 - Chats on a Cloud session · 7 files · ~170 KB · ~43k

**C15** - With a `meta-cloud` session selected, the Chats sidebar renders no Status and no Channels tab (MCD-04, AC 15) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C15 " src/pages/Chats.metaCloud.test.ts`

**C16** - With a `meta-cloud` session selected, an own message's menu has **Reply** and **React** and no **Delete**, and a message with interactive buttons renders them with no clickable button element (MCD-04, AC 16) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C16 " src/pages/Chats.metaCloud.test.ts`

**C17** - Opening a chat of a `meta-cloud` session requests `GET /api/sessions/:id/meta/chats/<encoded chatId>/window` once (MCD-05, AC 17) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C17 " src/pages/Chats.metaCloud.test.ts`

**C18** - With the window answering `open: false`, the composer shows the catalog's closed-window banner and a **Send template** button inside it (MCD-05, AC 18) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C18 " src/pages/Chats.metaCloud.test.ts`

**C19** - With the window answering `open: true`, no banner is shown and **Send template** is offered in the composer's action area; with the window request failing (500), no banner is shown and the text input stays enabled (MCD-05, AC 19 · Observable) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C19 " src/pages/Chats.metaCloud.test.ts`

**C20** - A send answered with each of `META_OUTSIDE_SERVICE_WINDOW`, `META_RECIPIENT_UNAVAILABLE`, `META_LIMIT_REACHED`, `META_RATE_LIMITED`, `META_TOKEN_INVALID`, `META_ACCOUNT_RESTRICTED` (6 cases, table-driven) shows that code's English catalog text (MCD-05, AC 20) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C20 " src/pages/Chats.metaCloud.test.ts`

**C21** - With a NULL-engine session selected under login `engineType` `whatsapp-web.js`, the Status and Channels tabs render, **Delete** is offered, no `/window` request is made, and there is no banner and no **Send template**; under `baileys` the Channels tab shows its existing not-supported state (MCD-04, AC 21) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C21 " src/pages/Chats.metaCloud.test.ts`

### S3 - Send an approved template · 14 files · ~210 KB · ~53k

**C22** - `listTemplates` follows Graph `paging.cursors.after` across 3 pages and returns every template in order; with pages holding 600 templates in total it stops after 500; each template carries `name`, `language`, `status`, `category`, `parameterFormat` (from `parameter_format`, `POSITIONAL` when absent) and the Graph `components` unchanged (MCT-01, AC 22 · door 3) ✅
Proof: `npx jest src/modules/meta-cloud/meta-cloud-templates.service.spec.ts -t "C22 "`

**C23** - `GET /api/sessions/:id/meta/templates` on a Cloud session answers 200 `{ templates: [...] }` with the fake Graph's templates (MCT-01, AC 22) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-templates.e2e-spec.ts -t "C23 "`

**C24** - Two list requests 4 minutes apart (fake clock) make one Graph call; a third at 6 minutes makes a second; a request with `refresh=true` inside the 5 minutes makes a call; two sessions do not share an entry (MCT-01, AC 23 · door 3) ✅
Proof: `npx jest src/modules/meta-cloud/meta-cloud-templates.service.spec.ts -t "C24 "`

**C25** - The templates route and the window route answer 501 on a NULL-engine session and 404 on an unknown session id (4 cases) (MCT-01, AC 24) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-templates.e2e-spec.ts -t "C25 "`

**C26** - The templates route answers 409 `META_TOKEN_INVALID` when Graph answers code 190, 502 `META_UPSTREAM_ERROR` on a Graph 500, and 503 when Graph is unreachable (MCT-01, Surface) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-templates.e2e-spec.ts -t "C26 "`

**C27** - With a contact whose `lastInboundAt` is 23 h 59 min ago the window route answers `{ lastInboundAt, open: true, closesAt }` with `closesAt` exactly 24 h after `lastInboundAt` (ISO 8601 UTC); at 24 h 1 min ago `open: false`; with no contact row `{ lastInboundAt: null, open: false, closesAt: null }` (MCT-01, AC 25 · door 5) ✅
Proof: `npx jest src/modules/meta-cloud/meta-cloud-window.service.spec.ts -t "C27 "`
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-templates.e2e-spec.ts -t "C27 "`

**C28** - `sendTemplateMessage` posts `{ messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template: { name, language: { code } } }` with no `components` when there are no parameters; with `["Ana", "42"]` one component `{ type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "42" }] }`; with `{ first_name: "Ana" }` `{ type: "body", parameters: [{ type: "text", parameter_name: "first_name", text: "Ana" }] }` (MCT-02, AC 26 · door 2) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-adapter.spec.ts -t "C28 "`

**C29** - `POST /api/sessions/:id/meta/send-template` with a positional template on a `READY` Cloud session answers 201 with `messageId` equal to the fake Graph's `wamid` (MCT-02, AC 26) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-templates.e2e-spec.ts -t "C29 "`

**C30** - After a template send of body `Olá {{1}}, seu pedido {{2}} saiu` with `["Ana", "42"]`, the stored message's body is `Olá Ana, seu pedido 42 saiu`; for a named template `Oi {{first_name}}` with `{ first_name: "Ana" }` it is `Oi Ana`; `WebhookService.dispatch` is called with `message.sent` exactly once per send (MCT-02, AC 27) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-templates.e2e-spec.ts -t "C30 "`

**C31** - A template send with a plugin that cancels `message:sending` answers the same refusal `send-text` answers and makes no Graph call; the same `Idempotency-Key` sent twice makes one Graph call and returns the same `messageId`; a key restricted to another chat gets 403 and no Graph call (MCT-02, AC 28) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-templates.e2e-spec.ts -t "C31 "`

**C32** - The Graph client maps codes `132000`, `132001`, `132005`, `132007`, `132012`, `132015`, `132016` (7 cases) to 400 `META_TEMPLATE_INVALID` with `metaCode`, and the F2 table's other rows are unchanged (MCT-02, AC 29 · door 4) ✅
Proof: `npx jest src/engine/adapters/meta-cloud-graph.client.spec.ts -t "C32 "`
Proof: `npx jest src/engine/adapters/meta-cloud-graph.client.spec.ts -t "C44 "`

**C33** - A template send answered by Graph with `132001` returns 400 `META_TEMPLATE_INVALID` with `metaCode: 132001` over HTTP (MCT-02, AC 29) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-templates.e2e-spec.ts -t "C33 "`

**C34** - A template send on a Cloud session that is not started answers 409; bodies missing `chatId`, `name` and `language` (3 cases), and one whose `parameters` is a number, each answer 400; a NULL-engine session answers 501 (MCT-02, AC 30 · Surface) ✅
Proof: `npx jest --config ./test/jest-e2e.json test/meta-cloud-templates.e2e-spec.ts -t "C34 "`

**C35** - The picker requests the templates route once on open and lists only the `APPROVED` templates (a `PENDING` and a `REJECTED` one are absent), each with name, language and category, ordered by name then language; **Refresh** requests it again with `refresh=true` (MCT-03, AC 31) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C35 " src/components/chats/TemplatePicker.test.ts`

**C36** - Selecting a positional template with body `Olá {{1}}, seu pedido {{2}} saiu` shows two inputs labelled `{{1}}` and `{{2}}`; a named template `Oi {{first_name}}` shows one input labelled `{{first_name}}`; typing `Ana` and `42` makes the preview read `Olá Ana, seu pedido 42 saiu` (MCT-03, AC 32) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C36 " src/components/chats/TemplatePicker.test.ts`

**C37** - A template with a `HEADER` of format `IMAGE`, one with a `HEADER` text holding `{{1}}`, and one with a `BUTTONS` component whose URL holds `{{1}}` (3 cases) are listed with the catalog's "not sendable from the dashboard" text and **Send** disabled (MCT-03, AC 33) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C37 " src/components/chats/TemplatePicker.test.ts`

**C38** - With one of two placeholder inputs empty, **Send** is disabled and clicking it sends nothing (MCT-03, AC 34) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C38 " src/components/chats/TemplatePicker.test.ts`

**C39** - **Send** posts `.../meta/send-template` with `{ chatId, name, language, parameters: ["Ana", "42"] }` for a positional template and `{ ..., parameters: { first_name: "Ana" } }` for a named one, then closes the picker; a template with no placeholders posts no `parameters` key (MCT-03, AC 35 · door 2) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C39 " src/components/chats/TemplatePicker.test.ts`

**C40** - After a picker send in Chats, the thread refetches and shows the sent message's text (MCT-03, AC 35) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C40 " src/pages/Chats.metaCloud.test.ts`

**C41** - With no `APPROVED` template the picker shows the catalog's empty state naming WhatsApp Manager; with the list failing (502) it shows the error text and **Refresh** (MCT-03, AC 36 · Observable) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C41 " src/components/chats/TemplatePicker.test.ts`

### S4 - Campaigns page on a Cloud session · 3 files · ~40 KB · ~10k

**C42** - With a `meta-cloud` session selected, the Campaigns page shows no **New campaign** button and shows the catalog's Cloud note; with a NULL-engine session selected the button is back (MCD-06, AC 37) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C42 " src/pages/Campaigns.metaCloud.test.ts`

**C43** - A campaign request answered with 400 `CAMPAIGN_ENGINE_UNSUPPORTED` shows the English catalog text for it (MCD-06, AC 38) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C43 " src/pages/Campaigns.metaCloud.test.ts`

### S5 - Copy and conventions · 18 files · ~60 KB · ~15k

**C44** - `npm run i18n:check` in `dashboard/` exits 0, and the en catalog holds every key this feature's components call (a test renders each new screen state and asserts no raw key string, i.e. no text matching a dotted catalog path, appears) (MCD-07, AC 39) ✅
Proof: `cd dashboard && npm run i18n:check`
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C44 " src/pages/Sessions.metaCloud.test.ts`

**C45** - Every rule in the pages' stylesheets stays scoped under its page root, and no declaration in a rule whose selector mentions `meta-cloud` or `template-picker` holds a hex, `rgb(` or `hsl(` color literal (MCD-07, AC 40) ✅
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="every rule is scoped under its page root" src/styles.scope.test.ts`
Proof: `cd dashboard && node --experimental-strip-types --test --test-timeout=120000 --test-name-pattern="C45 " src/meta-cloud.styles.test.ts`

### Governance - what the repo's gates require of the new routes and strings · 12 files · ~80 KB · ~20k

**C46** - The three new routes have `#### METHOD /api/...` sections in `docs/06` whose `**Errors:**` name each declared 409/429/5xx; `openapi.json` is regenerated and current (Surface, door 1)
Proof: `npx jest src/common/openapi/docs-06-contract.spec.ts -t "documents every contract operation|documents every route-specific status code" --testPathIgnorePatterns=/node_modules/`
Proof: `npm run openapi:export && git diff --exit-code openapi.json`

**C47** - The window and send routes carry `@ChatScoped('fenced')` and the chat-scope coverage gate holds; the global route fence holds (MCT-02, AC 28)
Proof: `npx jest src/modules/auth/chat-scope-coverage.spec.ts -t "pairs every decorator with a parsed handler|keeps the pinned handlers unmarked"`
Proof: `npx jest src/modules/auth/global-route-fence-coverage.spec.ts -t "no real controller exposes an unfenced deployment-global route" --testPathIgnorePatterns=/node_modules/`

**C48** - SDK route and coverage checks pass with the new routes inside the excluded `meta` resource (door 1)
Proof: `npm run check:sdk-routes`
Proof: `npm run check:sdk-coverage`

**C49** - The dashboard's hand types match the contract for every shape this feature reads (`Session.engine`, the account, template and window responses) on an LF checkout (Surface)
Proof: `npm run check:contract-shapes` (run on an LF checkout - `git -c core.autocrlf=false worktree add` - per lesson L-001; on a CRLF Windows checkout the Python SDK pairs fail regardless)

**C50** - The dashboard type-checks, lints and keeps its formatting (MCD-07)
Proof: `cd dashboard && npm run typecheck`
Proof: `cd dashboard && npm run lint`
Proof: `cd dashboard && npm run format:check`

**C51** - The backend type-checks and the meta-cloud and message specs this feature touches keep passing (MCT-02)
Proof: `npx tsc --noEmit -p tsconfig.json`
Proof: `npx jest src/modules/meta-cloud src/modules/message/message-send.service.spec.ts`

**C52** - `OPENMSG.md` gains a short Portuguese section on operating a Cloud session from the dashboard (create, change token, the 24-hour window and templates), with no secret values, and `docs/32` marks F3 implemented (Observable - document)
Proof: `npx jest src/common/docs-governance.spec.ts -t "governance docs match the repository" --testPathIgnorePatterns=/node_modules/`

## Coverage

| Set (size)                                                            | Member -> proof                                                                                                                           | Unproven |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `GET /api/sessions/:sessionId/meta/templates` statuses (6)            | 200 C23 · 404 C25 · 409 C26 · 501 C25 · 502 C26 · 503 C26                                                                                 | -        |
| `GET /api/sessions/:sessionId/meta/chats/:chatId/window` statuses (4) | 200 C27 · 403 C47 (fence) · 404 C25 · 501 C25                                                                                             | -        |
| `POST /api/sessions/:sessionId/meta/send-template` statuses (9)       | 201 C29 · 400 C33, C34 · 403 C31 · 404 C34 · 409 C34 · 429 C32 (F2 table row) · 501 C34 · 502 C32 · 503 C32                               | -        |
| `POST /api/sessions` statuses the dashboard handles (3)               | 201 C4 · 400 C6 · 409 C6                                                                                                                  | -        |
| create error codes (3)                                                | `META_CLOUD_DISABLED` C6 · `META_CLOUD_NOT_CONFIGURED` C6 · `META_PHONE_NUMBER_IN_USE` C6                                                 | -        |
| send error codes shown in Chats (6)                                   | C20, table-driven over all 6                                                                                                              | -        |
| template error codes 132000-132016 named by Meta (7)                  | C32, table-driven over all 7; boundary 132001 C33                                                                                         | -        |
| template parameter shapes (3)                                         | none C28, C39 · positional C28, C29, C30, C39 · named C28, C30, C39                                                                       | -        |
| window answers (3)                                                    | open C27 · closed C27 · no contact C27                                                                                                    | -        |
| template list behaviours (4)                                          | paging C22 · 500 cap C22 · cache hit C24 · `refresh=true` C24                                                                             | -        |
| picker template kinds (6)                                             | body-only positional C36 · body-only named C36 · no placeholders C39 · header media C37 · header text variable C37 · button parameter C37 | -        |
| session card states for Cloud (4)                                     | initializing C7 · ready C7 · action_required token invalid C9 · action_required token missing C9                                          | -        |
| Chats engine gates (5)                                                | Status tab C15, C21 · Channels tab C15, C21 · Delete C16, C21 · interactive buttons C16 · window request C17, C21                         | -        |
| composer window states (3)                                            | closed C18 · open C19 · request failed C19                                                                                                | -        |
| Landing doors (5)                                                     | 1 C23, C29, C46, C48 · 2 C28, C39 · 3 C22, C24 · 4 C32, C33 · 5 C27                                                                       | -        |
| Relations entities (0)                                                | none - no stored-data change                                                                                                              | -        |
| startup config (1 place)                                              | the meta-cloud module registers the new controller and services, booted by every e2e suite through `AppModule` C23                        | -        |

- Claims naming a status code, route or response shape: C4, C6, C10, C12, C13, C17, C23, C25, C26, C27, C29, C30,
  C31, C33, C34, C35, C39, C42, C43. The backend ones have an e2e proof across HTTP; the dashboard ones are proven
  at the request the page sends and the response it renders, through a stubbed `fetch`, which is the boundary the
  dashboard owns.
- C22, C24, C28 and C32 are decision tables proven at their own layer, each with an HTTP boundary row (C23, C29,
  C33).

## Test policy

`docs/09-testing-strategy.md` §9.7 says which level proves which code and nothing about how much of a decision table
a proof must assert; the dashboard has no testing guide beyond its runner. These rows are the bar this build runs
under (the same rows F1 + F2 ran under).

| Code                                   | Required proofs                                  | Coverage expectation                                                                           |
| -------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Decides, reached across a boundary     | one at the boundary **and** one at its own layer | the contract at the boundary; one asserted case per row of the decision table at its own layer |
| Decides, not reached across a boundary | one at its own layer                             | one asserted case per row of the decision table                                                |
| Entry point that decides nothing       | one at the boundary                              | accepted input, each rejected input, each error path                                           |
| Instrumentation, pass-throughs         | none of its own                                  | covered by its consumer's proof                                                                |

Evidence (planned files, classified by the shape the plan fixes):

- `meta-cloud-templates.service.ts`: paging loop with a cap, a TTL cache keyed by session with a bypass, 4 branch
  points -> decides, reached across a boundary (C22, C24 at its layer; C23 at HTTP)
- `meta-cloud-window.service.ts` (or the chat-store method): 3 outcomes -> decides, reached across a boundary (C27 both)
- adapter `sendTemplateMessage`: 3 parameter shapes -> decides (C28), reached across a boundary (C29, C30)
- Graph client table rows `132xxx`: 7 codes -> decides (C32), boundary C33
- `TemplatePicker.tsx`: approved filter, placeholder extraction (positional and named), sendability rule over 3
  disqualifying kinds, enablement -> decides (C35-C39, C41 at its own layer through its render test; C40 at the Chats
  page)
- `sessionActions.ts`: engine branch in two helpers -> decides (C1)
- the meta-cloud controller methods: forward to services, no conditional beyond validation pipes -> entry point that
  decides nothing (C23, C25-C27, C29, C33, C34)
- `services/metaCloud.ts` and `hooks/useMetaCloud.ts`: one request or query each -> instrumentation (covered by the
  page and picker proofs)
- closest analogues: `meta-cloud-graph.client.spec.ts` (`it.each` over the F2 error table) and
  `dashboard/src/pages/Users.test.ts` (form posts and error-code text through a stubbed `fetch`)

Cost: 3 backend unit spec files and 2 dashboard component/page test files at their own layer. Without these rows the
picker's placeholder and sendability rules and the template parameter shapes are proven only by whichever one path a
page test happens to take.

## Swept

- validation: C5, C12, C34, C38
- failure modes: C13, C19, C26, C41
- idempotency: C31 (same `Idempotency-Key` → one Graph call); existing - the send-idempotency interceptor F2 extended
  (`EngineRejectedSendError` releases the key), which C33's 400 relies on
- authorization: C31, C47 (chat-restricted keys); existing - write-permission gating of the composer, **New session**
  and **Change token** (`canWrite` in `Sessions.tsx` and `Chats.tsx`)
- concurrency: n/a - the template list is read-only and a second concurrent Graph read is harmless; sends reuse the
  F2 per-number limiter (F2 C47)
- data lifecycle: C24 (5-minute template cache, bypass); no stored data changes
- dependency failure: C26, C41, C19
- state transitions: C9 (action_required hints), C34 (send on a session that is not started)
- observability: n/a - template sends log through the existing send pipeline; metrics are doc 32 F5

## Handoff

Intended split, with the arithmetic, written before any code. Budget 150k tokens (default). Estimates are the
`wc -c` of the files each slice reads or edits, with partial reads for the large files (`Sessions.tsx` 1351 lines,
`Chats.tsx` 1278 lines and `message-send.service.ts` 49 KB read by section; `docs/06` edited by section;
`openapi.json` generated, never read), divided by four.

- S3 backend part (~30k) + S3 picker (~23k) = 53k; + S1 (~38k) = 91k; + S2 (~43k) = 134k; + S4 (~10k) = 144k;
  S5 + governance (~35k) would reach 179k -> builder A: S3, S1, S2, S4 (backend first so the dashboard builds
  against real routes); builder B: S5 and governance C44-C52, the catalogs and every repo gate

- Boundary: C1-C43 closed at `15310ffd` (builder A); C44-C52 open for builder B.
- Settled mid-build: none by the user. The 14 non-English catalogs carry the new keys in English so parity and the dashboard tests stay green; builder B translates them.
- Abandoned: none.
