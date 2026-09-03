import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class ProcessingQuery {
  @ApiPropertyOptional({ enum: ['pending', 'failed', 'rejected'], default: 'pending' })
  @IsIn(['pending', 'failed', 'rejected'])
  state: string = 'pending';
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() after?: string;
}
export class ProcessingItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['pending', 'failed', 'rejected'] }) state!: string;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 5,
    description: 'Recorded processing failures, not total executions.',
  })
  attempts!: number;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Pending retry eligibility, not guaranteed execution time; null for terminal states.',
  })
  nextAttemptAt!: Date | null;
}
export class ProcessingPageDto {
  @ApiProperty({ type: [ProcessingItemDto], maxItems: 50 }) items!: ProcessingItemDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) next!: string | null;
}
