import { PipeTransform } from '@nestjs/common';
import { ZodIssue, ZodType, ZodTypeDef } from 'zod';
import { ApiError, FieldError } from './errors';

/** ['entries', 1, 'sets', 0, 'unit'] -> 'entries[1].sets[0].unit' */
export const formatPath = (path: (string | number)[]): string =>
  path.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), '');

const toFieldError = (issue: ZodIssue): FieldError => ({
  path: formatPath(issue.path),
  // refinements carry a domain code (e.g. unsupported_unit); otherwise use zod's own
  code: (issue.code === 'custom' && (issue.params?.code as string)) || (issue.code === 'invalid_type' && issue.received === 'undefined' ? 'required' : issue.code),
  message: issue.message,
});

/** Validates the whole input and reports every failure with its path, before any work is done. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) throw ApiError.validation(result.error.issues.map(toFieldError));
    return result.data;
  }
}
