import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CheckoutDto {
  @ApiProperty({ format: 'uuid', description: 'Published plan to purchase in Stripe test mode' })
  @IsUUID('4')
  planId!: string;

  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key; reuse on retry' })
  @IsUUID('4')
  requestId!: string;
}
