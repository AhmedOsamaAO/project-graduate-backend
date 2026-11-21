# Repository guidance

## Git workflow

- Never commit directly to `main`. Create a branch for the issue or task, make the changes there, and open a pull request.
- Use issue-linked branch names such as `feat/14-platform-foundation`.

## Product and current state

- Read `MVP.md` for approved scope and schema decisions; `schema.md` is the original DBML design despite its Markdown extension. Neither describes implemented functionality.
- The app exposes the Nest starter identity at `GET /api/v1` and staff sign-in, session, CSRF, and password-change routes under `/api/v1/auth/*` through the shared platform bootstrap, protected by a default-deny guard (`StaffAccessGuard`) except `/api/v1/auth/csrf` and `/api/v1/auth/login`. It has no academic domain HTTP routes yet. `prisma/schema.prisma` includes staff accounts, session storage, and protected change history. Operator commands provision/reset/deactivate accounts and clean up expired sessions. See `docs/operator-accounts.md` for setup; the README is not a product specification.
- Qualification records own degrees in the approved model; do not copy `Student.degree_level` / `degree_name` from DBML. See `MVP.md` for remaining schema questions before implementing affected rules.

## Runtime and persistence

- `src/main.ts` calls `createApplication` from `src/bootstrap.ts` and then listens on the validated `HOST` and `PORT`. The bootstrap loads local dotenv values, validates configuration through `src/config/app-config.ts`, and applies the shared HTTP surface. `AppModule.register(config)` provides the validated configuration to the global `PrismaModule`; inject its `PrismaService` for database access.
- Startup fails fast when required configuration is missing or invalid. The validated settings cover `NODE_ENV`, `DATABASE_URL`, `HOST`, `PORT`, exact `FRONTEND_ORIGINS`, `COOKIE_SECURE`, `CSRF_MODE`, session durations and cleanup interval (`SESSION_CLEANUP_INTERVAL_MINUTES`), `PRIVATE_STORAGE_ROOT`, and `UPLOAD_MAX_BYTES`. Production additionally requires loopback binding, an HTTPS frontend origin, secure cookies, and synchronizer CSRF mode.
- The shared bootstrap sets the `/api/v1` prefix, strict request validation, the `{code,message,details?}` error contract, the `{data}` and page envelopes, exact-origin CORS, production loopback trust-proxy handling, graceful shutdown hooks, and Swagger at `/api/docs` (JSON at `/api/docs-json`). E2E tests call the same bootstrap.
- `PrismaService` uses the Prisma 7 PostgreSQL driver adapter and imports the generated client from `src/generated/prisma/client`, not `@prisma/client`. It takes the validated `databaseUrl` from the injected configuration and executes `SELECT 1` during module initialization, so application startup needs reachable PostgreSQL.
- Prisma generates into ignored `src/generated/prisma/`; regenerate rather than editing generated files. Migrations belong in `prisma/migrations/`; `.gitignore`'s `/migrations` entry only ignores a root-level directory.
- `DATABASE_URL` is a non-owner runtime LOGIN inheriting only `graduate_runtime`; startup and operator commands verify history privileges. Prisma configuration uses separate operator-only `MIGRATION_DATABASE_URL`. Initial migration needs CREATEROLE. Do not put migration credentials in the service environment. History appends join the mutation's serializable transaction; safe account serializers exclude credential/session material.
- `.env.example` documents every runtime variable with placeholders. `.env.test.example` documents the optional isolated test server connection; test setup supplies safe defaults for the remaining platform settings. Repo-local `opencode.json` denies reads of `.env*` except `.env.example` and `.env.test.example`.

## Commands and verification

- Use npm with `package-lock.json`. Node 24.15.0 is pinned in `.nvmrc`; the `engines` field allows Prisma 7.10.1's `^20.19 || ^22.12 || >=24.0`. Run `nvm use` before installing.
- The Prisma config is **`prisma7.config.ts`**. Every Prisma script and `postinstall` selects it explicitly, so do not add `--config` manually.
  - Validate: `npm run prisma:validate`
  - Generate after schema changes: `npm run prisma:generate` (`npm install` runs the same through `postinstall`).
  - Apply committed migrations: `npm run prisma:deploy` (requires PostgreSQL and `MIGRATION_DATABASE_URL`).
  - Create/apply a development migration: `npm run prisma:migrate -- --name <name>` (requires PostgreSQL and `MIGRATION_DATABASE_URL`).
  - Studio: `npm run prisma:studio`
- Application startup never runs migrations. Deploy them explicitly with `npm run prisma:deploy`.
- Build before operator commands: `npm run staff -- create|reset|deactivate ...` and `npm run session:cleanup`. Supply `--operator` attribution, account ID/`--expected-version` for updates, and passwords only by hidden prompt or stdin. See `docs/operator-accounts.md`; no public registration or administrator role exists.
- The `start`, `start:dev`, `start:debug`, and `start:prod` scripts set `NODE_ENV` explicitly. Start watch mode with `npm run start:dev`; for production, run `npm run build` before `npm run start:prod`.
- `npm run lint` is a read-only check; `npm run lint:fix` applies fixes. `npm run format:check` is read-only; `npm run format` writes. Both cover TypeScript under `src/` and `test/` plus `prisma7.config.ts`.
- `npm run typecheck` covers `src/`, `test/`, and `prisma7.config.ts`; `npm run build` excludes tests and the root Prisma config.
- Unit tests: `npm test -- --runInBand`; one file: `npm test -- --runInBand --runTestsByPath src/app.controller.spec.ts`. Jest's unit-test root is `src/`. Test scripts enable `--experimental-vm-modules` because the Prisma 7 generated client uses dynamic imports.
- Database-backed tests: `npm run test:db`. The helper creates a uniquely named disposable PostgreSQL database and restricted runtime LOGIN, applies `npm run prisma:deploy` migrations with the owner connection, and drops both during teardown. It also creates/removes temporary storage outside the repository. The server comes from `TEST_DATABASE_URL` when set, otherwise `DATABASE_URL`; it needs database/role creation and drop permissions. Tests run application access as the runtime LOGIN, never the owner. Test setup loads `.env.test` before `.env`.
- E2E tests: `npm run test:e2e`. They create the app through the shared `createApplication` bootstrap (or the exported `configureApplication` for probe routes), use the same isolated database and storage helpers, close the Nest app and Prisma connection during teardown, and load test configuration through `test/setup-test-env.ts`.
- The unit, database, and E2E Jest configs all map relative `.js` imports back to TypeScript for generated Prisma code.

## Agent skills

- Issues and planning maps live in GitHub Issues; external PRs are not a request-triage surface. See `docs/agents/issue-tracker.md`.
- Use the default five triage labels. Wayfinding decisions use only `wayfinder:*` labels. See `docs/agents/triage-labels.md`.
- Domain docs use a single context: root `CONTEXT.md` and `docs/adr/`, created as needed. See `docs/agents/domain.md`.
