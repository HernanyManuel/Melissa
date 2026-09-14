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
import { GoogleCalendarOAuthFlow } from './google-calendar-oauth-flow';

@ApiTags('Calendar OAuth')
@Controller('api/v1')
export class GoogleCalendarOAuthController {
  constructor(private readonly flow: GoogleCalendarOAuthFlow) {}

  @Post('tenants/:tenantId/calendar/google/oauth/start')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  start(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.flow.begin(req.actor, tenantId);
  }

  @Get('calendar/google/oauth/callback')
  callback(
    @Query('state') state?: string,
    @Query('code') code?: string,
    @Query('error') providerError?: string,
  ) {
    if (!state) throw new BadRequestException();
    if (providerError || !code) return this.flow.reject(state);
    return this.flow.complete(state, code);
  }
}
