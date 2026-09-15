import { Module } from '@nestjs/common';
import { CONFIG, Configuration } from './config';
import { Dependencies } from './dependencies';
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
import { BookingAdminService } from './business/booking-admin.service';
import { CustomerController } from './customers/customer.controller';
import { CustomerService } from './customers/customer.service';
import { ChannelController } from './channels/channel.controller';
import { ChannelService } from './channels/channel.service';
import { MessagingService } from './messaging/messaging.service';
import { OutboundIntentService } from './messaging/outbound-intent.service';
import { OutboundController } from './messaging/outbound.controller';
import { OutboundRateLimitGuard } from './messaging/outbound-rate-limit';
import { MessagingController } from './messaging/messaging.controller';
import { WhatsAppWebhookController } from './channels/whatsapp-http';
import { QuarantineController, QuarantineService } from './channels/quarantine.controller';
import { GoogleCalendarOAuthController } from './calendar/google-calendar-oauth.controller';
import {
  GoogleCalendarOAuthRuntime,
  createGoogleCalendarOAuthRuntime,
} from './calendar/google-calendar-oauth-runtime';

@Module({
  imports: [InfrastructureModule],
  controllers: [
    AuthController,
    TenantController,
    BusinessController,
    CustomerController,
    ChannelController,
    MessagingController,
    OutboundController,
    WhatsAppWebhookController,
    QuarantineController,
    GoogleCalendarOAuthController,
  ],
  providers: [
    AuthService,
    AuthGuard,
    IdentityMail,
    IdentityRateLimit,
    TenantService,
    BusinessService,
    BookingAdminService,
    CustomerService,
    ChannelService,
    MessagingService,
    OutboundIntentService,
    OutboundRateLimitGuard,
    QuarantineService,
    {
      provide: GoogleCalendarOAuthRuntime,
      inject: [CONFIG, Dependencies, TenantService],
      useFactory: (config: Configuration, deps: Dependencies, tenants: TenantService) =>
        createGoogleCalendarOAuthRuntime(config, deps, tenants),
    },
  ],
})
export class AppModule {}
