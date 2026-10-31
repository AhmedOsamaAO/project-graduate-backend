import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { isPageResult } from './page';

/**
 * Applies the single-resource `{data}` envelope to successful controller
 * results. Page results already carry the paged envelope and are returned
 * unchanged; streamed files and empty responses are not wrapped.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      map((value: unknown) => {
        if (
          value === undefined ||
          value instanceof StreamableFile ||
          isPageResult(value)
        ) {
          return value;
        }

        return { data: value };
      }),
    );
  }
}
