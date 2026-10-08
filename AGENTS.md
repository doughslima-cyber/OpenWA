# AGENTS.md

Instructions for coding agents working in this repository. Read [OPENMSG.md](OPENMSG.md) first: it explains what
this fork changes, how users and passwords work, and how the fork is deployed.

## What this repository is

OpenMsg is a fork of [OpenWA](https://github.com/rmyndharis/OpenWA), an open-source WhatsApp API gateway (MIT).
The fork adds its own branding and email/password sign-in with user management in the dashboard. Everything else
is upstream code.

- `src/`: NestJS 11 backend (TypeORM, two databases: `main` for auth/audit, always SQLite; `data` for the rest).
- `dashboard/`: React 19 + Vite dashboard, bundled into the API image and served on the same port.
- `sdk/`: five SDKs, checked against `openapi.json` by `npm run check:sdk-*`. `docs/`: numbered design docs (`01`–`31`).
- Remotes: `origin` is this fork, `upstream` is OpenWA. Upstream ships fixes often (WhatsApp changes break
  sessions), so merges from `upstream/main` must stay cheap.

## Fork rules

- **Put fork code in its own files.** Branding lives in `dashboard/src/brand.ts`, `brand.css` and
  `components/BrandLogo.tsx`; sign-in and users in `src/modules/auth/{users.*,auth-login.controller.*,password-hash.ts}`,
  `entities/user*.entity.ts`, `dto/user.dto.ts`, and on the dashboard `pages/{Users,Account}.*`,
  `services/users.ts`, `hooks/useUsers.ts`. Edit upstream files only where a hook point is unavoidable, and keep
  that edit small.
- **Colors go through tokens.** Use `var(--primary)`, `--primary-text`, `--primary-hover`, `--primary-soft`;
  `brand.css` overrides them. Positive statuses (connected, active, success) use `--success` / `--success-text`,
  not the brand color. Do not hard-code hex colors in page CSS.
- **Keep upstream contracts.** Do not rename `X-OpenWA-*` headers, `OPENWA_*` variables, container names or the
  `openwa_*` sessionStorage keys; integrations and upstream merges depend on them.
- **Never rename or delete a file in `src/database/migrations-main/` or `src/database/migrations/`.** The ledger
  records migrations by name. A released table changes only through a new migration.

## Rules the test suite enforces

The repo has many governance specs. When you add something, update all of its places in the same change:

| Adding                  | Also update                                                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A controller route      | `@Public()` or `@RequireUnscopedKey()` (or an `ALLOWLIST` entry in `src/modules/auth/global-route-fence-coverage.spec.ts`); a `#### METHOD /api/path` section in `docs/06` whose `**Errors:**` names every declared 409/429/5xx; then `npm run openapi:export`. |
| A `@Public()` route     | `PUBLIC_PATHS` in `src/config/swagger.config.ts` and both expected lists in `swagger.config.spec.ts`.                                                                                                                                                           |
| A new API resource      | SDK methods in all five SDKs, or the resource in the "Deliberately not exposed" list of `sdk/README.md` (and `docs/18`).                                                                                                                                        |
| An `AuditAction` value  | Emit it as `AuditAction.X` somewhere in `src/`, or list it in `src/modules/audit/intentionally-unemitted-actions.ts`; then `npm run openapi:export`.                                                                                                            |
| A main-DB entity        | Put it under `src/modules/auth/` or `src/modules/audit/` (the entity globs and the backup parity spec only look there). Name every index explicitly (`@Index('IDX_table_col', …)`) and match the migration DDL exactly.                                         |
| A migration             | List the file under "Migration Files" in `docs/05-database-design.md`; add a `__tests__` spec next to it.                                                                                                                                                       |
| An environment variable | `.env.example` (commented out), a `- KEY=${KEY:-}` line in both `docker-compose.yml` and `docker-compose.dev.yml`, and `BLANK_SHADOWED_ENV_KEYS` in `src/config/env-precedence.ts`.                                                                             |
| A dashboard string      | The key in all 15 catalogs under `dashboard/src/i18n/locales/` (English text is acceptable where no translation exists).                                                                                                                                        |
| A dashboard page        | Scope every rule of `pages/<Page>.css` under the page's root class; give every input a `<label htmlFor>` or `aria-label`.                                                                                                                                       |

Other conventions:

- Backend logging: `createLogger('Name')` from `common/services/logger.service`, never `new Logger()`.
- Machine-readable errors: `new ConflictException({ statusCode, error, message, code: 'UPPER_SNAKE' })`; the
  dashboard maps `code` to translated text.
- On authenticated routes, answer bad user input (for example a wrong current password) with 400, never 401: the
  dashboard treats any 401 as an unusable key and signs the user out.
- Dashboard TypeScript uses `erasableSyntaxOnly`: no constructor parameter properties, no enums.

## Commands

Backend, from the repository root:

```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/modules/auth                      # or the paths you touched
npx jest src/modules/auth/users.service.spec.ts  # unit lane
npx jest <spec files> --testPathIgnorePatterns=/node_modules/   # docs/governance lane
npm run test:docs                                # the whole docs/governance lane
npm run openapi:export                           # after any route, DTO or AuditAction change
npm run check:sdk-routes && npm run check:sdk-coverage
```

`--testPathIgnorePatterns` takes every argument after it, so put it **last**, or jest runs the whole suite.

Dashboard, from `dashboard/`:

```bash
npm run typecheck && npm run lint && npm run format:check && npm run i18n:check
npm test
npm run build
node --experimental-strip-types --test --test-timeout=120000 src/pages/Users.test.ts   # one file
```

Format what you change with `npx prettier --write <files>` (backend, dashboard and Markdown share the config).

## Working on Windows

- Install backend dependencies with `PUPPETEER_SKIP_DOWNLOAD=true npm ci --ignore-scripts`, then
  `node scripts/postinstall.js`. A plain `npm ci` fails compiling `better-sqlite3`; the package ships prebuilt
  binaries that `--ignore-scripts` keeps.
- Python is not installed; write helper scripts in Node.
- These fail on Windows with or without fork changes; compare against a stashed tree before blaming a change:
  `auth.service.spec.ts` (2 banner/bootstrap-file tests), `env-precedence.spec.ts` (3), `sqlite-file-permissions.spec.ts`,
  `docs-ci-jobs.spec.ts`, `docs-governance.spec.ts` (2), several adapter/storage specs that use symlinks or signals,
  and `npm run check:contract-shapes` (Python SDK types). CI runs on Ubuntu.
- Under a full parallel `npm test`, a few dashboard render tests (`App.test.ts`, `Chats.test.ts`) can time out
  waiting for lazy chunks; rerun the file alone before treating it as a failure.

## Deployment

Production is a Docker Compose stack on an Oracle Cloud ARM VM, reached as `ssh servidor`, in `~/openmsg`, published
through a dedicated Cloudflare Tunnel at `https://openmsg.devsrun.com`. Details, the override file and the `.env`
keys are in [OPENMSG.md](OPENMSG.md#implantação).

- Update: `cd ~/openmsg && git pull && docker compose up -d --build`; an `.env`-only change needs `docker compose up -d`.
- Never print, log or paste secrets (`.env` values, `TUNNEL_TOKEN`, API keys, passwords). Check that a value is set
  without showing it, for example `grep -c '^KEY=.' .env`.
- In `.env`, quote passwords with single quotes; Compose otherwise interpolates `$` and cuts at ` #`.
- Do not touch the other services on the VM (nginx, cloudflared, Evolution, n8n, Hermes and others).
