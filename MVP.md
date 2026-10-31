# Graduate Records Backend — MVP

## Goal and status

Provide a staff-operated backend for managing graduate student records, qualifications, supporting documents, enrollments, and academic/thesis supervision.

This is the implementation target, not a description of delivered features. The repository currently contains the NestJS starter endpoint and Prisma connection wiring; `prisma/schema.prisma` has no domain models yet. The starting domain design is the DBML in `schema.md`. Confirmed decisions below override conflicting parts of that design.

## Confirmed scope

- Include all workflows represented in `schema.md`.
- Staff are the only application users. Provision username/password accounts through a seed or operator; no public registration, student login, or administrator-role workflow in this MVP.
- `StudentQualification` owns degree history. Remove the planned `Student.degree_level` and `Student.degree_name` fields. Qualification degree levels are `BACHELOR`, `MASTER`, `PHD`, and `PROFESSIONAL`.
- Store uploaded files on the backend filesystem and their metadata in PostgreSQL. Staff can upload and download files.
- Serve only the Computer and Information faculty's postgraduate office at Zagazig University and its departments. The operating office is fixed, not selectable through a settings table or environment variable; other institutions and faculties remain in the reference catalog for awarded qualifications and external affiliations. An office representative can confirm academic rules.
- Plan one overall delivery milestone for real university-office use. The graduation demonstration is a checkpoint; revisions may follow it, and deployment, migration, testing, and operational requirements must be completed before actual office use.
- Run the backend locally for now. A separate frontend team is available to agree on the API contract.
- Follow the confirmed [backend model, module interfaces, and verification resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/11#issuecomment-6541501606) for the reconciled records, fixed-office provisioning, IDs, referential policies, versioned transactions, module interfaces, recoverable file operations, session/history safeguards, HTTP conventions, tooling fixes, and test strategy. These are approved engineering decisions, not implemented functionality.
- Follow the project-approved [operating environment and readiness resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/10#issuecomment-6540966261) for hosting, HTTPS and frontend origins, configuration, manual releases, go-live backups and restore rehearsal, host baseline, and the go-live readiness checklist. That resolution is the canonical rule set; its numbers and technical defaults are planning assumptions, not university policy, and its unconfirmed facts stay open.
- Use manual record entry and the confirmed domain rules for this MVP. Collecting Word examples, historical-record import/migration, and office-template document generation are deferred beyond the MVP because office document access is not yet available; revisit them as a separate effort when access is granted. Supporting-file uploads/downloads remain in scope.

## Workflows and acceptance targets

### 1. Staff access

- Follow the project-approved [staff authentication and frontend API resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/8#issuecomment-6472624294) for sessions, account administration, password policy, API conventions, and authenticated file transfer. That resolution is the canonical technical rule set.
- Provision accounts through operator commands, with no public registration. Use individual accounts with equal staff permissions.
- Use PostgreSQL-backed sessions with an HttpOnly cookie, CSRF/origin protection, Argon2id password hashes, and all-session invalidation on password reset, password change, or deactivation.

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

- Follow the user-confirmed [document storage, photo, and lifecycle resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/7#issuecomment-6461404991) for ownership, supported formats/size, private authenticated access, required evidence, archive/restore, and explicit permanent deletion. That resolution is the canonical rule set; its technical defaults are not university policy.
- Support student documents with optional same-student qualification links, plus supervisor-owned supporting documents. Add PhD/professional certificate categories and replace `Student.photo_url` with a selected personal-photo document reference.
- Store files locally outside public web folders with safe generated storage names. Support PDF/JPEG/PNG/DOCX/XLSX with a configurable 10 MiB default limit; photos accept JPEG/PNG only.
- Preserve archived files until explicitly permanently deleted by staff, then retain minimal deletion metadata. This permission applies only to document files, not their parent academic records; photo and supervisor-approval safeguards remain enforced.

### 6. Enrollments

- Follow the office-confirmed [enrollment eligibility and lifecycle resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/4#issuecomment-6387376022) for official registrations, qualifying qualifications, faculty restrictions, numbering, status corrections, dates, and preservation. That resolution is the canonical rule set.
- Support `MASTER`, `PHD`, and `PROFESSIONAL` enrollments with at most one `ACTIVE` enrollment per student. Historical records can be entered directly as `COMPLETED` or `CANCELLED`.
- Preserve staff-entered official numbers as text; duplicates are allowed. Use an internal ID to identify enrollments.
- Add the qualifying-qualification reference and lifecycle date/reason fields; completion does not automatically create a qualification. No permanent enrollment deletion or separate enrollment archive is planned.

### 7. Supervisors and academic assignments

- Follow the office-confirmed [supervision and thesis resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/5#issuecomment-6395010848) for supervisor ranks, affiliation-specific fields, external approval/documents, deactivation, and assignment eligibility. That resolution is the canonical rule set.
- Academic supervision applies only to professional enrollments: at most one current internal supervisor, with assignment allowed after enrollment creation.
- Add `LECTURER` and `ASSOCIATE_LECTURER` ranks. Retain current assignments without requiring previous assignment history or effective dates.
- Follow the project-approved [supervisor-correction clarification](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/5#issuecomment-6541382846) for guarded rank/affiliation corrections; it does not broaden the retained-assignment exceptions for deactivation or approval loss.

### 8. Theses and thesis supervision

- Follow the linked supervision and thesis resolution for academic-only thesis eligibility, registration dates, historical entry/corrections, and team constraints.
- Register Arabic/English titles, date, and a valid current team together. Master’s teams contain 1–3 supervisors; PhD teams contain 1–4, with exactly one internal main supervisor at professor/associate-professor rank.
- Preserve withdrawn mistaken theses instead of deleting or moving them. Allow at most one non-withdrawn thesis per enrollment, including replacement after withdrawal.

### 9. Change history

- Follow the project-approved [operating environment and readiness resolution](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/10#issuecomment-6540966261) for office change-history needs. This adds scope not present in `schema.md`.
- Record an append-only history of creates, updates, archives, restores, status changes, permanent document deletions, and account events, identifying the individual staff user, time, record, and old/new values. Do not log reads or downloads, and never store password values.
- Any staff user can view a record's history read-only. History cannot be edited or deleted through the application and is retained for the life of the system.

## Schema reconciliation before modeling

- **Degree fields:** `Student.degree_level` uses undefined `DegreeType`; qualifications use a string. Remove student degree fields and define the confirmed degree enum on qualifications.
- **Equivalency enum:** The enum is declared as `Equivalency_Status` but referenced as `EquivalencyStatus`. Use one enum named `EquivalencyStatus`, retaining the existing values and adding `NOT_ASSESSED` as the new default per the qualification resolution.
- **Qualification fields:** Add optional qualification name and awarding institution/faculty references with hierarchy consistency, plus archive support, as specified by the qualification resolution.
- **ID generation:** Use auto-incrementing PostgreSQL integer IDs for ordinary records and composite keys for natural join records, per the backend-model resolution. Provision fixed operating institution/faculty identifiers safely; session credentials and storage keys use independent secure random values.
- **Session and account model:** Add session persistence and any account-deactivation/reset fields required by the authentication resolution; do not expose password hashes or session identifiers through API responses.
- **Graduate department:** Remove `Student.graduate_department_id` per the office-confirmed student-record resolution; do not replace it with a derived student-level summary.
- **Enrollment model:** Remove official-number uniqueness and add a qualifying-qualification reference and completion/cancellation fields. Enforce the one-active-enrollment and referenced-qualification rules from the enrollment resolution.
- **Supervision model:** Add lecturer ranks, external approval/deactivation and supervisor-owned documents. Model current-only supervision with at most one professional academic supervisor; replace unconditional thesis/enrollment uniqueness with the non-withdrawn-thesis rule from the supervision resolution.
- **Document model:** Reconcile student/supervisor ownership, expanded certificate categories, the selected-photo reference, and document archive/deletion metadata with the document resolution. Preserve retryable file/database failure handling and approval/photo safeguards.
- **Change history:** Add the separate append-only history structure confirmed in the backend-model resolution, with explicit actor kinds and old/new changed values. Commit mutation/history together and enforce runtime database write restrictions. Keep passwords, hashes, and session secrets out of it.
- **Deletion:** Apply the confirmed restrictive referential policies. No permanent deletion of students, qualifications, enrollments, theses, or supervisors; supporting-file deletion follows its explicit journaled protocol. Delete only unused non-fixed reference-catalog records. Pending document deletion blocks incompatible document changes and parent archival until completed or repaired.

No schema changes are made by this document. Reconcile these decisions into `prisma/schema.prisma` when implementing the data model; `schema.md` stays frozen as the original design, carrying a superseded banner.

## Delivery sequence

Follow the approved [implementation slices and planning handoff](https://github.com/AhmedOsamaAO/project-graduate-backend/issues/12#issuecomment-6541731508) for the ordered slices, their blocking edges, acceptance criteria, frontend contract reviews, and go-live tracking. That resolution replaces the earlier five-step sequence; it does not reduce first-release scope.

- The graduation demonstration targets slices 1–12 and 14 on synthetic data. Permanent document deletion (13), the operations toolkit (15), the frontend reviews, and the go-live checks must complete before real use.
- Each slice is complete when its workflow is exposed through the backend, persisted in PostgreSQL, and verified for relevant uniqueness, ownership, and access rules.
- Implementation issues are published separately from the planning map and are not its children.

## Release verification

- An operator can provision staff credentials, apply migrations, configure PostgreSQL and local document storage, and start the service from documented commands. The production smoke test is non-mutating; the full record path is verified by the end-to-end suite and on the restored rehearsal copy before each release.
- A staff user can complete the full record path: institution/department → student → qualification and documents → enrollment → academic supervisors → thesis and thesis supervisors.
- Verification covers invalid references, duplicate constrained values, cross-student qualification/document links, unauthenticated access, and file upload/download persistence.
- Type checking, build, relevant unit tests, and database-backed E2E checks pass. See `AGENTS.md` for current commands and test-environment quirks.

## Outside this MVP

Application backup/restore features, CI/CD, and in-app updates are also outside the application; go-live backups are host-level jobs described in the operating-environment resolution.

Student self-service, public registration, staff-role administration, object storage, and workflows absent from the schema (such as payments, coursework, grading, and thesis defense scheduling) are outside the confirmed first release.

Collecting representative office Word files, bulk/historical-record import, and generation of office documents from templates are also outside this MVP. Their deferral does not remove database schema migrations, manual historical-record entry, supporting-file handling, or operational verification before real use.
