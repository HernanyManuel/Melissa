import { ApiProperty } from '@nestjs/swagger';
import { QUARANTINE_CAPACITY, QuarantineNotice } from './quarantine-policy';

export class QuarantineMetadataDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) channelId!: string;
  @ApiProperty({ description: 'Display name, not a phone number or provider credential.' })
  channelName!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ description: 'Expiry assessed at the response asOf instant.' }) expired!: boolean;
}

export class QuarantinePageResponseDto {
  @ApiProperty({ type: [QuarantineMetadataDto], maxItems: 50 }) items!: QuarantineMetadataDto[];
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Exclusive UUID cursor; null on the last page. Ordering is by ID, not receipt time. A purged cursor remains usable.',
  })
  next!: string | null;
  @ApiProperty({ type: 'integer', minimum: 0 }) total!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) expired!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Expires after asOf and within the next 24 hours.',
  })
  expiringSoon!: number;
  @ApiProperty({ type: 'integer', enum: [QUARANTINE_CAPACITY] }) capacity!: number;
  @ApiProperty({
    isArray: true,
    enum: ['capacity_full', 'capacity_warning', 'expiring_soon', 'cleanup_pending'],
    description: 'Current observations, not persisted incidents or external notifications.',
  })
  notices!: QuarantineNotice[];
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Classification instant. Counts are observational, not a snapshot across concurrent purges or pages.',
  })
  asOf!: Date;
}

class QuarantineErrorDetailDto {
  @ApiProperty() code!: string;
  @ApiProperty({ description: 'Sanitized code, without internal exception details.' })
  message!: string;
  @ApiProperty({ format: 'uuid' }) request_id!: string;
}

export class QuarantineErrorResponseDto {
  @ApiProperty({ type: QuarantineErrorDetailDto }) error!: QuarantineErrorDetailDto;
}
