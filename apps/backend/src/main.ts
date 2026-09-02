import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { CONFIG, Configuration } from './config';
import { configureHttp } from './http';
import { log } from './logging';
import { createOpenApi } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const config = app.get<Configuration>(CONFIG);
  configureHttp(app, config);
  SwaggerModule.setup('api/docs', app, createOpenApi(app));
  await app.listen(config.PORT, '0.0.0.0');
  log.info({ event: 'api_started', port: config.PORT });
}
void bootstrap().catch(() => {
  log.error({ event: 'api_start_failed' });
  process.exitCode = 1;
});
