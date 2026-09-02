import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function createOpenApi(app: INestApplication) {
  return SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('Melissa infrastructure API')
    .setDescription('Implemented Phase 1 endpoints only. Product API remains a separate draft.')
    .setVersion('0.1.0')
    .build());
}
