import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useBodyParser('json', { limit: '256kb' }); // 50 entries x 20 sets fits comfortably
  app.enableShutdownHooks();
  await app.listen(app.get<AppConfig>(APP_CONFIG).PORT);
}

bootstrap();
