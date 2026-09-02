import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CustomerDto {
  @ApiProperty({ maxLength: 160 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 160)
  displayName!: string;

  @ApiProperty({ example: '+351912345678' })
  @Matches(/^\+[1-9]\d{6,14}$/)
  phoneE164!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiProperty({ enum: ['pt', 'en', 'es', 'fr', 'de', 'it'] })
  @IsIn(['pt', 'en', 'es', 'fr', 'de', 'it'])
  language!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;
}

export class CustomerQuery {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  after?: string;
}
