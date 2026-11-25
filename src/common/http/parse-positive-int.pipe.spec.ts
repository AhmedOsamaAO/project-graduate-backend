import type { ArgumentMetadata } from '@nestjs/common';
import { ERROR_CODES } from '../errors/error-codes';
import { ParsePositiveIntPipe } from './parse-positive-int.pipe';

describe('ParsePositiveIntPipe', () => {
  const pipe = new ParsePositiveIntPipe();
  const metadata: ArgumentMetadata = { type: 'param', data: 'id' };

  it('parses strict positive base-10 integers within PostgreSQL INT4 bounds', () => {
    expect(pipe.transform('1', metadata)).toBe(1);
    expect(pipe.transform('42', metadata)).toBe(42);
    expect(pipe.transform('2147483647', metadata)).toBe(2_147_483_647);
    expect(pipe.transform(1, metadata)).toBe(1);
    expect(pipe.transform(2_147_483_647, metadata)).toBe(2_147_483_647);
  });

  it.each([
    '',
    '0',
    '-1',
    '01',
    '1.5',
    '1e2',
    '1abc',
    'abc',
    ' 1',
    '1 ',
    '2147483648',
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
  ])('rejects invalid parameter %p with VALIDATION_ERROR', (value) => {
    let caught: unknown;
    try {
      pipe.transform(value, metadata);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Validation failed',
    });
  });

  it('uses the parameter name from metadata or defaults to id', () => {
    let caught: { getResponse(): unknown } | undefined;
    try {
      pipe.transform('abc', { type: 'param', data: 'facultyId' });
    } catch (error) {
      caught = error as { getResponse(): unknown };
    }

    expect(caught?.getResponse()).toEqual({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Validation failed',
      details: [
        { field: 'facultyId', message: 'facultyId must be a positive integer' },
      ],
    });
  });
});
