# Operator-managed staff accounts

This slice and the authentication layer provide operator account commands,
session storage, append-only history, staff sign-in/logout/session/CSRF routes
under `/api/v1/auth/*`, and self-service password change. Account provisioning,
password reset, and deactivation remain operator-only; there is **no** public
registration, roles, or HTTP account-administration workflow. Each person needs
an individual account; there are no default passwords.

## Database setup

Use Node from `.nvmrc` (`nvm use`), `npm ci`, then `npm run build`.
Set up a dedicated database owned by a migration-only operator login. That login
needs `CREATEROLE` for the initial migration, or a DBA must perform that migration.
Use a separate non-owner service login with no superuser, database creation, role
creation, replication, bypass-RLS, or membership in privileged roles.

1. In the operator environment only, set `MIGRATION_DATABASE_URL` to the owner
   connection and run `npm run prisma:deploy`. There is no fallback to
   `DATABASE_URL`, and startup never applies migrations.
2. The migration creates a non-login `graduate_runtime` group. Provision a login
   using `psql` connected as an authorized operator (substitute your login name):

   ```sql
   CREATE ROLE graduate_app LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   \password graduate_app
   GRANT graduate_runtime TO graduate_app;
   ```

   `\password` prompts without putting the password into SQL history. Do not make
   this login an owner or grant it other memberships. Grant `CONNECT` on the
   application database if your installation revokes the default PUBLIC access.
3. Set `DATABASE_URL` to that login for both the service and account commands.
   Connect directly as that runtime login rather than masking another login
   with `SET ROLE` (`current_user` must match `session_user`). Keep
   `MIGRATION_DATABASE_URL` out of the service environment. Example variables
   are in `.env.example`; store real configuration with restricted permissions.
4. Build and start the application normally. Startup and commands reject unsafe
   history privileges. The migration assumes a dedicated application database
   and revokes `CREATE` on schema `public` from `PUBLIC` (matching PostgreSQL
   15+ defaults). The runtime group has `SELECT`/`INSERT` on `change_history`
   (no table/column `UPDATE`, `DELETE`, `TRUNCATE`, or `TRIGGER`),
   `USAGE`/`SELECT` on `change_history_id_seq` (no `UPDATE`/`setval`),
   `SELECT`/`INSERT`/`UPDATE` on `staff_user` (no `DELETE`/`TRUNCATE`), and
   `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `staff_session`, and cannot own
   those objects or inherit their owner's rights. Migration credentials remain
   trusted operator credentials and can alter schema/data: never share them with
   staff or the running service. Future migrations must explicitly grant only the
   privileges their new tables need; there are no broad default table grants.

The username safety limit is 100 ASCII letters/digits/`.`/`_`/`-`, trimmed and
lowercased. Full names are nonempty trimmed text, at most 200 characters. Operator
attribution is a named person or accountable host identity, 1–200 printable
characters. It is an operator assertion, not a staff user ID or administrator role.
Argon2id uses 64 MiB memory, three iterations and one lane, with an independent
random salt per hash. Passwords need at least 12 Unicode characters and at most
1024 UTF-8 bytes, with no composition rule or periodic expiry.

## Account commands

After `npm run build`, create an account interactively:

```sh
npm run staff -- create --operator 'Ahmed (office host)' --username office.user --full-name 'Office User'
```

On a terminal, passwords are entered in a masked prompt with confirmation
written to `stderr` (requiring a terminal on both `stdin` and `stderr`) so
`stdout` stays clean `{ "data": ... }` JSON even when redirected or piped. For
automation, pipe **one password line** from a protected secret source into the
same command; a final LF/CRLF is removed, not password whitespace. No password
option, positional password, environment-password variable, or password default
is supported. Never embed a real password in shell commands, shell history, or
process arguments. Stdin is bounded and multiple lines are rejected.

Successful commands print `{ "data": { ... } }`, including the account ID and
version, but no hashes or authentication material. Record the returned version.
Use the current version for subsequent commands:

```sh
npm run staff -- reset --operator 'Ahmed (office host)' --id 1 --expected-version 1
npm run staff -- deactivate --operator 'Ahmed (office host)' --id 1 --expected-version 2
```

Reset uses the same password input flow. Deactivation never prompts for a
password. Both increment the account and credential versions, delete **all**
sessions, and append operator-attributed history in one serializable transaction.
Deactivated accounts cannot be reset or deactivated again; no reactivation
workflow is included. There is no account deletion command.

`STALE_VERSION` means another command committed first: inspect the account via
operator SQL using the safe columns `id, username, full_name, deactivated_at,
version, created_at, updated_at`, then explicitly decide whether to retry with
its current version. Do not query/dump password hashes. A `RETRYABLE_CONFLICT`
means three serialization/deadlock attempts were exhausted; retry the original
command/version, never automatically replace it with a fresh version. Unknown
errors are sanitized; commands exit nonzero and never print raw database errors.
After a lost process/output, inspect current state/history before repeating a
command: commands are versioned, not idempotency-key APIs.

History uses explicit allowlisted account views. It excludes passwords, hashes,
credential versions, session credentials/digests and CSRF material. A failed
history append rolls back its owning mutation. History is not operational logs
or event sourcing; no staff-facing account-history endpoint is added here.

## Session cleanup

The running application sweeps expired or revoked sessions periodically on the
configurable `SESSION_CLEANUP_INTERVAL_MINUTES` cadence (15 minutes by default)
and drains any active sweep on shutdown. Operators can also run an explicit
cleanup pass after `npm run build` using the restricted runtime `DATABASE_URL`
(and optional `SESSION_IDLE_TIMEOUT_MINUTES`, defaulting to 120):

```sh
npm run session:cleanup
```

It prints `{ "data": { "deletedCount": ... } }` on `stdout` and refuses
privileged database connections.

## Verification

`npm run test:db` uses disposable databases and separate restricted LOGINs,
including real UPDATE/DELETE/TRUNCATE denial, concurrent account commands,
session invalidation and rollback when history insertion fails. Its configured
test server login needs database/role creation privileges; never point the test
harness at an office database login. Application E2E tests also use the restricted
runtime login. See `.env.test.example` for test server setup.
