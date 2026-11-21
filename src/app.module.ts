import { Inject, MiddlewareConsumer, Module, NestModule, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { ProblemDetailsFilter } from './common/errors';
import { APP_CONFIG, AppConfig, loadConfig } from './config/config';
import { createDb, createPool, DB, Db } from './db/database';
import { ExerciseCatalog } from './exercises/exercise-catalog';
import { HealthController } from './ops/health.controller';
import { HttpMetricsMiddleware, MetricsController } from './ops/metrics';
import { RecordsController } from './records/records.controller';
import { RecordsService } from './records/records.service';
import { UnitRegistry, unitRegistry } from './units/unit-registry';
import { HistoryService } from './workouts/history.service';
import { WorkoutsController } from './workouts/workouts.controller';
import { WorkoutsService } from './workouts/workouts.service';

const config = loadConfig();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.LOG_LEVEL,
        // one JSON line per request with request id, user id, route, status and duration
        genReqId: (req, res) => {
          const id = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || uuidv7();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        customProps: (req) => ({ userId: (req as unknown as { params?: { userId?: string } }).params?.userId }),
        autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
        serializers: { req: (req) => ({ method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      },
    }),
  ],
  controllers: [WorkoutsController, RecordsController, HealthController, MetricsController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: Pool, useFactory: (c: AppConfig) => createPool(c), inject: [APP_CONFIG] },
    { provide: DB, useFactory: (pool: Pool) => createDb(pool), inject: [Pool] },
    { provide: UnitRegistry, useValue: unitRegistry },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    ExerciseCatalog,
    WorkoutsService,
    HistoryService,
    RecordsService,
  ],
})
export class AppModule implements NestModule, OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy(); // closes the pool after in-flight requests finish
  }
}
