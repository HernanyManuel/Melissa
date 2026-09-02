import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function createOpenApi(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Melissa API')
      .setDescription(
        'Implemented infrastructure, identity, tenancy and business onboarding endpoints.',
      )
      .setVersion('0.3.0')
      .addBearerAuth()
      .build(),
  );
}
