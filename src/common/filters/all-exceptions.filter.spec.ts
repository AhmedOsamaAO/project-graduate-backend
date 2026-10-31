import {
  ArgumentsHost,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

interface MockResponse {
  headersSent: boolean;
  status: jest.Mock;
  json: jest.Mock;
}

function createResponse(): MockResponse {
  return {
    headersSent: false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function createHost(response: MockResponse): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  it.each([
    [new HttpException('bad request', 400), 400, 'BAD_REQUEST'],
    [new HttpException('unauthenticated', 401), 401, 'UNAUTHENTICATED'],
    [new HttpException('forbidden', 403), 403, 'FORBIDDEN'],
    [new NotFoundException(), 404, 'NOT_FOUND'],
    [new HttpException('conflict', 409), 409, 'CONFLICT'],
    [new HttpException('slow down', 429), 429, 'RATE_LIMITED'],
    [new HttpException('storage failed', 503), 503, 'SERVICE_UNAVAILABLE'],
  ])(
    'maps an HttpException to the expected status and code',
    (exception, expectedStatus, expectedCode) => {
      const response = createResponse();

      filter.catch(exception, createHost(response));

      expect(response.status).toHaveBeenCalledWith(expectedStatus);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: expectedCode }),
      );
    },
  );

  it('returns a generic error for unexpected failures', () => {
    const response = createResponse();

    filter.catch(new Error('raw query details'), createHost(response));

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
  });

  it('never logs exception messages, request URLs, or sensitive values', () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const response = createResponse();
    const secret =
      'nationalId=12345678901234 password=super-secret sessionId=abc SELECT * FROM students';

    filter.catch(new Error(secret), createHost(response));

    const logged = logger.mock.calls.flat().join(' ');
    expect(logged).not.toContain('12345678901234');
    expect(logged).not.toContain('super-secret');
    expect(logged).not.toContain('sessionId=abc');
    expect(logged).not.toContain('SELECT * FROM students');

    logger.mockRestore();
  });
});
