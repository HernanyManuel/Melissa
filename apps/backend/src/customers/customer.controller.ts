import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, AuthRequest } from '../identity/auth.guard';
import { CustomerService } from './customer.service';
import { CustomerDto, CustomerQuery } from './dto';

@ApiTags('Customers')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('api/v1/tenants/:tenantId/customers')
export class CustomerController {
  constructor(private readonly customers: CustomerService) {}
  @Get()
  list(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Query() query: CustomerQuery,
  ) {
    return this.customers.list(req.actor, tenant, query);
  }
  @Post()
  create(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Body() body: CustomerDto,
  ) {
    return this.customers.save(req.actor, tenant, body);
  }
  @Put(':id')
  update(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CustomerDto,
  ) {
    return this.customers.save(req.actor, tenant, body, id);
  }
  @Delete(':id')
  @HttpCode(204)
  archive(
    @Req() req: AuthRequest,
    @Param('tenantId', ParseUUIDPipe) tenant: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customers.archive(req.actor, tenant, id);
  }
}
