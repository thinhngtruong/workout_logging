import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/validation';
import { unitRegistry as units } from '../units/unit-registry';
import { HistoryService } from './history.service';
import { HistoryQuery, LogWorkoutsInput, historyQuerySchema, logWorkoutsSchema, userIdSchema } from './workouts.schemas';
import { WorkoutsService } from './workouts.service';

const idempotencyHeader = new ZodValidationPipe(z.object({ 'Idempotency-Key': z.string().trim().min(1).max(255).optional() }));

@Controller('users/:userId/workouts')
export class WorkoutsController {
  constructor(
    private readonly workouts: WorkoutsService,
    private readonly history: HistoryService,
  ) {}

  @Post()
  async log(
    @Param('userId', new ZodValidationPipe(userIdSchema)) userId: string,
    @Body(new ZodValidationPipe(logWorkoutsSchema(units))) body: LogWorkoutsInput,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const idempotencyKey = idempotencyHeader.transform({ 'Idempotency-Key': rawKey })['Idempotency-Key'];
    const result = await this.workouts.log(userId, body, idempotencyKey);
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get()
  list(
    @Param('userId', new ZodValidationPipe(userIdSchema)) userId: string,
    @Query(new ZodValidationPipe(historyQuerySchema(units))) query: HistoryQuery,
  ) {
    return this.history.list(userId, query);
  }
}
