import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { TokenDto } from '../identity/dto';
import { TenantService } from './tenant.service';
import { TenantDto, MemberDto, InviteDto } from './dto';
@ApiTags('Tenants')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1/tenants')
export class TenantController {
  constructor(private readonly tenants: TenantService) {}
  private match(req: AuthRequest, id: string) {
    if (req.headers['x-tenant-id'] && req.headers['x-tenant-id'] !== id)
      throw new ForbiddenException();
    return req.actor;
  }
  @Get() list(@Req() req: AuthRequest) {
    return this.tenants.list(req.actor);
  }
  @Post() create(@Req() req: AuthRequest, @Body() body: TenantDto) {
    return this.tenants.create(req.actor, body);
  }
  @Get(':id') get(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.get(this.match(req, id), id);
  }
  @Patch(':id') update(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TenantDto,
  ) {
    return this.tenants.update(this.match(req, id), id, body);
  }
  @Get(':id/memberships') members(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.members(this.match(req, id), id);
  }
  @Patch(':id/memberships/:memberId') change(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() body: MemberDto,
  ) {
    return this.tenants.changeMember(this.match(req, id), id, memberId, body);
  }
  @Post(':id/invitations') invite(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: InviteDto,
  ) {
    return this.tenants.invite(this.match(req, id), id, body);
  }
  @Post(':id/invitations/accept') accept(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TokenDto,
  ) {
    return this.tenants.accept(this.match(req, id), id, body.token);
  }
  @Get(':id/audit') audit(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.auditEvents(this.match(req, id), id);
  }
}
