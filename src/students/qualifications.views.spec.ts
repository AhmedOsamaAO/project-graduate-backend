import { DegreeLevel, EquivalencyStatus } from '../generated/prisma/client';
import {
  qualificationView,
  toQualificationSnapshot,
} from './qualifications.views';

describe('qualifications.views', () => {
  it('maps qualification records through an explicit allowlist with YYYY-MM-DD decision date and UTC timestamps', () => {
    const source = {
      id: 14,
      studentId: 7,
      degreeLevel: DegreeLevel.MASTER,
      qualificationName: 'M.Sc. in Information Systems',
      institutionId: 1,
      facultyId: 1,
      departmentId: 4,
      graduationYear: 2024,
      overallGrade: 'Excellent',
      equivalencyStatus: EquivalencyStatus.APPROVED,
      equivalencyDecisionNumber: 'EQ-2025/88',
      equivalencyDecisionDate: new Date('2025-03-19T00:00:00.000Z'),
      archivedAt: null,
      version: 2,
      createdAt: new Date('2026-11-26T09:00:00.000Z'),
      updatedAt: new Date('2026-11-26T10:30:00.000Z'),
      student: { archivedAt: null },
    };

    const view = qualificationView(source);
    expect(view).toEqual({
      id: 14,
      studentId: 7,
      degreeLevel: 'MASTER',
      qualificationName: 'M.Sc. in Information Systems',
      institutionId: 1,
      facultyId: 1,
      departmentId: 4,
      graduationYear: 2024,
      overallGrade: 'Excellent',
      equivalencyStatus: 'APPROVED',
      equivalencyDecisionNumber: 'EQ-2025/88',
      equivalencyDecisionDate: '2025-03-19',
      archivedAt: null,
      version: 2,
      createdAt: '2026-11-26T09:00:00.000Z',
      updatedAt: '2026-11-26T10:30:00.000Z',
    });
    expect(view).not.toHaveProperty('student');
  });

  it('formats nullable fields as null and creates immutable guard snapshots without extra properties', () => {
    const decisionDate = new Date('2025-02-01T00:00:00.000Z');
    const archivedAt = new Date('2026-11-27T11:00:00.000Z');
    const source = {
      id: 15,
      studentId: 8,
      degreeLevel: DegreeLevel.BACHELOR,
      qualificationName: null,
      institutionId: null,
      facultyId: null,
      departmentId: null,
      graduationYear: null,
      overallGrade: null,
      equivalencyStatus: EquivalencyStatus.NOT_ASSESSED,
      equivalencyDecisionNumber: null,
      equivalencyDecisionDate: null,
      archivedAt,
      version: 3,
      createdAt: new Date('2026-11-26T09:00:00.000Z'),
      updatedAt: archivedAt,
      student: { archivedAt: null },
    };

    expect(qualificationView(source)).toMatchObject({
      qualificationName: null,
      institutionId: null,
      facultyId: null,
      departmentId: null,
      graduationYear: null,
      overallGrade: null,
      equivalencyStatus: 'NOT_ASSESSED',
      equivalencyDecisionNumber: null,
      equivalencyDecisionDate: null,
      archivedAt: '2026-11-27T11:00:00.000Z',
      version: 3,
    });

    const snapshot = toQualificationSnapshot({
      ...source,
      equivalencyDecisionDate: decisionDate,
    });
    expect(snapshot).toEqual({
      id: 15,
      studentId: 8,
      degreeLevel: 'BACHELOR',
      qualificationName: null,
      institutionId: null,
      facultyId: null,
      departmentId: null,
      graduationYear: null,
      overallGrade: null,
      equivalencyStatus: 'NOT_ASSESSED',
      equivalencyDecisionNumber: null,
      equivalencyDecisionDate: decisionDate,
      archivedAt,
      version: 3,
    });
    expect(snapshot).not.toHaveProperty('student');
    expect(snapshot).not.toHaveProperty('createdAt');
    expect(snapshot).not.toHaveProperty('updatedAt');
  });
});
