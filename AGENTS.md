# Repository guidance

## Product and current state

- Read `MVP.md` for approved scope and schema decisions; `schema.md` is the original DBML design despite its Markdown extension. Neither describes implemented functionality.
- The app currently exposes only the Nest starter `GET /`. `prisma/schema.prisma` has a generator and PostgreSQL datasource but no domain models or migrations. The README is Nest boilerplate, not a product specification.
- Qualification records own degrees in the approved model; do not copy `Student.degree_level` / `degree_name` from DBML. See `MVP.md` for remaining schema questions before implementing affected rules.

## Runtime and persistence

- `src/main.ts` loads dotenv, boots `AppModule`, and listens on `PORT` or 3000. `AppModule` imports the global `PrismaModule`; inject its `PrismaService` for database access.
- `PrismaService` uses the Prisma 7 PostgreSQL driver adapter and imports the generated client from `src/generated/prisma/client`, not `@prisma/client`. It requires `DATABASE_URL` and executes `SELECT 1` during module initialization, so application startup needs reachable PostgreSQL.
- Prisma generates into ignored `src/generated/prisma/`; regenerate rather than editing generated files. Migrations belong in `prisma/migrations/`; `.gitignore`'s `/migrations` entry only ignores a root-level directory.
- `.env.example` documents the connection string. Repo-local `opencode.json` denies reads of `.env*` except `.env.example`.

## Commands and verification

- Use npm with `package-lock.json`. Locked Prisma 7.10.1 requires Node `^20.19 || ^22.12 || >=24.0`.
- The Prisma config is **`prisma7.config.ts`**, so pass `--config prisma7.config.ts` explicitly. Current npm Prisma scripts and `postinstall` omit that flag; they do not explicitly select this config.
  - Validate: `npx prisma validate --config prisma7.config.ts`
  - Generate after schema changes: `npm run prisma:generate -- --config prisma7.config.ts`
  - Create/apply a development migration: `npm run prisma:migrate -- --config prisma7.config.ts --name <name>` (requires PostgreSQL and `DATABASE_URL`).
  - Studio: `npm run prisma:studio -- --config prisma7.config.ts`
- Start watch mode with `npm run start:dev`. For production, run `npm run build` before `npm run start:prod`.
- `npm run lint` modifies files (`--fix`). For a read-only check use `npx eslint "{src,apps,libs,test}/**/*.ts"`. `npm run format` only formats TypeScript under `src/` and `test/`.
- `npm run typecheck` covers `src/` and `test/`; `npm run build` excludes test files. Neither verifies the root Prisma config.
- Unit tests: `npm test -- --runInBand`; one file: `npm test -- --runInBand --runTestsByPath src/app.controller.spec.ts`. Jest's unit-test root is `src/`.
- E2E tests use a separate config: `npm run test:e2e -- --runInBand`. They import `AppModule`, need PostgreSQL, and do not run `src/main.ts`'s dotenv import; provide `DATABASE_URL` in the test process environment.
- The unit Jest config maps relative `.js` imports back to TypeScript for generated Prisma code; `test/jest-e2e.json` currently lacks that mapping. If E2E imports fail on generated `.js` paths, check this config difference first.

## Agent skills

- Issues and planning maps live in GitHub Issues; external PRs are not a request-triage surface. See `docs/agents/issue-tracker.md`.
- Use the default five triage labels. Wayfinding decisions use only `wayfinder:*` labels. See `docs/agents/triage-labels.md`.
- Domain docs use a single context: root `CONTEXT.md` and `docs/adr/`, created as needed. See `docs/agents/domain.md`.
