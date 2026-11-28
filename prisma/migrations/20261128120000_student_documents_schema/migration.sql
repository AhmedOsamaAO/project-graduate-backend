ALTER TYPE "history_record_type" ADD VALUE 'DOCUMENT';

CREATE TYPE "document_type" AS ENUM (
  'NATIONAL_ID',
  'BIRTH_CERTIFICATE',
  'BACHELOR_CERTIFICATE',
  'MASTER_CERTIFICATE',
  'PHD_CERTIFICATE',
  'PROFESSIONAL_CERTIFICATE',
  'TRANSCRIPT',
  'MILITARY_CERTIFICATE',
  'PERSONAL_PHOTO',
  'EQUIVALENCY_DECISION',
  'NON_ENROLLMENT_DECLARATION',
  'OTHER'
);

CREATE TYPE "document_availability" AS ENUM (
  'AVAILABLE',
  'DELETE_PENDING',
  'DELETED'
);

CREATE TYPE "file_operation_kind" AS ENUM (
  'UPLOAD',
  'DELETE'
);

CREATE TYPE "file_operation_status" AS ENUM (
  'IN_PROGRESS',
  'CLEANUP_PENDING',
  'COMPLETED',
  'FAILED'
);

CREATE TABLE "document" (
  "id" SERIAL PRIMARY KEY,
  "student_id" INTEGER NOT NULL REFERENCES student(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "qualification_id" INTEGER,
  "document_type" document_type NOT NULL,
  "original_file_name" VARCHAR(255) NOT NULL,
  "storage_key" VARCHAR(64) NOT NULL UNIQUE,
  "mime_type" VARCHAR(128) NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMPTZ(3),
  "availability" document_availability NOT NULL DEFAULT 'AVAILABLE',
  "deleted_at" TIMESTAMPTZ(3),
  "deleted_by_staff_user_id" INTEGER REFERENCES staff_user(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT document_id_student_id_key UNIQUE (id, student_id),
  CONSTRAINT document_qualification_id_student_id_fkey
    FOREIGN KEY (qualification_id, student_id)
    REFERENCES student_qualification(id, student_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT document_original_file_name_nonempty CHECK (
    length(btrim(original_file_name)) > 0
  ),
  CONSTRAINT document_storage_key_format CHECK (
    storage_key COLLATE "C" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT document_mime_type_allowed CHECK (
    mime_type IN (
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  ),
  CONSTRAINT document_personal_photo_mime CHECK (
    document_type <> 'PERSONAL_PHOTO' OR mime_type IN ('image/jpeg', 'image/png')
  ),
  CONSTRAINT document_byte_size_positive CHECK (byte_size > 0),
  CONSTRAINT document_availability_deletion_coherent CHECK (
    (
      availability = 'AVAILABLE'
      AND deleted_at IS NULL
      AND deleted_by_staff_user_id IS NULL
    ) OR (
      availability = 'DELETE_PENDING'
      AND archived_at IS NOT NULL
      AND deleted_at IS NULL
      AND deleted_by_staff_user_id IS NULL
    ) OR (
      availability = 'DELETED'
      AND archived_at IS NOT NULL
      AND deleted_at IS NOT NULL
      AND deleted_by_staff_user_id IS NOT NULL
    )
  )
);

CREATE FUNCTION enforce_document_immutable_fields() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.student_id IS DISTINCT FROM OLD.student_id
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
BEFORE UPDATE OF student_id, storage_key, mime_type, byte_size, original_file_name, uploaded_at ON document
FOR EACH ROW EXECUTE FUNCTION enforce_document_immutable_fields();

CREATE INDEX document_student_id_archived_at_availability_id_idx
  ON document(student_id, archived_at, availability, id);
CREATE INDEX document_qualification_id_idx ON document(qualification_id);
CREATE INDEX document_deleted_by_staff_user_id_idx ON document(deleted_by_staff_user_id);

ALTER TABLE "student"
  ADD CONSTRAINT student_selected_photo_document_id_id_fkey
  FOREIGN KEY (selected_photo_document_id, id)
  REFERENCES document(id, student_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX student_selected_photo_document_id_idx ON student(selected_photo_document_id);

CREATE TABLE "file_operation" (
  "id" SERIAL PRIMARY KEY,
  "kind" file_operation_kind NOT NULL,
  "status" file_operation_status NOT NULL DEFAULT 'IN_PROGRESS',
  "requested_by_staff_user_id" INTEGER NOT NULL REFERENCES staff_user(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "student_id" INTEGER NOT NULL REFERENCES student(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "document_id" INTEGER REFERENCES document(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "request_fingerprint" CHAR(64),
  "staging_key" VARCHAR(64) UNIQUE,
  "storage_key" VARCHAR(64) NOT NULL,
  "executor_id" VARCHAR(64),
  "claim_token" VARCHAR(64),
  "lease_expires_at" TIMESTAMPTZ(3),
  "error_status" INTEGER,
  "error_code" VARCHAR(100),
  "error_message" VARCHAR(300),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "completed_at" TIMESTAMPTZ(3),
  CONSTRAINT file_operation_requested_by_staff_user_id_kind_idempotency_key_key
    UNIQUE (requested_by_staff_user_id, kind, idempotency_key),
  CONSTRAINT file_operation_idempotency_key_nonempty CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 128
  ),
  CONSTRAINT file_operation_fingerprint_format CHECK (
    request_fingerprint IS NULL OR request_fingerprint COLLATE "C" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT file_operation_staging_key_format CHECK (
    staging_key IS NULL OR staging_key COLLATE "C" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT file_operation_storage_key_format CHECK (
    storage_key COLLATE "C" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT file_operation_upload_staging_required CHECK (
    kind <> 'UPLOAD' OR staging_key IS NOT NULL
  ),
  CONSTRAINT file_operation_error_status_range CHECK (
    error_status IS NULL OR (error_status >= 400 AND error_status <= 599)
  ),
  CONSTRAINT file_operation_error_code_nonempty CHECK (
    error_code IS NULL OR length(btrim(error_code)) > 0
  ),
  CONSTRAINT file_operation_error_message_nonempty CHECK (
    error_message IS NULL OR length(btrim(error_message)) > 0
  ),
  CONSTRAINT file_operation_state_coherent CHECK (
    (
      status IN ('IN_PROGRESS', 'CLEANUP_PENDING')
      AND completed_at IS NULL
      AND (
        (error_status IS NULL AND error_code IS NULL AND error_message IS NULL)
        OR (
          status = 'CLEANUP_PENDING'
          AND error_status IS NOT NULL
          AND error_code IS NOT NULL
          AND error_message IS NOT NULL
        )
      )
    ) OR (
      status = 'COMPLETED'
      AND document_id IS NOT NULL
      AND completed_at IS NOT NULL
      AND claim_token IS NULL
      AND error_status IS NULL
      AND error_code IS NULL
      AND error_message IS NULL
    ) OR (
      status = 'FAILED'
      AND completed_at IS NOT NULL
      AND claim_token IS NULL
      AND error_status IS NOT NULL
      AND error_code IS NOT NULL
      AND error_message IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX file_operation_upload_storage_key_key
  ON file_operation(storage_key)
  WHERE kind = 'UPLOAD';
CREATE INDEX file_operation_status_lease_expires_at_id_idx
  ON file_operation(status, lease_expires_at, id);
CREATE INDEX file_operation_student_id_idx ON file_operation(student_id);
CREATE INDEX file_operation_document_id_idx ON file_operation(document_id);

REVOKE ALL ON document, file_operation FROM PUBLIC, graduate_runtime;
GRANT SELECT, INSERT, UPDATE ON document, file_operation TO graduate_runtime;
REVOKE ALL ON SEQUENCE document_id_seq, file_operation_id_seq FROM PUBLIC, graduate_runtime;
GRANT USAGE, SELECT ON SEQUENCE document_id_seq, file_operation_id_seq TO graduate_runtime;
