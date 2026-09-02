import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO4217CurrencyCode,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class BusinessProfileDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(1, 160) legalName?: string;
  @IsString() @Length(1, 50) industryKey!: string;
  @Matches(/^[A-Z]{2}$/) countryCode!: string;
  @IsString() @Length(1, 100) city!: string;
  @IsOptional() @IsString() @Length(1, 240) address?: string;
  @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https'] }) website?: string;
  @IsString() @Length(1, 100) timezone!: string;
  @Matches(/^[a-z]{2}$/) locale!: string;
  @IsISO4217CurrencyCode() currency!: string;
}

export class ServiceDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(1, 2000) description?: string;
  @IsOptional() @IsString() @Length(1, 100) category?: string;
  @Matches(/^\d{1,14}(\.\d{1,6})?$/) price!: string;
  @IsISO4217CurrencyCode() currency!: string;
  @IsInt() @Min(5) @Max(1440) durationMinutes!: number;
  @IsInt() @Min(0) @Max(240) bufferBeforeMinutes!: number;
  @IsInt() @Min(0) @Max(240) bufferAfterMinutes!: number;
  @IsBoolean() bookingEnabled!: boolean;
  @IsBoolean() active!: boolean;
}

export class HourDto {
  @IsInt() @Min(1) @Max(7) weekday!: number;
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/) startTime!: string;
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/) endTime!: string;
  @IsBoolean() enabled!: boolean;
}
export class HoursDto {
  @IsArray()
  @ArrayMaxSize(35)
  @ValidateNested({ each: true })
  @Type(() => HourDto)
  periods!: HourDto[];
}

export class ScheduleExceptionDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @IsOptional() @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/) startTime?: string;
  @IsOptional() @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/) endTime?: string;
  @IsBoolean() closed!: boolean;
  @IsOptional() @IsString() @Length(1, 240) reason?: string;
}

export class FaqDto {
  @IsString() @Length(1, 500) question!: string;
  @IsString() @Length(1, 5000) answer!: string;
  @IsOptional() @IsString() @Length(1, 100) category?: string;
  @IsBoolean() active!: boolean;
}

export class StaffDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @Matches(/^\+[1-9]\d{7,14}$/) phone?: string;
  @IsOptional() @IsUrl({ protocols: ['https'], require_protocol: true }) avatarUrl?: string;
  @IsOptional() @IsString() @Length(1, 100) roleTitle?: string;
  @IsBoolean() active!: boolean;
  @IsString() @Length(1, 100) timezone!: string;
  @IsArray() @ArrayMaxSize(100) @Matches(/^[0-9a-f-]{36}$/, { each: true }) serviceIds!: string[];
}

enum Tone {
  professional = 'professional',
  friendly = 'friendly',
  informal = 'informal',
  premium = 'premium',
  concise = 'concise',
}
enum Verbosity {
  short = 'short',
  normal = 'normal',
  detailed = 'detailed',
}
export class ConfigurationDto {
  @IsOptional() @IsString() @Length(1, 5000) cancellation?: string;
  @IsOptional() @IsString() @Length(1, 5000) rescheduling?: string;
  @IsOptional() @IsString() @Length(1, 5000) lateness?: string;
  @IsOptional() @IsString() @Length(1, 5000) noShow?: string;
  @IsOptional() @IsString() @Length(1, 5000) payment?: string;
  @IsOptional() @IsString() @Length(1, 5000) refunds?: string;
  @IsOptional() @IsString() @Length(1, 5000) deposits?: string;
  @IsOptional() @IsInt() @Min(0) @Max(120) minimumAge?: number;
  @IsOptional() @IsString() @Length(1, 10000) otherRules?: string;
  @IsEnum(Tone) tone!: Tone;
  @IsBoolean() useEmojis!: boolean;
  @IsBoolean() useCustomerName!: boolean;
  @IsBoolean() replyInCustomerLanguage!: boolean;
  @IsEnum(Verbosity) verbosity!: Verbosity;
}
