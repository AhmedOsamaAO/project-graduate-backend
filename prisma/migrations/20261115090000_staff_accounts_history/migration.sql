CREATE TYPE "history_record_type" AS ENUM ('STAFF_USER');
CREATE TYPE "history_action" AS ENUM ('ACCOUNT_PROVISIONED', 'PASSWORD_RESET', 'ACCOUNT_DEACTIVATED');
CREATE TYPE "history_actor_kind" AS ENUM ('STAFF', 'OPERATOR', 'UNAUTHENTICATED');

CREATE TABLE "staff_user" (
  "id" SERIAL PRIMARY KEY,
  "username" VARCHAR(100) NOT NULL UNIQUE,
  "full_name" VARCHAR(200) NOT NULL,
  "password_hash" TEXT NOT NULL,
  "deactivated_at" TIMESTAMPTZ(3),
  "auth_version" INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT staff_username_canonical CHECK (
    username COLLATE "C" ~ '^[a-z0-9._-]+$' AND length(username) BETWEEN 1 AND 100
  ),
  CONSTRAINT staff_full_name_nonempty CHECK (length(btrim(full_name)) > 0)
);

CREATE TABLE "staff_session" (
  "id" SERIAL PRIMARY KEY,
  "staff_user_id" INTEGER NOT NULL REFERENCES staff_user(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "credential_digest" CHAR(64) NOT NULL UNIQUE CHECK (credential_digest ~ '^[0-9a-f]{64}$'),
  "auth_version" INTEGER NOT NULL CHECK (auth_version > 0),
  "csrf_secret" TEXT NOT NULL CHECK (length(csrf_secret) >= 32),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT session_timestamps CHECK (last_seen_at >= created_at AND absolute_expires_at > created_at)
);
CREATE INDEX staff_session_staff_user_id_idx ON staff_session(staff_user_id);
CREATE INDEX staff_session_absolute_expires_at_idx ON staff_session(absolute_expires_at);

CREATE TABLE "change_history" (
  "id" SERIAL PRIMARY KEY,
  "record_type" history_record_type NOT NULL,
  "record_id" INTEGER NOT NULL CHECK (record_id > 0),
  "action" history_action NOT NULL,
  "actor_kind" history_actor_kind NOT NULL,
  "staff_user_id" INTEGER REFERENCES staff_user(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "operator_attribution" VARCHAR(200),
  "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "before" JSONB,
  "after" JSONB,
  "operation_correlation" VARCHAR(200) UNIQUE,
  CONSTRAINT history_actor CHECK (
    (actor_kind = 'STAFF' AND staff_user_id IS NOT NULL AND operator_attribution IS NULL) OR
    (actor_kind = 'OPERATOR' AND staff_user_id IS NULL AND length(btrim(operator_attribution)) > 0 AND operator_attribution IS NOT NULL) OR
    (actor_kind = 'UNAUTHENTICATED' AND staff_user_id IS NULL AND operator_attribution IS NULL)
  )
);
CREATE INDEX change_history_record_type_record_id_occurred_at_id_idx ON change_history(record_type, record_id, occurred_at, id);
CREATE INDEX change_history_staff_user_id_idx ON change_history(staff_user_id);

-- This non-login group owns nothing. Operators provision separate LOGIN members.
-- The migration connection requires CREATEROLE, and is never used by the app.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'graduate_runtime') THEN
    CREATE ROLE graduate_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'graduate_runtime' AND
    (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'graduate_runtime'::regrole) THEN
    RAISE EXCEPTION 'graduate_runtime must be a non-privileged non-login role without parent roles';
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO graduate_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_user, staff_session TO graduate_runtime;
REVOKE ALL ON change_history FROM PUBLIC, graduate_runtime;
GRANT SELECT, INSERT ON change_history TO graduate_runtime;
GRANT USAGE, SELECT ON SEQUENCE staff_user_id_seq, staff_session_id_seq, change_history_id_seq TO graduate_runtime;
