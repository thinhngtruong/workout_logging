import { Controller, Get, Header, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route and status',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
  registers: [registry],
});
export const setsLogged = new Counter({ name: 'workout_sets_logged_total', help: 'Sets written', registers: [registry] });
export const idempotentReplays = new Counter({ name: 'idempotent_replays_total', help: 'Writes answered from a stored response', registers: [registry] });

@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const end = httpDuration.startTimer({ method: req.method });
    // route pattern, not the raw URL, so userIds do not explode label cardinality
    res.on('finish', () => end({ route: (req.route?.path as string) ?? 'unmatched', status: res.statusCode }));
    next();
  }
}

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', registry.contentType)
  metrics(): Promise<string> {
    return registry.metrics();
  }
}
