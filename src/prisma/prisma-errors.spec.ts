import {
  isForeignKeyConstraintError,
  isUniqueConstraintError,
} from './prisma-errors';

describe('prisma error helpers', () => {
  it.each([
    { code: 'P2002' },
    { code: '23505' },
    { cause: { originalCode: '23505' } },
    { cause: { code: '23505' } },
    { meta: { code: '23505' } },
    { meta: { driverAdapterError: { cause: { originalCode: '23505' } } } },
    { meta: { driverAdapterError: { cause: { code: '23505' } } } },
  ])('recognizes unique constraint errors for %j', (shape) => {
    expect(isUniqueConstraintError(shape)).toBe(true);
    expect(isForeignKeyConstraintError(shape)).toBe(false);
  });

  it.each([
    { code: 'P2003' },
    { code: '23503' },
    { code: '23001' },
    { cause: { originalCode: '23503' } },
    { cause: { originalCode: '23001' } },
    { cause: { code: '23503' } },
    { meta: { code: '23503' } },
    { meta: { driverAdapterError: { cause: { originalCode: '23503' } } } },
    { meta: { driverAdapterError: { cause: { originalCode: '23001' } } } },
    { meta: { driverAdapterError: { cause: { code: '23503' } } } },
  ])('recognizes foreign key constraint errors for %j', (shape) => {
    expect(isForeignKeyConstraintError(shape)).toBe(true);
    expect(isUniqueConstraintError(shape)).toBe(false);
  });

  it.each([null, undefined, 'string', {}, { code: 'P2025' }])(
    'returns false for non-matching errors %j',
    (value) => {
      expect(isUniqueConstraintError(value)).toBe(false);
      expect(isForeignKeyConstraintError(value)).toBe(false);
    },
  );
});
