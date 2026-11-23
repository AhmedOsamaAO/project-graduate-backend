import {
  departmentSnapshot,
  departmentView,
  facultySnapshot,
  facultyView,
  institutionSnapshot,
  institutionView,
} from './reference-data.views';

describe('reference data views and history snapshots', () => {
  const createdAt = new Date('2026-11-23T10:00:00.000Z');
  const updatedAt = new Date('2026-11-23T10:05:00.000Z');

  it('serializes institutions with ISO timestamps and isFixedOffice flag', () => {
    const fixedRow = {
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY' as const,
      version: 1,
      createdAt,
      updatedAt,
    };
    expect(institutionSnapshot(fixedRow)).toEqual({
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY',
      version: 1,
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:05:00.000Z',
    });
    expect(institutionView(fixedRow)).toEqual({
      ...institutionSnapshot(fixedRow),
      isFixedOffice: true,
    });
    expect(institutionView({ ...fixedRow, id: 2 }).isFixedOffice).toBe(false);
  });

  it('serializes faculties with ISO timestamps and isFixedOffice flag', () => {
    const fixedRow = {
      id: 1,
      institutionId: 1,
      name: 'Faculty of Computer and Information',
      version: 1,
      createdAt,
      updatedAt,
    };
    expect(facultySnapshot(fixedRow)).toEqual({
      id: 1,
      institutionId: 1,
      name: 'Faculty of Computer and Information',
      version: 1,
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:05:00.000Z',
    });
    expect(facultyView(fixedRow)).toEqual({
      ...facultySnapshot(fixedRow),
      isFixedOffice: true,
    });
    expect(facultyView({ ...fixedRow, id: 3 }).isFixedOffice).toBe(false);
  });

  it('serializes departments with ISO timestamps', () => {
    const row = {
      id: 5,
      facultyId: 1,
      name: 'Computer Science',
      version: 2,
      createdAt,
      updatedAt,
    };
    expect(departmentSnapshot(row)).toEqual({
      id: 5,
      facultyId: 1,
      name: 'Computer Science',
      version: 2,
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:05:00.000Z',
    });
    expect(departmentView(row)).toEqual(departmentSnapshot(row));
  });
});
