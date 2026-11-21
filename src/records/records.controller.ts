import { Controller, Get, Param, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation';
import { unitRegistry as units } from '../units/unit-registry';
import { CompareQuery, RecordsQuery, compareQuerySchema, recordsQuerySchema, userIdSchema } from '../workouts/workouts.schemas';
import { RecordsService } from './records.service';

@Controller('users/:userId/personal-records')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get()
  get(
    @Param('userId', new ZodValidationPipe(userIdSchema)) userId: string,
    @Query(new ZodValidationPipe(recordsQuerySchema(units))) query: RecordsQuery,
  ) {
    return this.records.personalRecords(userId, query);
  }

  @Get('compare')
  compare(
    @Param('userId', new ZodValidationPipe(userIdSchema)) userId: string,
    @Query(new ZodValidationPipe(compareQuerySchema(units))) query: CompareQuery,
  ) {
    return this.records.compare(userId, query);
  }
}
