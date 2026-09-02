import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { Configuration } from './config';
import { log } from './logging';

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const code =
      status === 404
        ? 'NOT_FOUND'
        : status === 503
          ? 'TEMPORARILY_UNAVAILABLE'
          : status === 400
            ? 'VALIDATION_ERROR'
            : 'INTERNAL_ERROR';
    response.status(status).json({
      error: { code, message: code, request_id: response.locals.requestId },
    });
  }
}

export function configureHttp(
  app: INestApplication,
  config: Configuration,
  shutdownHooks = true,
): void {
  app.use(helmet());
  app.enableCors({ origin: config.CORS_ORIGIN, methods: ['GET'], credentials: false });
  app.use((_request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    const start = Date.now();
    response.on('finish', () =>
      log.info({
        event: 'http_request',
        request_id: requestId,
        status: response.statusCode,
        duration_ms: Date.now() - start,
      }),
    );
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new ErrorFilter());
  if (shutdownHooks) app.enableShutdownHooks();
}
