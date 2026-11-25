import {
  departmentView,
  facultyView,
  institutionView,
} from './reference-data.views';

describe('reference data views', () => {
  const createdAt = new Date('2026-11-23T10:00:00.000Z');
  const updatedAt = new Date('2026-11-23T10:05:00.000Z');

  it('serializes institutions with ISO timestamps and strips unexpected properties', () => {
    const row = {
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY' as const,
      version: 1,
      createdAt,
      updatedAt,
      internalSecret: 'must-not-leak',
    };

    expect(institutionView(row)).toEqual({
      id: 1,
      name: 'Zagazig University',
      institutionType: 'PUBLIC_UNIVERSITY',
      version: 1,
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:05:00.000Z',
    });
  });

  it('serializes faculties with ISO timestamps and strips unexpected properties', () => {
    const row = {
      id: 1,
      institutionId: 1,
      name: 'Faculty of Computer and Information',
      version: 1,
      createdAt,
      updatedAt,
      internalFlag: true,
    };

    expect(facultyView(row)).toEqual({
      id: 1,
      institutionId: 1,
      name: 'Faculty of Computer and Information',
      version: 1,
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:05:00.000Z',
    });
  });

  it('serializes departments with ISO timestamps and strips unexpected properties', () => {
    const row = {
      id: 5,
      facultyId: 1,
      name: 'Computer Science',
      version: 2,
      createdAt,
      updatedAt,
      extraColumn: 'hidden',
    };

    expect(departmentView(row)).toEqual({
      id: 5,
      facultyId: 1,
      name: 'Computer Science',
      version: 2,
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:05:00.000Z',
    });
  });
});
