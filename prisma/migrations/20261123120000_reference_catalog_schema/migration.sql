CREATE TYPE "institution_type" AS ENUM (
  'PUBLIC_UNIVERSITY',
  'PRIVATE_UNIVERSITY',
  'NATIONAL_UNIVERSITY',
  'PRIVATE_INSTITUTE',
  'PUBLIC_INSTITUTE',
  'FOREIGN_INSTITUTION',
  'OTHER'
);

ALTER TYPE "history_record_type" ADD VALUE 'EDUCATIONAL_INSTITUTION';
ALTER TYPE "history_record_type" ADD VALUE 'FACULTY';
ALTER TYPE "history_record_type" ADD VALUE 'DEPARTMENT';

ALTER TYPE "history_action" ADD VALUE 'CREATED';
ALTER TYPE "history_action" ADD VALUE 'UPDATED';
ALTER TYPE "history_action" ADD VALUE 'DELETED';

CREATE TABLE "educational_institution" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(200) NOT NULL,
  "institution_type" institution_type NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT educational_institution_name_nonempty CHECK (length(btrim(name)) > 0)
);
CREATE INDEX educational_institution_institution_type_idx ON educational_institution(institution_type);
CREATE INDEX educational_institution_name_idx ON educational_institution(name);

CREATE TABLE "faculty" (
  "id" SERIAL PRIMARY KEY,
  "institution_id" INTEGER NOT NULL REFERENCES educational_institution(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "name" VARCHAR(200) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT faculty_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT faculty_institution_id_name_key UNIQUE (institution_id, name)
);
CREATE INDEX faculty_name_idx ON faculty(name);

CREATE TABLE "department" (
  "id" SERIAL PRIMARY KEY,
  "faculty_id" INTEGER NOT NULL REFERENCES faculty(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "name" VARCHAR(200) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT department_name_nonempty CHECK (length(btrim(name)) > 0),
  CONSTRAINT department_faculty_id_name_key UNIQUE (faculty_id, name)
);
CREATE INDEX department_name_idx ON department(name);

REVOKE ALL ON educational_institution, faculty, department FROM PUBLIC, graduate_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON educational_institution, faculty, department TO graduate_runtime;
REVOKE ALL ON SEQUENCE educational_institution_id_seq, faculty_id_seq, department_id_seq FROM PUBLIC, graduate_runtime;
GRANT USAGE, SELECT ON SEQUENCE educational_institution_id_seq, faculty_id_seq, department_id_seq TO graduate_runtime;
