import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'kysely';
import { ApiError } from '../common/errors';
import { DB, Db } from '../db/database';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Liveness + readiness: the API is only useful with its database. */
  @Get()
  async check() {
    try {
      await sql`SELECT 1`.execute(this.db);
    } catch {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Database unreachable');
    }
    return { status: 'ok' };
  }
}
