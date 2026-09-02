import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

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
