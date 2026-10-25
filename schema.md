// Use DBML to define your database structure
// Docs: https://dbml.dbdiagram.io/docs

Enum DocumentType {
NATIONAL_ID
BIRTH_CERTIFICATE
BACHELOR_CERTIFICATE
MASTER_CERTIFICATE
TRANSCRIPT
MILITARY_CERTIFICATE
PERSONAL_PHOTO
EQUIVALENCY_DECISION
NON_ENROLLMENT_DECLARATION
OTHER
}

Table Document {
id integer [primary key, increment]
student_id integer [not null, ref: > Student.id]
qualification_id integer [ref: > StudentQualification.id]
document_type DocumentType [not null]
original_file_name varchar [not null]
stored_file_path varchar [not null, unique]
mime_type varchar [not null]
file_size integer [not null]
uploaded_at timestamp [not null, default: `now()`]
}

Table StaffUser {
id integer [primary key]
username varchar
password_hash varchar
full_name varchar
}

Enum InstitutionType {
PUBLIC_UNIVERSITY
PRIVATE_UNIVERSITY
NATIONAL_UNIVERSITY
PRIVATE_INSTITUTE
PUBLIC_INSTITUTE
FOREIGN_INSTITUTION
OTHER
}

Table EducationalInstitution {
id integer [primary key]
name varchar [not null]
institution_type InstitutionType
}

Table Faculty {
id integer [primary key]
name varchar [not null]
university_id integer [not null, ref: > EducationalInstitution.id]

indexes {
(university_id, name) [unique]
}
}

Table Department {
id integer [primary key]
name varchar [not null]
faculty_id integer [not null, ref: > Faculty.id]

indexes {
(faculty_id, name) [unique]
}
}

Enum MilitaryStatus {
Completed
Exempted
Postponed
}

Enum EnrollmentType {
MASTER
PHD
PROFESSIONAL
}

Enum EnrollmentStatus {
ACTIVE
COMPLETED
CANCELLED
}

Table StudentEnrollment {
id integer [primary key, increment]
student_id integer [not null, ref: > Student.id]
enrollment_type EnrollmentType [not null]
department_id integer [not null, ref: > Department.id]
enrollment_number varchar [not null, unique]
enrollment_date date [not null]
status EnrollmentStatus [not null, default: 'ACTIVE']
}

Enum Equivalency_Status {
NOT_REQUIRED
REQUIRED
PENDING
APPROVED
REJECTED
}

Table Student {
id integer [primary key]
full_name varchar [not null]
national_id varchar(14) [not null, unique]
photo_url varchar
phone varchar
birth_date date
address varchar
graduate_department_id integer [not null, ref: > Department.id]
degree_level DegreeType
degree_name varchar
military_status MilitaryStatus
created_at timestamp [default: `now()`]
updated_at timestamp [default: `now()`]
deleted_at timestamp [default: null]
}

Table StudentQualification {
id integer [primary key, increment]
student_id integer [not null, ref: > Student.id]
degree_level varchar [not null]
department_id integer [ref: > Department.id]
graduation_year integer
overall_grade varchar
equivalency_status EquivalencyStatus [not null, default: 'NOT_REQUIRED']
equivalency_decision_number varchar
equivalency_decision_date date
}

Table Thesis {
id integer [primary key, increment]
enrollment_id integer [not null, unique, ref: > StudentEnrollment.id]

title_ar varchar [not null]
title_en varchar [not null]
registration_date date [not null]
}

Enum AcademicRank {
PROFESSOR
ASSOCIATE_PROFESSOR
}

Enum SupervisorAffiliation {
INTERNAL
EXTERNAL
}

Table Supervisor {
id integer [primary key, increment]
full_name varchar [not null]
national_id varchar(14) [unique]
phone varchar
email varchar
academic_rank AcademicRank [not null]
affiliation SupervisorAffiliation [not null]
workplace varchar
department_id integer [ref: > Department.id]
created_at timestamp [not null, default: `now()`]
}

Enum SupervisorRole {
Main
CoSupervisor
}

Table ThesisSupervisor {
thesis_id integer [not null, ref: > Thesis.id]
supervisor_id integer [not null, ref: > Supervisor.id]
role SupervisorRole

indexes {
(thesis_id, supervisor_id) [pk]
}
}

Table EnrollmentAcademicSupervisor {
enrollment_id integer [not null, ref: > StudentEnrollment.id]
supervisor_id integer [not null, ref: > Supervisor.id]
assigned_at date

indexes {
(enrollment_id, supervisor_id) [pk]
}
}
