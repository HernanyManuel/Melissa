import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { createOpenApi } from '../src/openapi';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    const directory = resolve(process.cwd(), '../../packages/api-contracts/generated');
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, 'infrastructure.openapi.json'),
      JSON.stringify(createOpenApi(app), null, 2) + '\n',
    );
  } finally {
    await app.close();
  }
}
void main().catch(() => {
  process.exitCode = 1;
});
