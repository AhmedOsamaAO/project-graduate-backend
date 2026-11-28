CREATE TYPE "degree_level" AS ENUM ('BACHELOR', 'MASTER', 'PHD', 'PROFESSIONAL');

CREATE TYPE "equivalency_status" AS ENUM (
  'NOT_ASSESSED',
  'NOT_REQUIRED',
  'REQUIRED',
  'PENDING',
  'APPROVED',
  'REJECTED'
);

ALTER TYPE "history_record_type" ADD VALUE 'STUDENT_QUALIFICATION';

ALTER TABLE "faculty"
  ADD CONSTRAINT "faculty_id_institution_id_key" UNIQUE ("id", "institution_id");

ALTER TABLE "department"
  ADD CONSTRAINT "department_id_faculty_id_key" UNIQUE ("id", "faculty_id");

CREATE TABLE "student_qualification" (
  "id" SERIAL PRIMARY KEY,
  "student_id" INTEGER NOT NULL REFERENCES student(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "degree_level" degree_level NOT NULL,
  "qualification_name" VARCHAR(200),
  "institution_id" INTEGER REFERENCES educational_institution(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "faculty_id" INTEGER,
  "department_id" INTEGER,
  "graduation_year" INTEGER,
  "overall_grade" VARCHAR(100),
  "equivalency_status" equivalency_status NOT NULL DEFAULT 'NOT_ASSESSED',
  "equivalency_decision_number" VARCHAR(100),
  "equivalency_decision_date" DATE,
  "archived_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT student_qualification_faculty_id_institution_id_fkey
    FOREIGN KEY (faculty_id, institution_id)
    REFERENCES faculty(id, institution_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT student_qualification_department_id_faculty_id_fkey
    FOREIGN KEY (department_id, faculty_id)
    REFERENCES department(id, faculty_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT student_qualification_id_student_id_key UNIQUE (id, student_id),
  CONSTRAINT student_qualification_name_nonempty CHECK (
    qualification_name IS NULL OR length(btrim(qualification_name)) > 0
  ),
  CONSTRAINT student_qualification_overall_grade_nonempty CHECK (
    overall_grade IS NULL OR length(btrim(overall_grade)) > 0
  ),
  CONSTRAINT student_qualification_graduation_year_positive CHECK (
    graduation_year IS NULL OR graduation_year > 0
  ),
  CONSTRAINT student_qualification_hierarchy_coherent CHECK (
    (faculty_id IS NULL OR institution_id IS NOT NULL)
    AND (department_id IS NULL OR faculty_id IS NOT NULL)
  ),
  CONSTRAINT student_qualification_decision_number_nonempty CHECK (
    equivalency_decision_number IS NULL OR length(btrim(equivalency_decision_number)) > 0
  ),
  CONSTRAINT student_qualification_equivalency_approved_details CHECK (
    equivalency_status <> 'APPROVED'
    OR (
      equivalency_decision_number IS NOT NULL
      AND equivalency_decision_date IS NOT NULL
    )
  )
);

CREATE FUNCTION enforce_student_qualification_immutable_owner() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.student_id IS DISTINCT FROM OLD.student_id THEN
    RAISE EXCEPTION 'student_qualification.student_id is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER student_qualification_immutable_owner
BEFORE UPDATE OF student_id ON student_qualification
FOR EACH ROW EXECUTE FUNCTION enforce_student_qualification_immutable_owner();

CREATE INDEX student_qualification_student_id_archived_at_id_idx
  ON student_qualification(student_id, archived_at, id);
CREATE INDEX student_qualification_institution_id_idx
  ON student_qualification(institution_id);
CREATE INDEX student_qualification_faculty_id_idx
  ON student_qualification(faculty_id);
CREATE INDEX student_qualification_department_id_idx
  ON student_qualification(department_id);

REVOKE ALL ON student_qualification FROM PUBLIC, graduate_runtime;
GRANT SELECT, INSERT, UPDATE ON student_qualification TO graduate_runtime;
REVOKE ALL ON SEQUENCE student_qualification_id_seq FROM PUBLIC, graduate_runtime;
GRANT USAGE, SELECT ON SEQUENCE student_qualification_id_seq TO graduate_runtime;
