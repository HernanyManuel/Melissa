import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class MockInboundDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() customerId!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'Stable UUID reused when retrying the same simulation.',
  })
  @IsUUID()
  eventId!: string;
  @ApiProperty({ maxLength: 4096 }) @IsString() @Length(1, 4096) text!: string;
}
export class MessagePageDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() after?: string;
}
export class ConversationQuery extends MessagePageDto {
  @ApiPropertyOptional({
    maxLength: 80,
    description:
      'Case-insensitive literal substring of customer/channel display name. Empty means no filter. Message contents are never searched.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Length(0, 80)
  q?: string;
}

export class ConversationTakeoverDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() staffId!: string;
}

export class InboxEventQuery {
  @ApiPropertyOptional({
    description: 'Tenant-local durable event cursor. Omit or use 0 for the beginning.',
    example: '42',
  })
  @IsOptional()
  @Matches(/^\d{1,19}$/)
  after?: string;
}

export class ManualReplyDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Stable UUID reused with the exact same text after an uncertain response.',
  })
  @IsUUID()
  requestId!: string;

  @ApiProperty({ minLength: 1, maxLength: 4096 })
  @IsString()
  @Length(1, 4096)
  text!: string;
}

export class AbandonManualReplyDto {
  @ApiProperty({ format: 'uuid', description: 'Request ID of the actor-owned preparation to abandon.' })
  @IsUUID()
  requestId!: string;
}
