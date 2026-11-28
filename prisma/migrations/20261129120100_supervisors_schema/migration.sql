CREATE TYPE "academic_rank" AS ENUM (
  'PROFESSOR',
  'ASSOCIATE_PROFESSOR',
  'LECTURER',
  'ASSOCIATE_LECTURER'
);

CREATE TYPE "supervisor_affiliation" AS ENUM (
  'INTERNAL',
  'EXTERNAL'
);

CREATE TYPE "external_approval_status" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED'
);

CREATE TABLE "supervisor" (
  "id" SERIAL PRIMARY KEY,
  "full_name" VARCHAR(200) NOT NULL,
  "academic_rank" academic_rank NOT NULL,
  "affiliation" supervisor_affiliation NOT NULL,
  "department_id" INTEGER REFERENCES department(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "workplace" VARCHAR(200),
  "phone" VARCHAR(50),
  "email" VARCHAR(254),
  "national_id" VARCHAR(50),
  "external_approval_status" external_approval_status,
  "external_rejection_reason" VARCHAR(500),
  "deactivated_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT supervisor_full_name_nonempty CHECK (length(btrim(full_name)) > 0),
  CONSTRAINT supervisor_workplace_nonempty CHECK (
    workplace IS NULL OR length(btrim(workplace)) > 0
  ),
  CONSTRAINT supervisor_phone_nonempty CHECK (
    phone IS NULL OR length(btrim(phone)) > 0
  ),
  CONSTRAINT supervisor_email_nonempty CHECK (
    email IS NULL OR length(btrim(email)) > 0
  ),
  CONSTRAINT supervisor_national_id_nonempty CHECK (
    national_id IS NULL OR length(btrim(national_id)) > 0
  ),
  CONSTRAINT supervisor_external_rejection_reason_nonempty CHECK (
    external_rejection_reason IS NULL OR length(btrim(external_rejection_reason)) > 0
  ),
  CONSTRAINT supervisor_affiliation_fields_coherent CHECK (
    (
      affiliation = 'INTERNAL'
      AND department_id IS NOT NULL
      AND workplace IS NULL
      AND external_approval_status IS NULL
      AND external_rejection_reason IS NULL
    ) OR (
      affiliation = 'EXTERNAL'
      AND workplace IS NOT NULL
      AND external_approval_status IS NOT NULL
      AND (
        external_approval_status = 'REJECTED'
        OR external_rejection_reason IS NULL
      )
    )
  )
);

CREATE FUNCTION enforce_internal_supervisor_operating_faculty() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.affiliation = 'INTERNAL' THEN
    IF NEW.department_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM department WHERE id = NEW.department_id AND faculty_id = 1
    ) THEN
      RAISE EXCEPTION 'Internal supervisor department must belong to the fixed operating faculty' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supervisor_internal_operating_faculty
BEFORE INSERT OR UPDATE OF affiliation, department_id ON supervisor
FOR EACH ROW EXECUTE FUNCTION enforce_internal_supervisor_operating_faculty();

CREATE FUNCTION prevent_reparenting_internal_supervisor_department() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.faculty_id = 1 AND NEW.faculty_id IS DISTINCT FROM 1 THEN
    IF EXISTS (
      SELECT 1 FROM supervisor WHERE affiliation = 'INTERNAL' AND department_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Department is referenced by an internal supervisor and cannot leave the operating faculty' USING ERRCODE = '23001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER department_prevent_internal_supervisor_reparent
BEFORE UPDATE OF faculty_id ON department
FOR EACH ROW EXECUTE FUNCTION prevent_reparenting_internal_supervisor_department();

CREATE INDEX supervisor_deactivated_at_id_idx ON supervisor(deactivated_at, id);
CREATE INDEX supervisor_full_name_idx ON supervisor(full_name);
CREATE INDEX supervisor_national_id_idx ON supervisor(national_id);
CREATE INDEX supervisor_department_id_idx ON supervisor(department_id);
CREATE INDEX supervisor_affiliation_external_approval_status_idx
  ON supervisor(affiliation, external_approval_status);

REVOKE ALL ON supervisor FROM PUBLIC, graduate_runtime;
GRANT SELECT, INSERT, UPDATE ON supervisor TO graduate_runtime;
REVOKE ALL ON SEQUENCE supervisor_id_seq FROM PUBLIC, graduate_runtime;
GRANT USAGE, SELECT ON SEQUENCE supervisor_id_seq TO graduate_runtime;

ALTER TABLE "document"
  ALTER COLUMN "student_id" DROP NOT NULL,
  ADD COLUMN "supervisor_id" INTEGER REFERENCES supervisor(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN "description" VARCHAR(500),
  ADD CONSTRAINT document_description_nonempty CHECK (
    description IS NULL OR length(btrim(description)) > 0
  ),
  ADD CONSTRAINT document_exclusive_owner CHECK (
    (
      student_id IS NOT NULL
      AND supervisor_id IS NULL
      AND document_type <> 'SUPERVISOR_SUPPORTING_DOCUMENT'
      AND description IS NULL
    ) OR (
      student_id IS NULL
      AND supervisor_id IS NOT NULL
      AND qualification_id IS NULL
      AND document_type = 'SUPERVISOR_SUPPORTING_DOCUMENT'
    )
  );

DROP TRIGGER document_immutable_fields ON document;

CREATE OR REPLACE FUNCTION enforce_document_immutable_fields() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.student_id IS DISTINCT FROM OLD.student_id
    OR NEW.supervisor_id IS DISTINCT FROM OLD.supervisor_id
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.original_file_name IS DISTINCT FROM OLD.original_file_name
    OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
    RAISE EXCEPTION 'Immutable document fields cannot be modified' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_immutable_fields
BEFORE UPDATE OF student_id, supervisor_id, storage_key, mime_type, byte_size, original_file_name, uploaded_at ON document
FOR EACH ROW EXECUTE FUNCTION enforce_document_immutable_fields();

CREATE INDEX document_supervisor_id_archived_at_availability_id_idx
  ON document(supervisor_id, archived_at, availability, id);

ALTER TABLE "file_operation"
  ALTER COLUMN "student_id" DROP NOT NULL,
  ADD COLUMN "supervisor_id" INTEGER REFERENCES supervisor(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT file_operation_exclusive_owner CHECK (
    (student_id IS NOT NULL AND supervisor_id IS NULL)
    OR (student_id IS NULL AND supervisor_id IS NOT NULL)
  );

CREATE INDEX file_operation_supervisor_id_idx ON file_operation(supervisor_id);
