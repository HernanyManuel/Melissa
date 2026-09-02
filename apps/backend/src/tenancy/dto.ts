import { IsEnum, IsEmail, IsString, Length, Matches, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TenantRole } from '@prisma/client';
export class TenantDto {
  @ApiProperty() @IsString() @Length(1, 120) @Matches(/\S/) name!: string;
  @ApiProperty({ example: 'PT' }) @Matches(/^[A-Z]{2}$/) countryCode!: string;
  @ApiProperty({ example: 'Europe/Lisbon' }) @IsString() @Length(1, 100) timezone!: string;
}
export class MemberDto {
  @ApiProperty({ enum: TenantRole }) @IsEnum(TenantRole) role!: TenantRole;
  @ApiProperty() @IsBoolean() active!: boolean;
}
export class InviteDto {
  @ApiProperty() @IsEmail() @Length(3, 254) email!: string;
  @ApiProperty({ enum: TenantRole }) @IsEnum(TenantRole) role!: TenantRole;
}
