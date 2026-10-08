import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { ApiKeyRole } from '../entities/api-key.entity';

/** Minimum length for a dashboard user's password. */
export const USER_PASSWORD_MIN_LENGTH = 10;
// Bounded so a huge body cannot make every sign-in attempt run scrypt over megabytes.
const USER_PASSWORD_MAX_LENGTH = 200;

export class LoginDto {
  @ApiProperty({ description: 'Email address of the dashboard user.', example: 'ana@example.com', maxLength: 254 })
  @IsString()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ description: 'Password of the dashboard user.', example: 'correct horse battery', maxLength: 200 })
  @IsString()
  @MaxLength(USER_PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({
    description:
      'The password the user chooses, required when a previous attempt answered passwordChangeRequired ' +
      `(at least ${USER_PASSWORD_MIN_LENGTH} characters, different from the current one).`,
    example: 'my own new passphrase',
    minLength: USER_PASSWORD_MIN_LENGTH,
    maxLength: USER_PASSWORD_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(USER_PASSWORD_MIN_LENGTH)
  @MaxLength(USER_PASSWORD_MAX_LENGTH)
  newPassword?: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: 'The current password.', example: 'correct horse battery', maxLength: 200 })
  @IsString()
  @MaxLength(USER_PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @ApiProperty({
    description: `The new password (at least ${USER_PASSWORD_MIN_LENGTH} characters, different from the current one).`,
    example: 'my own new passphrase',
    minLength: USER_PASSWORD_MIN_LENGTH,
    maxLength: USER_PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(USER_PASSWORD_MIN_LENGTH)
  @MaxLength(USER_PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

export class CreateUserDto {
  @ApiProperty({ description: 'Email address the user signs in with.', example: 'ana@example.com', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ description: 'Display name.', example: 'Ana Souza', minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxCodePoints(100)
  name!: string;

  @ApiProperty({
    description: `Initial password (at least ${USER_PASSWORD_MIN_LENGTH} characters).`,
    example: 'correct horse battery',
    minLength: USER_PASSWORD_MIN_LENGTH,
    maxLength: USER_PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(USER_PASSWORD_MIN_LENGTH)
  @MaxLength(USER_PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({ description: 'Role granted at sign-in.', enum: ApiKeyRole, default: ApiKeyRole.OPERATOR })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ description: 'Display name.', example: 'Ana Souza', minLength: 1, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxCodePoints(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Role granted at sign-in.', enum: ApiKeyRole })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional({ description: 'Whether the user may sign in.', example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: `New password (at least ${USER_PASSWORD_MIN_LENGTH} characters).`,
    example: 'correct horse battery',
    minLength: USER_PASSWORD_MIN_LENGTH,
    maxLength: USER_PASSWORD_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(USER_PASSWORD_MIN_LENGTH)
  @MaxLength(USER_PASSWORD_MAX_LENGTH)
  password?: string;
}

export class UserResponseDto {
  @ApiProperty({ description: 'User id.', example: '0a941dac-a965-45e7-b318-74ae8be134f0' })
  id!: string;

  @ApiProperty({ description: 'Email address the user signs in with.', example: 'ana@example.com' })
  email!: string;

  @ApiProperty({ description: 'Display name.', example: 'Ana Souza' })
  name!: string;

  @ApiProperty({ description: 'Role granted at sign-in.', enum: ApiKeyRole })
  role!: ApiKeyRole;

  @ApiProperty({ description: 'Whether the user may sign in.', example: true })
  isActive!: boolean;

  @ApiProperty({ description: 'Whether the next sign-in must set a new password first.', example: false })
  mustChangePassword!: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'Last successful sign-in.' })
  lastLoginAt?: Date;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the user was created.' })
  createdAt!: Date;
}

/**
 * Result of `POST /auth/login`. Either the sign-in completed (an expiring API key with the user's
 * role), or the password is a temporary one and the client must repeat the call with `newPassword`.
 */
export class LoginResponseDto {
  @ApiProperty({
    description: 'True when the password is temporary: no key was minted; repeat the call with newPassword.',
    example: false,
  })
  passwordChangeRequired!: boolean;

  @ApiPropertyOptional({
    description: 'API key for this sign-in; send it as X-API-Key. Present when passwordChangeRequired is false.',
    example: 'owa_k1_abc123...',
  })
  apiKey?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', description: 'When the sign-in key expires.' })
  expiresAt?: Date;

  @ApiPropertyOptional({ enum: ApiKeyRole, description: "The key's role (the user's role)." })
  role?: ApiKeyRole;

  @ApiPropertyOptional({ description: 'Engine the process resolved at boot.', example: 'baileys' })
  engineType?: string;

  @ApiPropertyOptional({ description: 'Always false: sign-in keys are never session-scoped.', example: false })
  scoped?: boolean;

  @ApiPropertyOptional({ type: UserResponseDto, description: 'The signed-in user.' })
  user?: UserResponseDto;
}
