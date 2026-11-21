import { createHash } from 'node:crypto';
import { ApiError } from './errors';

export interface CursorPosition {
  performedOn: string;
  id: string;
}

const filterHash = (filters: object): string =>
  createHash('sha256').update(JSON.stringify(filters)).digest('base64url').slice(0, 16);

/** Opaque keyset cursor, bound to the filters it was issued for. */
export function encodeCursor(pos: CursorPosition, filters: object): string {
  return Buffer.from(JSON.stringify({ d: pos.performedOn, i: pos.id, f: filterHash(filters) })).toString('base64url');
}

export function decodeCursor(cursor: string, filters: object): CursorPosition {
  let parsed: { d?: unknown; i?: unknown; f?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid('cursor is malformed');
  }
  if (typeof parsed?.d !== 'string' || typeof parsed.i !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.d) || !/^[0-9a-f-]{36}$/i.test(parsed.i)) {
    throw invalid('cursor is malformed');
  }
  if (parsed.f !== filterHash(filters)) throw invalid('cursor was issued for different filters; restart without a cursor');
  return { performedOn: parsed.d, id: parsed.i };
}

const invalid = (detail: string) => new ApiError(400, 'INVALID_CURSOR', 'Invalid pagination cursor', { detail });
