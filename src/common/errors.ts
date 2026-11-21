import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

/** A failure the client can act on. Rendered as RFC 9457 problem details by ProblemDetailsFilter. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(title);
  }

  static validation(errors: FieldError[]): ApiError {
    return new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { errors });
  }
}

// pg error codes that mean "database temporarily unable", not "bug": retryable by the client.
const UNAVAILABLE_PG_CODES = new Set(['57014', '57P01', '57P03', '53300', '08000', '08003', '08006', 'ECONNREFUSED']);

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetailsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();
    const problem = this.toProblem(exception);

    if (problem.status >= 500) this.logger.error({ err: exception, requestId: req.id }, 'request failed');
    res
      .status(problem.status)
      .type('application/problem+json')
      .json({ ...problem, requestId: req.id });
  }

  private toProblem(exception: unknown): { status: number; code: string; title: string; [k: string]: unknown } {
    if (exception instanceof ApiError) {
      return { status: exception.status, code: exception.code, title: exception.title, ...exception.extra };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // body-parser failures arrive as HttpException-like 400s from Nest
      if (status === HttpStatus.BAD_REQUEST) {
        return { status, code: 'VALIDATION_ERROR', title: 'Malformed request body', errors: [{ path: '', code: 'malformed_json', message: exception.message }] };
      }
      if (status === HttpStatus.NOT_FOUND) return { status, code: 'NOT_FOUND', title: 'Route not found' };
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) return { status, code: 'PAYLOAD_TOO_LARGE', title: 'Request body too large' };
      return { status, code: status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR', title: exception.message };
    }
    const pgCode = (exception as { code?: unknown })?.code;
    if (typeof pgCode === 'string' && UNAVAILABLE_PG_CODES.has(pgCode)) {
      return { status: 503, code: 'SERVICE_UNAVAILABLE', title: 'Service temporarily unavailable, retry later' };
    }
    return { status: 500, code: 'INTERNAL_ERROR', title: 'Internal server error' };
  }
}
