# Graduate Records Backend — MVP

## Goal and status

Provide a staff-operated backend for managing graduate student records, qualifications, supporting documents, enrollments, and academic/thesis supervision.

This is the implementation target, not a description of delivered features. The repository currently contains the NestJS starter endpoint and Prisma connection wiring; `prisma/schema.prisma` has no domain models yet. The starting domain design is the DBML in `schema.md`. Confirmed decisions below override conflicting parts of that design.

## Confirmed scope

- Include all workflows represented in `schema.md`.
- Staff are the only application users. Provision username/password accounts through a seed or operator; no public registration, student login, or administrator-role workflow in this MVP.
- `StudentQualification` owns degree history. Remove the planned `Student.degree_level` and `Student.degree_name` fields. Qualification degree levels are `BACHELOR`, `MASTER`, `PHD`, and `PROFESSIONAL`.
- Store uploaded files on the backend filesystem and their metadata in PostgreSQL. Staff can upload and download files.
- Serve one faculty's postgraduate office and its departments within one university. An office representative can confirm academic rules.
- Plan one overall delivery milestone for real university-office use. The graduation demonstration is a checkpoint; revisions may follow it, and deployment, migration, testing, and operational requirements must be completed before actual office use.
- Run the backend locally for now. A separate frontend team is available to agree on the API contract.
- Investigate both entry/import of existing records, which are mostly Word files, and documents staff need to produce. Import and output approaches await representative examples and office confirmation.

## Workflows and acceptance targets

### 1. Staff access

- Provision a staff account and log in with its username/password.
- Persist password hashes using `StaffUser.password_hash`; never expose hashes in API responses.
- Require authenticated staff access to academic records and document uploads/downloads.
- Account provisioning must work without a public registration endpoint. Authentication mechanism and provisioning commands still need implementation decisions.

### 2. Academic reference data

- Manage educational institutions, their faculties, and faculty departments.
- Preserve `InstitutionType` values from `schema.md`.
- Enforce unique faculty names within an institution and unique department names within a faculty.
- Use this same department hierarchy for qualification, enrollment, and supervisor references; do not create parallel department catalogs or a student-level department reference.

### 3. Student records

