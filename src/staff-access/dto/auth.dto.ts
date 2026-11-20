import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { PASSWORD_POLICY_MESSAGE, validatePasswordPolicy } from '../passwords';

function IsValidStaffPassword(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isValidStaffPassword',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return (
            typeof value === 'string' && validatePasswordPolicy(value) === null
          );
        },
        defaultMessage(): string {
          return PASSWORD_POLICY_MESSAGE;
        },
      },
    });
  };
}

export class LoginDto {
  @ApiProperty({ example: 'office.user', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  username!: string;

  @ApiProperty({
    format: 'password',
    minLength: 12,
    maxLength: 1024,
    example: 'a long individual password',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ minimum: 1, example: 1 })
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiProperty({ format: 'password', maxLength: 1024 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  currentPassword!: string;

  @ApiProperty({
    format: 'password',
    minLength: 12,
    maxLength: 1024,
    example: 'a new unique staff password',
  })
  @IsString()
  @IsNotEmpty()
  @IsValidStaffPassword()
  newPassword!: string;
}

export class StaffAccountDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'office.user' })
  username!: string;

  @ApiProperty({ example: 'Office User' })
  fullName!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  deactivatedAt!: string | null;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ example: '2026-11-20T12:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-11-20T12:00:00.000Z' })
  updatedAt!: string;
}

export class CsrfResponseDto {
  @ApiProperty({
    description:
      'Synchronizer CSRF token to submit in the X-CSRF-Token header.',
  })
  csrfToken!: string;
}

export class AuthSessionResponseDto {
  @ApiProperty({ type: StaffAccountDto })
  user!: StaffAccountDto;

  @ApiProperty({
    description:
      'Synchronizer CSRF token bound to the current authenticated session.',
  })
  csrfToken!: string;
}
