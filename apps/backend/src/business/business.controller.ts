import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { BusinessService } from './business.service';
import {
  BusinessProfileDto,
  ConfigurationDto,
  FaqDto,
  HoursDto,
  ScheduleExceptionDto,
  ServiceDto,
  StaffDto,
} from './dto';

@ApiTags('Business configuration')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1')
export class BusinessController {
  constructor(private readonly business: BusinessService) {}
  @Get('industry-templates') templates() {
    return this.business.templates();
  }
  @Put('tenants/:tenantId/profile')
  profile(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) id: string,
    @Body() body: BusinessProfileDto,
  ) {
    return this.business.profile(req.actor, id, body);
  }
  @Get('tenants/:tenantId/onboarding')
  status(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) id: string) {
    return this.business.status(req.actor, id);
  }
  @Get('tenants/:tenantId/services')
  services(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) id: string) {
    return this.business.listServices(req.actor, id);
  }
  @Post('tenants/:tenantId/services')
  createService(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) id: string,
    @Body() body: ServiceDto,
  ) {
    return this.business.createService(req.actor, id, body);
  }
  @Patch('tenants/:tenantId/services/:resourceId')
  updateService(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) id: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
    @Body() body: ServiceDto,
  ) {
    return this.business.updateService(req.actor, id, resourceId, body);
  }
  @Delete('tenants/:tenantId/services/:resourceId')
  @HttpCode(204)
  removeService(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) id: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
  ) {
    return this.business.deleteService(req.actor, id, resourceId);
  }
  @Get('tenants/:tenantId/business-hours')
  hours(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) id: string) {
    return this.business.getHours(req.actor, id);
  }
  @Put('tenants/:tenantId/business-hours')
  saveHours(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) id: string,
    @Body() body: HoursDto,
  ) {
    return this.business.replaceHours(req.actor, id, body);
  }
  @Post('tenants/:tenantId/schedule-exceptions')
  exception(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) id: string,
    @Body() body: ScheduleExceptionDto,
  ) {
    return this.business.addException(req.actor, id, body);
  }
  @Get('tenants/:tenantId/faqs')
  faqs(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) id: string) {
    return this.business.listFaqs(req.actor, id);
  }
  @Post('tenants/:tenantId/faqs')
  createFaq(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) id: string,
    @Body() body: FaqDto,
  ) {
    return this.business.createFaq(req.actor, id, body);
  }
  @Get('tenants/:tenantId/staff')
  staff(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) id: string) {
    return this.business.listStaff(req.actor, id);
  }
  @Post('tenants/:tenantId/staff')
  createStaff(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) id: string,
    @Body() body: StaffDto,
  ) {
    return this.business.createStaff(req.actor, id, body);
  }
  @Get('tenants/:tenantId/configuration')
  config(@Req() req: AuthRequest, @Param('tenantId', ParseUUIDPipe) id: string) {
    return this.business.getConfiguration(req.actor, id);
  }
  @Put('tenants/:tenantId/configuration')
  saveConfig(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) id: string,
    @Body() body: ConfigurationDto,
  ) {
    return this.business.saveConfiguration(req.actor, id, body);
  }
}
