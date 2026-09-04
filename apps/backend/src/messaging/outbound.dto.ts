import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length } from 'class-validator';

export class StoreMockOutboundDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Reuse this UUID and exact text for uncertain retries, within the same user and tenant.',
  })
  @IsUUID()
  requestId!: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 4096,
    description: 'Preserved exactly; whitespace-only, NUL and invalid Unicode are rejected.',
  })
  @IsString()
  @Length(1, 4096)
  text!: string;
}

export class StoredOutboundDto {
  @ApiProperty({ format: 'uuid' }) intentId!: string;
  @ApiProperty({
    enum: ['stored', 'pending', 'mock_accepted', 'rejected', 'failed'],
    description:
      'stored is a legacy non-dispatched intent; pending is queued; mock_accepted is simulation-only. No value means real delivery.',
  })
  state!: 'stored' | 'pending' | 'mock_accepted' | 'rejected' | 'failed';
}

export class StoreMockOutboundResponseDto extends StoredOutboundDto {
  @ApiProperty() duplicate!: boolean;
}

class OutboundErrorDetailDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ format: 'uuid' }) request_id!: string;
}
export class OutboundErrorDto {
  @ApiProperty({ type: OutboundErrorDetailDto }) error!: OutboundErrorDetailDto;
}
