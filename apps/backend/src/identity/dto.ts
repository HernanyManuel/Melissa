import { IsEmail, IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class EmailDto {
  @ApiProperty() @IsEmail() @Length(3, 254) email!: string;
}
export class LoginDto extends EmailDto {
  @ApiProperty({ minLength: 12, maxLength: 128 }) @IsString() @Length(12, 128) password!: string;
}
export class RegisterDto extends LoginDto {
  @ApiProperty() @IsString() @Length(1, 100) @Matches(/\S/) name!: string;
}
export class TokenDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
}
export class ResetDto extends TokenDto {
  @ApiProperty({ minLength: 12, maxLength: 128 }) @IsString() @Length(12, 128) password!: string;
}
