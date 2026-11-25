import { MilitaryStatus } from '../generated/prisma/client';
import { archivedStudentConflictDetails, studentView } from './students.views';

describe('students.views', () => {
  it('maps student records through an explicit DTO allowlist with calendar birthDate', () => {
    const view = studentView({
      id: 7,
      fullName: 'سارة محمد',
      nationalId: '00123456789012',
      phone: '01001234567',
      birthDate: new Date('1998-05-14T00:00:00.000Z'),
      address: 'Zagazig',
      militaryStatus: MilitaryStatus.EXEMPTED,
      selectedPhotoDocumentId: null,
      archivedAt: null,
      version: 2,
      createdAt: new Date('2026-11-25T10:00:00.000Z'),
      updatedAt: new Date('2026-11-25T11:00:00.000Z'),
    });

    expect(view).toEqual({
      id: 7,
      fullName: 'سارة محمد',
      nationalId: '00123456789012',
      phone: '01001234567',
      birthDate: '1998-05-14',
      address: 'Zagazig',
      militaryStatus: 'EXEMPTED',
      selectedPhotoDocumentId: null,
      archivedAt: null,
      version: 2,
      createdAt: '2026-11-25T10:00:00.000Z',
      updatedAt: '2026-11-25T11:00:00.000Z',
    });
    expect(view).not.toHaveProperty('degreeLevel');
    expect(view).not.toHaveProperty('graduateDepartmentId');
  });

  it('formats nullable fields as null when absent', () => {
    const view = studentView({
      id: 8,
      fullName: 'Omar',
      nationalId: '29901011234567',
      phone: null,
      birthDate: null,
      address: null,
      militaryStatus: null,
      selectedPhotoDocumentId: 12,
      archivedAt: new Date('2026-11-25T12:30:00.000Z'),
      version: 3,
      createdAt: new Date('2026-11-25T10:00:00.000Z'),
      updatedAt: new Date('2026-11-25T12:30:00.000Z'),
    });

    expect(view).toMatchObject({
      phone: null,
      birthDate: null,
      address: null,
      militaryStatus: null,
      selectedPhotoDocumentId: 12,
      archivedAt: '2026-11-25T12:30:00.000Z',
      version: 3,
    });
  });

  it('builds safe archived-student conflict details for authenticated staff', () => {
    const details = archivedStudentConflictDetails({
      id: 42,
      fullName: 'Nadia Hassan',
      nationalId: '00123456789012',
      archivedAt: new Date('2026-11-20T09:15:00.000Z'),
      version: 4,
    });

    expect(details).toEqual({
      studentId: 42,
      fullName: 'Nadia Hassan',
      nationalId: '00123456789012',
      archivedAt: '2026-11-20T09:15:00.000Z',
      version: 4,
      requiresRestore: true,
    });
  });
});
