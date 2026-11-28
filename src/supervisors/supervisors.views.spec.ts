import {
  AcademicRank,
  ExternalApprovalStatus,
  SupervisorAffiliation,
} from '../generated/prisma/client';
import { supervisorView, toSupervisorSnapshot } from './supervisors.views';

describe('supervisors views', () => {
  it('projects only allowlisted DTO fields with ISO timestamps', () => {
    const now = new Date('2026-11-28T10:00:00.000Z');
    const row = {
      id: 3,
      fullName: 'Dr. Nadia Kamal',
      academicRank: AcademicRank.ASSOCIATE_PROFESSOR,
      affiliation: SupervisorAffiliation.EXTERNAL,
      departmentId: null,
      workplace: 'Alexandria University',
      phone: '01000000001',
      email: 'nadia@alexu.edu.eg',
      nationalId: '0098765',
      externalApprovalStatus: ExternalApprovalStatus.PENDING,
      externalRejectionReason: null,
      deactivatedAt: null,
      version: 2,
      createdAt: now,
      updatedAt: now,
      internalOnlyField: 'secret',
    };

    const view = supervisorView(row);
    expect(view).toEqual({
      id: 3,
      fullName: 'Dr. Nadia Kamal',
      academicRank: AcademicRank.ASSOCIATE_PROFESSOR,
      affiliation: SupervisorAffiliation.EXTERNAL,
      departmentId: null,
      workplace: 'Alexandria University',
      phone: '01000000001',
      email: 'nadia@alexu.edu.eg',
      nationalId: '0098765',
      externalApprovalStatus: ExternalApprovalStatus.PENDING,
      externalRejectionReason: null,
      deactivatedAt: null,
      version: 2,
      createdAt: '2026-11-28T10:00:00.000Z',
      updatedAt: '2026-11-28T10:00:00.000Z',
    });
    expect(view).not.toHaveProperty('internalOnlyField');

    const snapshot = toSupervisorSnapshot(row);
    expect(snapshot.deactivatedAt).toBeNull();
    expect(snapshot.version).toBe(2);
  });
});