- Follow the office-confirmed [student identity, department, and archive resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/2#issuecomment-6380474168) for required fields, Egyptian national-ID validation, corrections, archive/restore behavior, and identity reuse. That resolution is the canonical rule set.
- Create, retrieve, list, and update identity, contact, birth, address, and military-status data; retain creation/update timestamps and the designed archive field.
- Remove the student-level department; departments belong to qualifications and enrollments.
- Display degree history from qualifications rather than maintaining duplicate student-level degree fields.

### 4. Qualifications and equivalency

- Follow the office-confirmed [qualification and equivalency resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/3#issuecomment-6386670261) for awarded-degree records, optional awarding hierarchy and academic details, staff-assessed equivalency, corrections, and archive/restore behavior. That resolution is the canonical rule set.
- Use the confirmed qualification degree enum rather than the DBML's free-text `degree_level`; retain the unsubdivided professional track.
- Reconcile the planned model with optional qualification name, institution/faculty references, and qualification archive support. Add `NOT_ASSESSED` as the equivalency default; approval requires decision number/date.
- Follow the linked enrollment resolution for admission prerequisites and protection of referenced qualifications. Staff record awarded qualifications separately after enrollment completion.

### 5. Documents

- Upload and download student documents using the `DocumentType` values in `schema.md`.
- Persist original filename, unique stored path, MIME type, byte size, and upload timestamp; each document belongs to a student and may also reference a qualification.
- When a qualification is supplied, verify that it belongs to the same student as the document.
- Serve downloads through authenticated backend access. Upload directory, allowed MIME types, size limits, replacement/deletion policy, and filesystem/metadata failure handling remain to be defined.
- Resolve how `Student.photo_url` relates to a `PERSONAL_PHOTO` document before implementing photo updates.
- Include supervisor-owned supporting documents for external approval, as required by the linked supervision resolution. File access and lifecycle mechanics for these documents remain part of document planning.

### 6. Enrollments

- Follow the office-confirmed [enrollment eligibility and lifecycle resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/4#issuecomment-6387376022) for official registrations, qualifying qualifications, faculty restrictions, numbering, status corrections, dates, and preservation. That resolution is the canonical rule set.
- Support `MASTER`, `PHD`, and `PROFESSIONAL` enrollments with at most one `ACTIVE` enrollment per student. Historical records can be entered directly as `COMPLETED` or `CANCELLED`.
- Preserve staff-entered official numbers as text; duplicates are allowed. Use an internal ID to identify enrollments.
- Add the qualifying-qualification reference and lifecycle date/reason fields; completion does not automatically create a qualification. No permanent enrollment deletion or separate enrollment archive is planned.

### 7. Supervisors and academic assignments

- Follow the office-confirmed [supervision and thesis resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/5#issuecomment-6395010848) for supervisor ranks, affiliation-specific fields, external approval/documents, deactivation, and assignment eligibility. That resolution is the canonical rule set.
- Academic supervision applies only to professional enrollments: at most one current internal supervisor, with assignment allowed after enrollment creation.
- Add `LECTURER` and `ASSOCIATE_LECTURER` ranks. Retain current assignments without requiring previous assignment history or effective dates.

### 8. Theses and thesis supervision

- Follow the linked supervision and thesis resolution for academic-only thesis eligibility, registration dates, historical entry/corrections, and team constraints.
- Register Arabic/English titles, date, and a valid current team together. Master’s teams contain 1–3 supervisors; PhD teams contain 1–4, with exactly one internal main supervisor at professor/associate-professor rank.
- Preserve withdrawn mistaken theses instead of deleting or moving them. Allow at most one non-withdrawn thesis per enrollment, including replacement after withdrawal.

## Schema reconciliation before modeling

- **Degree fields:** `Student.degree_level` uses undefined `DegreeType`; qualifications use a string. Remove student degree fields and define the confirmed degree enum on qualifications.
- **Equivalency enum:** The enum is declared as `Equivalency_Status` but referenced as `EquivalencyStatus`. Use one enum named `EquivalencyStatus`, retaining the existing values and adding `NOT_ASSESSED` as the new default per the qualification resolution.
- **Qualification fields:** Add optional qualification name and awarding institution/faculty references with hierarchy consistency, plus archive support, as specified by the qualification resolution.
- **ID generation:** Several primary keys omit `increment`. Choose and consistently document ID generation before writing migrations; do not infer that every DBML ID auto-increments.
- **Graduate department:** Remove `Student.graduate_department_id` per the office-confirmed student-record resolution; do not replace it with a derived student-level summary.
- **Enrollment model:** Remove official-number uniqueness and add a qualifying-qualification reference and completion/cancellation fields. Enforce the one-active-enrollment and referenced-qualification rules from the enrollment resolution.
- **Supervision model:** Add lecturer ranks, external approval/deactivation and supervisor-owned documents. Model current-only supervision with at most one professional academic supervisor; replace unconditional thesis/enrollment uniqueness with the non-withdrawn-thesis rule from the supervision resolution.
- **Deletion:** Student and qualification archive/restore behavior and the absence of permanent deletion for both are settled in their linked resolutions. Referential deletion policies for other entities remain to be defined before destructive endpoints.

No schema changes are made by this document. Reconcile these decisions into `schema.md` and `prisma/schema.prisma` when implementing the data model.

## Delivery sequence

1. Resolve modeling blockers, create Prisma models/migrations, and add academic-data/staff provisioning.
2. Deliver staff authentication and academic reference-data management.
3. Deliver student records, qualifications/equivalency, and local documents as a usable record-management workflow.
4. Deliver enrollments and academic supervisor assignments.
5. Deliver thesis registration and thesis supervisor assignments.

Each slice is complete when its workflow is exposed through the backend, persisted in PostgreSQL, and verified for relevant uniqueness, ownership, and access rules. This order is a proposed implementation sequence, not a reduction of first-release scope.

## Release verification

- An operator can provision staff credentials, apply migrations, configure PostgreSQL and local document storage, and start the service from documented commands.
- A staff user can complete the full record path: institution/department → student → qualification and documents → enrollment → academic supervisors → thesis and thesis supervisors.
- Verification covers invalid references, duplicate constrained values, cross-student qualification/document links, unauthenticated access, and file upload/download persistence.
- Type checking, build, relevant unit tests, and database-backed E2E checks pass. See `AGENTS.md` for current commands and test-environment quirks.

## Outside this MVP

Student self-service, public registration, staff-role administration, object storage, and workflows absent from the schema (such as payments, coursework, grading, and thesis defense scheduling) are outside the confirmed first release.
