import { Module } from '@nestjs/common';
import { CONFIG, parseConfig } from './config';
import { Dependencies } from './dependencies';
import { HealthController } from './health';

@Module({
  controllers: [HealthController],
  providers: [{ provide: CONFIG, useFactory: () => parseConfig(process.env) }, Dependencies],
  exports: [Dependencies, CONFIG],
})
export class InfrastructureModule {}
