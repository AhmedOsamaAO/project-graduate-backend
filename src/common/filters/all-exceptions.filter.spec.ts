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

function httpError(status: number | undefined, message: string): Error {
  return Object.assign(new Error(message), {
    status,
    statusCode: status,
    expose: true,
  });
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

  it('does not expose plain HttpException messages from any status', () => {
    const response = createResponse();

    filter.catch(
      new HttpException('raw parser output from body', 400),
      createHost(response),
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      code: 'BAD_REQUEST',
      message: 'Bad request',
    });
  });

  it.each([
    [413, 'request entity too large'],
    [415, 'unsupported charset "FOO"'],
    [400, 'request aborted'],
  ])(
    'keeps the client-error status %i from middleware errors without their message',
    (status, message) => {
      const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const response = createResponse();

      filter.catch(
        httpError(status, `${message} SELECT * FROM students`),
        createHost(response),
      );

      expect(response.status).toHaveBeenCalledWith(status);
      const [body] = response.json.mock.calls[0] as [
        { code: string; message: string },
      ];
      expect(body.code).toBe('BAD_REQUEST');
      expect(JSON.stringify(body)).not.toContain('SELECT * FROM students');
      expect(logger).not.toHaveBeenCalled();

      logger.mockRestore();
    },
  );

  it.each([
    ['a server status', 500],
    ['a non-error status', 200],
    ['a missing status', undefined],
  ])('treats a middleware error with %s as unexpected', (_label, status) => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const response = createResponse();

    filter.catch(httpError(status, 'raw detail'), createHost(response));

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });

    logger.mockRestore();
  });

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
