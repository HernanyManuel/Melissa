import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { GoogleCalendarOAuthRuntime } from './google-calendar-oauth-runtime';

@ApiTags('Calendar OAuth')
@Controller('api/v1')
export class GoogleCalendarOAuthController {
  constructor(private readonly oauth: GoogleCalendarOAuthRuntime) {}

  @Post('tenants/:tenantId/calendar/google/oauth/start')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  start(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.oauth.begin(req.actor, tenantId);
  }

  @Get('calendar/google/oauth/callback')
  callback(
    @Query('state') state?: string,
    @Query('code') code?: string,
    @Query('error') providerError?: string,
  ) {
    if (!state) throw new BadRequestException();
    if (providerError || !code) return this.oauth.reject(state);
    return this.oauth.complete(state, code);
  }
}
