import { Module } from '@nestjs/common';
import { InfrastructureModule } from './infrastructure.module';
import { AuthService } from './identity/auth.service';
import { AuthGuard } from './identity/auth.guard';
import { AuthController } from './identity/auth.controller';
import { IdentityMail } from './identity/mail';
import { IdentityRateLimit } from './identity/rate-limit';
import { TenantService } from './tenancy/tenant.service';
import { TenantController } from './tenancy/tenant.controller';
import { BusinessController } from './business/business.controller';
import { BusinessService } from './business/business.service';
@Module({
  imports: [InfrastructureModule],
  controllers: [AuthController, TenantController, BusinessController],
  providers: [
    AuthService,
    AuthGuard,
    IdentityMail,
    IdentityRateLimit,
    TenantService,
    BusinessService,
  ],
})
export class AppModule {}
