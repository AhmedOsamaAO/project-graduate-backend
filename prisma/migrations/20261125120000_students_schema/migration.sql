CREATE TYPE "military_status" AS ENUM ('COMPLETED', 'EXEMPTED', 'POSTPONED');

ALTER TYPE "history_record_type" ADD VALUE 'STUDENT';

ALTER TYPE "history_action" ADD VALUE 'ARCHIVED';
ALTER TYPE "history_action" ADD VALUE 'RESTORED';

CREATE TABLE "student" (
  "id" SERIAL PRIMARY KEY,
  "full_name" VARCHAR(200) NOT NULL,
  "national_id" VARCHAR(14) NOT NULL UNIQUE,
  "phone" VARCHAR(50),
  "birth_date" DATE,
  "address" VARCHAR(500),
  "military_status" military_status,
  "selected_photo_document_id" INTEGER,
  "archived_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT student_full_name_nonempty CHECK (length(btrim(full_name)) > 0),
  CONSTRAINT student_national_id_format CHECK (national_id COLLATE "C" ~ '^[0-9]{14}$'),
  CONSTRAINT student_phone_nonempty CHECK (phone IS NULL OR length(btrim(phone)) > 0),
  CONSTRAINT student_address_nonempty CHECK (address IS NULL OR length(btrim(address)) > 0),
  CONSTRAINT student_selected_photo_positive CHECK (
    selected_photo_document_id IS NULL OR selected_photo_document_id > 0
  )
);

CREATE INDEX student_archived_at_id_idx ON student(archived_at, id);
CREATE INDEX student_full_name_idx ON student(full_name);

REVOKE ALL ON student FROM PUBLIC, graduate_runtime;
GRANT SELECT, INSERT, UPDATE ON student TO graduate_runtime;
REVOKE ALL ON SEQUENCE student_id_seq FROM PUBLIC, graduate_runtime;
GRANT USAGE, SELECT ON SEQUENCE student_id_seq TO graduate_runtime;
