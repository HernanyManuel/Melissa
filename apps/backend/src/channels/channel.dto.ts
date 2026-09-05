import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MockChannelDto {
  @ApiProperty({
    maxLength: 160,
    description: 'Name for a development-only WhatsApp simulation; never connects a real number.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 160)
  displayName!: string;
}
